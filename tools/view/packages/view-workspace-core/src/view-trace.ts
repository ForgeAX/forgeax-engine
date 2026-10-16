import type { ViewWorkspaceClient, WorkspaceCallOptions } from './client.ts';
import type { WorkspaceState } from './contract.ts';
import { workspaceDiagnosticRecord } from './command-error.ts';
type TraceData = Record<string, unknown>;
type TraceEvent = TraceData & { t: number; phase: string; event: string };
type Latencies = Map<string, number[]>;
type CaptureSession = {
  id: string; startedAtPerf: number; startedAtT: number; meta: TraceData;
  counters: Map<string, number>; rpcLatencies: Latencies; events: TraceEvent[];
  renderDurations: number[]; layoutDurations: number[]; mutationRecords: number;
  childListMutations: number; syncTargetSurfaces: number; targetSurfaceRemovals: number;
  targetSurfaceReorders: number; maxInFlight: number; maxRpcMs: number; maxRpcQueue: number; pendingRpc?: number;
};
type LatencyStats = NonNullable<ReturnType<typeof summarizeLatencies>>;
type SessionHintSource = { durationMs: number; counters: Record<string, number>; render: LatencyStats | null };
type CaptureRecord = SessionHintSource & {
  id: string; reason: string; startedAtT: number; endedAtT: number; meta: TraceData;
  rpc: Record<string, LatencyStats | null>; events: TraceEvent[]; hints: string[];
  dom: { mutationRecords: number; childListNodeChanges: number; layoutSamples: number; syncTargetSurfaces: number; targetSurfaceRemovals: number; targetSurfaceReorders: number };
  input: { maxUpdatesInFlight: number; maxRpcMs: number };
  subscription: { statePush: number; stateUpdate: number };
};
type TraceApi = {
  enabled(): boolean; enable: typeof enableViewTrace; dump: typeof dumpViewTraceText;
  download: typeof downloadViewTraceTxtFile; report: typeof getViewTraceReport; event: typeof traceView;
  describeElement: typeof describeElement; activeCapture(): string | null;
  lastCaptureSession(): CaptureRecord | null; captureSessions(): CaptureRecord[];
};
declare global { var __forgeaxViewTrace: TraceApi | undefined; }
/**
 * View viewport / camera interaction trace.
 *
 * Enable: localStorage.setItem('forgeax.view.trace', '1'); location.reload();
 * Export: copy(__forgeaxViewTrace.dump())
 *
 * Capture phase (canvas click → ESC / pointer up): see report.captureSessions[]
 */

const TRACE_KEY = 'forgeax.view.trace';
const TRACE_URL_PARAM = 'forgeaxViewTrace';
const LOG_PREFIX = '[forgeax.view.trace]';
const MAX_EVENTS = 6000;
const LATENCY_SAMPLE_CAP = 1024;
const MAX_SESSION_EVENTS = 20000;

let enabled = false;
let owned = false;
let installedApi: TraceApi | undefined;
let longTaskObserver: PerformanceObserver | undefined;
let sessionId = '';
let bootAt = 0;
const events: TraceEvent[] = [];
const counters = new Map<string, number>();
const rpcLatencies: Latencies = new Map();
let rafId = 0;
let lastRaf = 0;
let longFrameCount = 0;
let maxFrameGap = 0;
let sessionLongFrameCount = 0;

let activeCaptureSession: CaptureSession | null = null;
const captureSessions: CaptureRecord[] = [];
let domRoot: HTMLElement | null = null;
let domMutationObserver: MutationObserver | null = null;
let layoutObserver: PerformanceObserver | null = null;
let paintObserver: PerformanceObserver | null = null;

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function relT() {
  return Math.round((now() - bootAt) * 100) / 100;
}

function readEnabledFromEnvironment() {
  try {
    if (typeof globalThis.location?.search === 'string') {
      const params = new URLSearchParams(globalThis.location.search);
      if (params.get(TRACE_URL_PARAM) === '1' || params.get(TRACE_URL_PARAM) === 'true') return true;
    }
  } catch {
    // ignore
  }
  try {
    const stored = globalThis.localStorage?.getItem(TRACE_KEY);
    if (stored === '1' || stored === 'true') return true;
  } catch {
    // ignore
  }
  return false;
}

function bump(name: string, delta = 1) {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

function sessionBump(name: string, delta = 1) {
  if (!activeCaptureSession) return;
  const map = activeCaptureSession.counters;
  map.set(name, (map.get(name) ?? 0) + delta);
}

function recordRpcLatency(operation: string, ms: number, targetMap = rpcLatencies) {
  let bucket = targetMap.get(operation);
  if (!bucket) {
    bucket = [];
    targetMap.set(operation, bucket);
  }
  if (bucket.length >= LATENCY_SAMPLE_CAP) bucket.shift();
  bucket.push(ms);
}

function percentile(sorted: readonly number[], p: number) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[index];
}

function summarizeLatencies(samples: readonly number[]) {
  if (!samples?.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    n: sorted.length,
    avg: Math.round((sum / sorted.length) * 100) / 100,
    p50: Math.round(percentile(sorted, 50) * 100) / 100,
    p95: Math.round(percentile(sorted, 95) * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    sum: Math.round(sum * 100) / 100,
  };
}

function summarizeRenderDurations(samples: readonly number[]) {
  const stats = summarizeLatencies(samples);
  if (!stats) return null;
  return stats;
}

function pushEvent(entry: TraceEvent, { sessionOnly = false } = {}) {
  if (!enabled) return;
  if (activeCaptureSession) {
    activeCaptureSession.events.push(entry);
    if (activeCaptureSession.events.length > MAX_SESSION_EVENTS) {
      activeCaptureSession.events.splice(0, activeCaptureSession.events.length - MAX_SESSION_EVENTS);
      sessionBump('session.events-truncated');
    }
  }
  if (!sessionOnly) {
    events.push(entry);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  }
}

export function isViewTraceEnabled() {
  return enabled;
}

export function isCaptureSessionActive() {
  return activeCaptureSession !== null;
}

export function traceView(phase: string, event: string, data: TraceData = {}) {
  if (!enabled) return;
  const entry = { t: relT(), phase, event, ...data };
  bump(`${phase}.${event}`);
  sessionBump(`${phase}.${event}`);
  pushEvent(entry);
  const verbose = activeCaptureSession || phase === 'session' || phase === 'boot';
  if (verbose && typeof console !== 'undefined' && typeof console.debug === 'function') {
    console.debug(LOG_PREFIX, phase, event, data);
  }
}

export function traceViewRpc(operation: string, durationMs: number, extra: TraceData = {}) {
  if (!enabled) return;
  recordRpcLatency(operation, durationMs, rpcLatencies);
  if (activeCaptureSession) {
    recordRpcLatency(operation, durationMs, activeCaptureSession.rpcLatencies);
    if (durationMs > (activeCaptureSession.maxRpcMs ?? 0)) activeCaptureSession.maxRpcMs = durationMs;
    if (extra.inputType === 'pointer-move') {
      sessionBump('input.rpc-pointer-move');
      const q = activeCaptureSession.pendingRpc ?? 0;
      if (q > (activeCaptureSession.maxRpcQueue ?? 0)) activeCaptureSession.maxRpcQueue = q;
    }
  }
  bump(`rpc.${operation}`);
  sessionBump(`rpc.${operation}`);
  if (durationMs > 32) {
    bump(`rpc.slow.${operation}`);
    sessionBump(`rpc.slow.${operation}`);
  }
  pushEvent({
    t: relT(),
    phase: 'rpc',
    event: operation,
    ms: Math.round(durationMs * 100) / 100,
    ...extra,
  });
}

function describeElement(value: unknown) {
  const element = workspaceDiagnosticRecord(value);
  if (!element || typeof element !== 'object') return null;
  const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : String(value);
  const dataset = element.dataset && typeof element.dataset === 'object' ? { ...workspaceDiagnosticRecord(element.dataset) } : {};
  return {
    tag,
    id: element.id ?? undefined,
    className: typeof element.className === 'string' ? element.className : undefined,
    dataset,
    tabIndex: element.tabIndex,
    pointerLock: typeof element.requestPointerLock === 'function',
  };
}

function attachDomObservers() {
  if (!activeCaptureSession || !domRoot || domMutationObserver) return;
  if (typeof globalThis.MutationObserver === 'function') {
    domMutationObserver = new MutationObserver((records) => {
      if (!activeCaptureSession) return;
      for (const record of records) {
        sessionBump('dom.mutation');
        activeCaptureSession.mutationRecords += 1;
        if (record.type === 'childList') {
          sessionBump('dom.childList');
          activeCaptureSession.childListMutations += record.addedNodes.length + record.removedNodes.length;
        }
        if (record.type === 'attributes') sessionBump('dom.attributes');
      }
      if (activeCaptureSession.mutationRecords % 50 === 0) {
        pushEvent({
          t: relT(),
          phase: 'dom',
          event: 'mutation-burst',
          records: activeCaptureSession.mutationRecords,
          childListNodes: activeCaptureSession.childListMutations,
        });
      }
    });
    domMutationObserver.observe(domRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'data-forgeax-view-selected'],
    });
  }
  if (typeof globalThis.PerformanceObserver === 'function') {
    try {
      layoutObserver = new PerformanceObserver((list) => {
        if (!activeCaptureSession) return;
        for (const entry of list.getEntries()) {
          sessionBump('dom.layout');
          const ms = entry.duration;
          activeCaptureSession.layoutDurations.push(ms);
          if (ms > 8) {
            sessionBump('dom.layout-slow');
            pushEvent({
              t: relT(),
              phase: 'dom',
              event: 'layout',
              durationMs: Math.round(ms * 100) / 100,
              name: entry.name,
            });
          }
        }
      });
      layoutObserver.observe({ type: 'layout', buffered: true });
    } catch {
      // layout entry type unsupported
    }
    try {
      paintObserver = new PerformanceObserver((list) => {
        if (!activeCaptureSession) return;
        for (const entry of list.getEntries()) {
          sessionBump('dom.paint');
          if (entry.duration > 8) {
            sessionBump('dom.paint-slow');
            pushEvent({
              t: relT(),
              phase: 'dom',
              event: 'paint',
              durationMs: Math.round(entry.duration * 100) / 100,
            });
          }
        }
      });
      paintObserver.observe({ type: 'paint', buffered: true });
    } catch {
      // paint entry type unsupported
    }
  }
}

function detachDomObservers() {
  domMutationObserver?.disconnect();
  domMutationObserver = null;
  layoutObserver?.disconnect();
  layoutObserver = null;
  paintObserver?.disconnect();
  paintObserver = null;
}

function buildSessionHints(summary: SessionHintSource) {
  const hints: string[] = [];
  const durationSec = (summary.durationMs ?? 0) / 1000;
  if (durationSec <= 0) return hints;
  const move = summary.counters['input.pointer-move'] ?? 0;
  const render = summary.counters['shell.render'] ?? 0;
  const push = summary.counters['shell.state-push'] ?? 0;
  const cameraRpc = summary.counters['rpc.camera.update'] ?? 0;
  const mutations = summary.counters['dom.mutation'] ?? 0;

  if (render > 0 && move > 0 && Math.abs(render - push) < render * 0.2 && render / move > 0.5) {
    hints.push('Almost every workspace update triggers shell.render; subscription updates may cause excessive DOM work.');
  }
  if (cameraRpc > 0 && Math.abs(cameraRpc - move) < cameraRpc * 0.15) {
    hints.push('Pointer moves and camera updates are nearly one-to-one; consider coalescing input samples before submission.');
  }
  if (mutations > render * 30 && render > 10) {
    hints.push('Many DOM mutations occur per render; check whole-tree replacement and repeated mounting.');
  }
  const renderStats = summary.render;
  if ((renderStats?.p95 ?? 0) > 8 && render > 20) {
    hints.push('Rendering is slow during capture, including child replacement and target surface synchronization.');
  }
  const layoutSlow = summary.counters['dom.layout-slow'] ?? 0;
  if (layoutSlow > 5) {
    hints.push('The browser reports repeated slow layouts during capture; check forced layout and large DOM changes.');
  }
  return hints;
}

function finalizeCaptureSession(reason: string, extra: TraceData = {}): CaptureRecord | null {
  if (!activeCaptureSession) return null;
  const session = activeCaptureSession;
  activeCaptureSession = null;
  detachDomObservers();

  const durationMs = Math.round((now() - session.startedAtPerf) * 100) / 100;
  const counterObj = Object.fromEntries([...session.counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const rpc: Record<string, LatencyStats | null> = {};
  for (const [operation, samples] of session.rpcLatencies.entries()) {
    rpc[operation] = summarizeLatencies(samples);
  }
  const summary = {
    id: session.id,
    reason,
    durationMs,
    startedAtT: session.startedAtT,
    endedAtT: relT(),
    meta: { ...session.meta, ...extra },
    counters: counterObj,
    rpc,
    render: summarizeRenderDurations(session.renderDurations),
    dom: {
      mutationRecords: session.mutationRecords,
      childListNodeChanges: session.childListMutations,
      layoutSamples: session.layoutDurations.length,
      syncTargetSurfaces: session.syncTargetSurfaces,
      targetSurfaceRemovals: session.targetSurfaceRemovals,
      targetSurfaceReorders: session.targetSurfaceReorders,
    },
    input: {
      maxUpdatesInFlight: session.maxInFlight,
      maxRpcMs: Math.round((session.maxRpcMs ?? 0) * 100) / 100,
    },
    subscription: {
      statePush: counterObj['shell.state-push'] ?? 0,
      stateUpdate: counterObj['shell.state-update'] ?? 0,
    },
    hints: [] as string[],
  };
  summary.hints = buildSessionHints(summary);

  const record = {
    ...summary,
    events: session.events,
  };
  captureSessions.push(record);

  traceView('session', 'capture-end', {
    id: session.id,
    reason,
    durationMs,
    counters: counterObj,
    rpc,
    render: summary.render,
    dom: summary.dom,
    subscription: summary.subscription,
    hints: summary.hints,
  });

  if (typeof console !== 'undefined' && typeof console.info === 'function') {
    console.info(`${LOG_PREFIX} capture session ended (${reason})`, summary);
  }
  return record;
}

export function beginCaptureSession(meta: TraceData = {}) {
  if (!enabled) return;
  if (activeCaptureSession) finalizeCaptureSession('superseded');
  const id = `cap-${Math.random().toString(36).slice(2, 10)}`;
  activeCaptureSession = {
    id,
    startedAtPerf: now(),
    startedAtT: relT(),
    meta,
    counters: new Map(),
    rpcLatencies: new Map(),
    events: [],
    renderDurations: [],
    layoutDurations: [],
    mutationRecords: 0,
    childListMutations: 0,
    syncTargetSurfaces: 0,
    targetSurfaceRemovals: 0,
    targetSurfaceReorders: 0,
    maxInFlight: 0,
    maxRpcMs: 0,
    maxRpcQueue: 0,
  };
  sessionLongFrameCount = 0;
  attachDomObservers();
  traceView('session', 'capture-begin', { id, ...meta });
}

export function endCaptureSession(reason: string, extra: TraceData = {}) {
  if (!enabled || !activeCaptureSession) return null;
  return finalizeCaptureSession(reason, extra);
}

export function traceShellRegisterDomRoot(rootElement: HTMLElement | null | undefined) {
  if (!enabled || !rootElement) return;
  domRoot = rootElement;
  traceView('shell', 'dom-root', { element: describeElement(rootElement) });
}

export function traceShellStatePush(state: WorkspaceState) {
  if (!enabled) return;
  bump('shell.state-push');
  sessionBump('shell.state-push');
  const payload = {
    selectedTabId: state?.selectedTabId,
    cameraVersion: state?.preview?.cameraVersion,
    hasInteraction: Boolean(state?.preview?.interaction),
  };
  pushEvent({ t: relT(), phase: 'shell', event: 'state-push', ...payload });
}

export function wrapViewWorkspaceClient<T extends ViewWorkspaceClient | undefined>(client: T): T {
  if (!client) return client;
  const tracedClient = client as ViewWorkspaceClient & { __forgeaxViewTraceWrapped?: boolean };
  if (tracedClient.__forgeaxViewTraceWrapped) return client;
  const originalCall = client.call?.bind(client);
  if (typeof originalCall !== 'function') return client;
  tracedClient.__forgeaxViewTraceWrapped = true;
  client.call = <R = unknown>(operation: string, args: Record<string, unknown> = {}, options: WorkspaceCallOptions = {}): Promise<R> => {
    if (!enabled) return originalCall<R>(operation, args, options);
    if (activeCaptureSession && operation === 'camera.update') {
      activeCaptureSession.pendingRpc = (activeCaptureSession.pendingRpc ?? 0) + 1;
    }
    const started = now();
    const result = originalCall<R>(operation, args, options);
    return Promise.resolve(result)
      .then((value) => {
        if (activeCaptureSession && operation === 'camera.update') {
          activeCaptureSession.pendingRpc = Math.max(0, (activeCaptureSession.pendingRpc ?? 1) - 1);
        }
        traceViewRpc(operation, now() - started, {
          ok: true,
          interactionId: args?.interactionId,
          inputType: workspaceDiagnosticRecord(args.input).type,
        });
        return value;
      })
      .catch((error) => {
        if (activeCaptureSession && operation === 'camera.update') {
          activeCaptureSession.pendingRpc = Math.max(0, (activeCaptureSession.pendingRpc ?? 1) - 1);
        }
        traceViewRpc(operation, now() - started, {
          ok: false,
          message: error?.message ?? String(error),
          interactionId: args?.interactionId,
          inputType: workspaceDiagnosticRecord(args.input).type,
        });
        throw error;
      });
  };
  if (typeof client.subscribe === 'function') {
    const originalSubscribe = client.subscribe.bind(client);
    client.subscribe = (listener) =>
      originalSubscribe((state) => {
        traceShellStatePush(state);
        return listener(state);
      });
  }
  return client;
}

function startRafMonitor() {
  if (rafId || typeof globalThis.requestAnimationFrame !== 'function') return;
  lastRaf = now();
  const tick = () => {
    if (!enabled) {
      rafId = 0;
      return;
    }
    const t = now();
    const gap = t - lastRaf;
    lastRaf = t;
    if (gap > maxFrameGap) maxFrameGap = gap;
    if (gap > 32) {
      longFrameCount += 1;
      if (activeCaptureSession) {
        sessionLongFrameCount += 1;
        sessionBump('perf.long-frame');
        pushEvent({
          t: relT(),
          phase: 'perf',
          event: 'long-frame',
          gapMs: Math.round(gap * 100) / 100,
          capture: true,
        });
      } else if (gap > 50) {
        pushEvent({ t: relT(), phase: 'perf', event: 'long-frame', gapMs: Math.round(gap * 100) / 100 });
      }
    }
    rafId = globalThis.requestAnimationFrame(tick);
  };
  rafId = globalThis.requestAnimationFrame(tick);
}

function startLongTaskObserver() {
  if (typeof globalThis.PerformanceObserver !== 'function') return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 50) continue;
        bump('perf.long-task');
        sessionBump('perf.long-task');
        pushEvent({
          t: relT(),
          phase: 'perf',
          event: 'long-task',
          name: entry.name,
          durationMs: Math.round(entry.duration * 100) / 100,
          capture: Boolean(activeCaptureSession),
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
    longTaskObserver = observer;
  } catch {
    // unsupported
  }
}

function buildSummary(elapsedSec: number) {
  const counterObj = Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const rpc: Record<string, LatencyStats | null> = {};
  for (const [operation, samples] of rpcLatencies.entries()) {
    rpc[operation] = summarizeLatencies(samples);
  }
  const hints = [];
  const last = captureSessions[captureSessions.length - 1];
  if (last?.hints?.length) {
    hints.push(`Last capture (${last.reason}, ${last.durationMs} ms): ${last.hints.join(' ')}`);
  }
  return {
    sessionId,
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    counters: counterObj,
    rpc,
    perf: {
      longFramesOver32ms: longFrameCount,
      maxFrameGapMs: Math.round(maxFrameGap * 100) / 100,
    },
    captureSessionCount: captureSessions.length,
    hints,
  };
}

export function getViewTraceReport() {
  const elapsedSec = bootAt ? (now() - bootAt) / 1000 : 0;
  return {
    kind: 'forgeax.view.trace/report',
    version: 2,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(elapsedSec),
    captureSessions: captureSessions.map(({ events: _e, ...rest }) => rest),
    captureSessionsFull: captureSessions,
    events,
  };
}

export function dumpViewTraceText() {
  return JSON.stringify(getViewTraceReport(), null, 2);
}

export function installViewTraceGlobal() {
  if (!owned || !enabled) return false;
  if (installedApi) return true;
  sessionId = `vt-${Math.random().toString(36).slice(2, 10)}`;
  bootAt = now();
  traceView('boot', 'enabled', {
    page: globalThis.location ? `${globalThis.location.origin}${globalThis.location.pathname}` : undefined,
    userAgent: globalThis.navigator?.userAgent,
  });
  startRafMonitor();
  startLongTaskObserver();
  const api = {
    enabled: () => enabled,
    enable: enableViewTrace,
    dump: dumpViewTraceText,
    download: downloadViewTraceTxtFile,
    report: getViewTraceReport,
    event: traceView,
    describeElement,
    activeCapture: () => activeCaptureSession?.id ?? null,
    lastCaptureSession: () => captureSessions[captureSessions.length - 1] ?? null,
    captureSessions: () => captureSessions,
  };
  globalThis.__forgeaxViewTrace = api;
  installedApi = api;
  if (typeof console !== 'undefined' && typeof console.info === 'function') {
    console.info(
      `${LOG_PREFIX} active — click canvas, drag, press ESC, then: copy(__forgeaxViewTrace.dump())`,
    );
  }
  return true;
}

export function initViewTraceFromEnvironment() {
  if (typeof globalThis.document !== 'object') return () => {};
  if (owned) throw new Error('The workspace plugin already owns View tracing in this document');
  owned = true;
  enabled = readEnabledFromEnvironment();
  installViewTraceGlobal();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    owned = false;
    enabled = false;
    if (rafId) globalThis.cancelAnimationFrame?.(rafId);
    rafId = 0;
    longTaskObserver?.disconnect();
    longTaskObserver = undefined;
    detachDomObservers();
    domRoot = null;
    activeCaptureSession = null;
    events.length = 0;
    captureSessions.length = 0;
    counters.clear();
    rpcLatencies.clear();
    lastRaf = longFrameCount = maxFrameGap = sessionLongFrameCount = bootAt = 0;
    sessionId = '';
    if (globalThis.__forgeaxViewTrace === installedApi) delete globalThis.__forgeaxViewTrace;
    installedApi = undefined;
  };
}

/** Turn on in-process tracing without reload (used by the View header export control). */
export function enableViewTrace({ persist = false } = {}) {
  if (!owned) return false;
  if (persist) {
    try {
      globalThis.localStorage?.setItem(TRACE_KEY, '1');
    } catch {
      // ignore
    }
  }
  if (enabled && globalThis.__forgeaxViewTrace) return true;
  enabled = true;
  return installViewTraceGlobal();
}

function traceExportFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `forgeax-view-trace-${stamp}.txt`;
}

/** Returns the report text and downloads it as a plain-text file when `document` exists. */
export function downloadViewTraceTxtFile() {
  enableViewTrace();
  const text = dumpViewTraceText();
  traceView('export', 'download', {
    bytes: text.length,
    captureSessions: captureSessions.length,
  });
  const doc = globalThis.document;
  if (doc?.createElement) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = traceExportFilename();
    anchor.rel = 'noopener';
    anchor.click();
    URL.revokeObjectURL(url);
  }
  return text;
}

export function traceInputAttach(element: HTMLElement | null | undefined, { targetId, tabId }: { targetId?: string; tabId?: string } = {}) {
  if (!enabled) return;
  traceView('input', 'attach', {
    targetId,
    tabId,
    element: describeElement(element),
    pointerLockElement: describeElement(globalThis.document?.pointerLockElement),
  });
  const canvas = (
    element?.tagName?.toLowerCase?.() === 'canvas'
      ? element
      : element?.querySelector?.('canvas')) as (HTMLCanvasElement & { __forgeaxViewTraceCanvas?: boolean }) | null | undefined;
  if (!canvas || canvas.__forgeaxViewTraceCanvas) return;
  canvas.__forgeaxViewTraceCanvas = true;
  traceView('canvas', 'found', {
    width: canvas.width,
    height: canvas.height,
    clientWidth: canvas.clientWidth,
    clientHeight: canvas.clientHeight,
  });
  if (typeof globalThis.ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => {
      const payload = {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        capture: Boolean(activeCaptureSession),
      };
      bump('canvas.resize');
      sessionBump('canvas.resize');
      pushEvent({ t: relT(), phase: 'canvas', event: 'resize', ...payload });
    });
    observer.observe(canvas);
  }
}

export function traceInputPointerDown(event: PointerEvent, { accepted, element }: { accepted: boolean; element?: HTMLElement }) {
  if (!enabled) return;
  traceView('input', 'pointerdown', {
    accepted,
    button: event?.button,
    pointerId: event?.pointerId,
    pointerType: event?.pointerType,
    buttons: event?.buttons,
    target: describeElement(event?.target),
    inputSurface: describeElement(element),
    pointerLockBefore: describeElement(globalThis.document?.pointerLockElement),
  });
  if (accepted) {
    beginCaptureSession({
      trigger: 'pointerdown',
      target: describeElement(event?.target),
      inputSurface: describeElement(element),
    });
  }
}

export function traceInputPointerUp(event: PointerEvent, { element }: { element?: HTMLElement } = {}) {
  if (!enabled) return;
  traceView('input', 'pointerup', {
    pointerId: event?.pointerId,
    inputSurface: describeElement(element),
  });
  endCaptureSession('pointerup');
}

export function traceInputPointerLockExit({ locked, element }: { locked: boolean; element?: HTMLElement }) {
  if (!enabled) return;
  traceView('input', 'pointerlock-exit', {
    locked,
    element: describeElement(element),
  });
  if (!locked) endCaptureSession('pointerlock-exit');
}

export function traceInputCaptureAbort(reason: string) {
  if (!enabled) return;
  traceView('input', 'abort', { reason });
  if (activeCaptureSession) endCaptureSession('abort', { abortReason: reason });
}

export function traceInputEscape() {
  if (!enabled) return;
  traceView('input', 'escape-key');
  endCaptureSession('escape-key');
}

export function traceInputPointerMove(event: PointerEvent, { queueDepth, inFlight }: { queueDepth?: number; inFlight: number; queued?: boolean }) {
  if (!enabled) return;
  bump('input.pointer-move');
  sessionBump('input.pointer-move');
  if (inFlight > (activeCaptureSession?.maxInFlight ?? 0)) {
    if (activeCaptureSession) activeCaptureSession.maxInFlight = inFlight;
  }
  const payload = {
    movementX: event?.movementX,
    movementY: event?.movementY,
    queueDepth,
    inFlight,
  };
  if (activeCaptureSession) {
    pushEvent({ t: relT(), phase: 'input', event: 'pointer-move', ...payload });
  } else if ((counters.get('input.pointer-move') ?? 0) % 30 === 1) {
    pushEvent({ t: relT(), phase: 'input', event: 'pointer-move-sample', ...payload });
  }
}

export function traceInputEnqueueUpdate(input: { type?: string } | undefined, { queueDepth, inFlight }: { queueDepth: number; inFlight: number }) {
  if (!enabled) return;
  sessionBump('input.enqueue-update');
  bump('input.enqueue-update');
  if (activeCaptureSession) {
    pushEvent({
      t: relT(),
      phase: 'input',
      event: 'enqueue-update',
      type: input?.type,
      queueDepth,
      inFlight,
    });
  }
}

export function traceShellRender(meta: TraceData = {}) {
  if (!enabled) return;
  bump('shell.render');
  sessionBump('shell.render');
  if (activeCaptureSession && typeof meta.durationMs === 'number') {
    activeCaptureSession.renderDurations.push(meta.durationMs);
  }
  if (activeCaptureSession) {
    pushEvent({ t: relT(), phase: 'shell', event: 'render', ...meta });
  } else if ((counters.get('shell.render') ?? 0) % 25 === 1) {
    pushEvent({ t: relT(), phase: 'shell', event: 'render-sample', ...meta });
  }
}

export function traceShellUpdate(meta: TraceData = {}) {
  if (!enabled) return;
  bump('shell.state-update');
  sessionBump('shell.state-update');
  if (activeCaptureSession) {
    pushEvent({ t: relT(), phase: 'shell', event: 'state-update', ...meta });
  }
}

export function tracePresentationAttach(tabId: string, targetId: string, surface: unknown) {
  if (!enabled) return;
  sessionBump('shell.presentation-attach');
  bump('shell.presentation-attach');
  traceView('shell', 'presentation-attach', {
    tabId,
    targetId,
    surface: describeElement(surface),
  });
}

export function traceSyncTargetSurfaces(stats: { removed?: number; reordered?: number; desired?: number } = {}) {
  if (!enabled) return;
  bump('shell.sync-target-surfaces');
  sessionBump('shell.sync-target-surfaces');
  if (activeCaptureSession) {
    activeCaptureSession.syncTargetSurfaces += 1;
    activeCaptureSession.targetSurfaceRemovals += stats.removed ?? 0;
    activeCaptureSession.targetSurfaceReorders += stats.reordered ?? 0;
  }
  if (activeCaptureSession) {
    pushEvent({ t: relT(), phase: 'shell', event: 'sync-target-surfaces', ...stats });
  }
}
