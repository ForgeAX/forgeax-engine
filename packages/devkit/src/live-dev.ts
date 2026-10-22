import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import {
  type ExecutionReport,
  type ExecutionSelection,
  type ExecutionWorkersOptions,
  isExecutionReport,
} from '@forgeax/engine-app';
import type { JSHandle } from 'playwright';
import { WebSocket, WebSocketServer } from 'ws';
import { animationPlayback, environmentAnimationPlayback } from './animation-playback.js';
import type { BrowserCapture, BrowserCaptureSession } from './browser-capture.js';
import { environmentExecutionWorkers } from './execution-workers.js';
import { readLiveProjectInputs } from './live-project-inputs.js';
import { createRunSnapshot, runStateDirectory } from './run-snapshot.js';
import { DEV_EXECUTION_TIMEOUT_MS, DEV_PREPARATION_TIMEOUT_MS } from './startup-budget.js';
import type {
  BrowserCarrierAdapter,
  BrowserCarrierRunIdentity,
  BrowserCarrierTarget,
  BrowserExecutionTarget,
} from './tools/display-carrier.js';

// Both published entrypoints live beside the same DevKit CLI artifact.
const CLI_ENTRY = fileURLToPath(new URL('./cli.mjs', import.meta.url));

export interface LiveDevStatus {
  readonly schemaVersion: '1.0.0';
  readonly inputVersion?: string;
  readonly runId?: string;
  readonly root: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly generation: number;
  readonly revision: string;
  readonly loadId: string;
  readonly phase: 'starting' | 'ready' | 'waiting' | 'reloading' | 'failed' | 'stopped';
  readonly url: string | undefined;
  readonly unfinishedEval: boolean;
  readonly frameId: number | undefined;
  readonly worldIdentity: string | undefined;
  readonly workers: ExecutionSelection | undefined;
  readonly execution?: ExecutionReport | undefined;
  readonly backendRequested: LiveDevBackend;
  readonly backend: 'hardware' | 'software' | 'unknown';
  readonly fallbackReason: string | undefined;
  readonly carrier: 'private-browser' | 'borrowed';
  readonly carrierTarget: BrowserCarrierTarget | undefined;
  readonly carrierFallbackReason: string | undefined;
  readonly headless: boolean;
  readonly bridgeConnected: boolean;
  readonly error: string | undefined;
}

export type LiveDevBackend = 'auto' | 'hardware' | 'software';

/**
 * Optional process-local carrier injection for an embedding Engine owner.
 * Detached CLI calls cannot serialize a browser adapter. An embedding owner
 * uses startLiveDev({ inProcess }) to retain the actual Page in its process.
 */
export interface LiveDevDaemonOptions {
  /** Pin inputs and use detached Engine-owned resources, independent of presentation. */
  readonly snapshot?: boolean;
  readonly signal?: AbortSignal;
  readonly onReady?: (status: LiveDevStatus) => void;
  readonly headless?: boolean;
  readonly backend?: LiveDevBackend;
  readonly workers?: ExecutionWorkersOptions;
  readonly animation?: AnimationPlaybackOptions;
  readonly rhiCapture?: boolean;
  readonly carrier?: BrowserCarrierAdapter;
  readonly carrierRun?: BrowserCarrierRunIdentity;
}

interface LiveDevSessionFile {
  readonly controlToken?: string;
  readonly root: string;
  readonly sessionPath: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly revision: string;
  readonly loadId: string;
}

type LiveOperation =
  | 'status'
  | 'observe'
  | 'reload'
  | 'stop'
  | 'capture'
  | 'verify'
  | 'rhi/capture'
  | 'profile/capture'
  | 'eval'
  | 'camera/get'
  | 'camera/set'
  | 'camera/release'
  | 'find'
  | 'focus';

interface LiveDevDaemonState {
  stopPromise?: Promise<void>;
  ownerClaimed: boolean;
  readonly snapshot: boolean;
  readonly controlToken: string | undefined;
  executionRoot: string;
  inputSnapshot: Awaited<ReturnType<typeof createRunSnapshot>> | undefined;
  observation:
    | { capturedAt: string; revision: string; frameId: number | undefined; png: string }
    | undefined;
  observationTimer: ReturnType<typeof setTimeout> | undefined;
  observationInFlight: Promise<void> | undefined;
  readonly logs: Array<{ sequence: number; level: string; text: string }>;
  logSequence: number;
  captureRunning: boolean;
  readonly root: string;
  readonly sessionPath: string;
  browser: BrowserCapture | undefined;
  readonly carrier: BrowserCarrierAdapter | undefined;
  readonly carrierRun: BrowserCarrierRunIdentity | undefined;
  readonly requestedWorkers: ExecutionWorkersOptions | undefined;
  readonly animation: AnimationPlaybackOptions;
  /** Attach the existing RHI recorder to the live App when explicitly requested. */
  readonly rhiCapture: boolean;
  session: BrowserCaptureSession | undefined;
  projectUrl: string | undefined;
  status: LiveDevStatus;
  evalRunning: boolean;
  server: ReturnType<typeof createServer> | undefined;
  bridgeServer: WebSocketServer | undefined;
  bridge: WebSocket | undefined;
  bridgeNextId: number;
  bridgePending: Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
      readonly progress: { started: boolean };
      cancelResolve: ((admitted: boolean) => void) | undefined;
    }
  >;
  projectProcess: ChildProcess | undefined;
  inputs: string | undefined;
  projectInputPaths: readonly string[] | undefined;
  inputCheck: Promise<string> | undefined;
  inputTimer: ReturnType<typeof setTimeout> | undefined;
  reloadInFlight: Promise<void> | undefined;
  reloadRequested: boolean;
}

// A first live launch may have to build the shader and Pack closure before
// Vite can publish its endpoint. Keep the caller's polling window aligned with
// the bounded project-process build timeout below instead of failing exactly
// when a cold, valid project becomes ready.
const LIVE_DEV_POLL_INTERVAL_MS = 100;
const LIVE_DEV_REQUEST_TIMEOUT = 'live-request-timeout: the owner did not respond';

function ciCaptureViewport(): { readonly width?: number; readonly height?: number } {
  if (process.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT !== '1') return {};
  const readPositive = (name: string, fallback: number): number => {
    const value = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  };
  return {
    width: readPositive('FORGEAX_BROWSER_CI_VIEWPORT_WIDTH', 320),
    height: readPositive('FORGEAX_BROWSER_CI_VIEWPORT_HEIGHT', 180),
  };
}

function sessionPath(root: string, snapshot = false): string {
  if (snapshot) return resolve(runStateDirectory(root), 'session.json');
  return resolve(root, '.forgeax', 'dev-session.json');
}

function publicStatus(status: LiveDevStatus): unknown {
  const { loadId: _load, worldIdentity: _world, generation: _generation, ...value } = status;
  return value;
}

function observationValue(value: unknown, revision: string): Record<string, unknown> {
  const result = value as Record<string, unknown>;
  if (Array.isArray(result.matches))
    return {
      ...result,
      matches: result.matches.map(
        ({ entity, ...entry }: { entity: number; [key: string]: unknown }) => ({
          ...entry,
          ref: `${revision}/${entity}`,
        }),
      ),
    };
  const { entity: _entity, ...rest } = result;
  return rest;
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw) as unknown;
}

function commandError(code: string, hint: string, detail: Record<string, unknown> = {}) {
  return { code, expected: 'the live DevKit service to accept the request', hint, detail };
}

async function writeSessionFile(state: LiveDevDaemonState): Promise<void> {
  await mkdir(dirname(state.sessionPath), { recursive: true });
  await writeFile(
    state.sessionPath,
    `${JSON.stringify({
      root: state.root,
      sessionPath: state.sessionPath,
      ...(state.controlToken ? { controlToken: state.controlToken } : {}),
      endpoint: state.status.endpoint,
      pid: state.status.pid,
      revision: state.status.revision,
      loadId: state.status.loadId,
    } satisfies LiveDevSessionFile)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function waitForFirstFrame(
  session: BrowserCaptureSession,
  timeoutMs: number | null = DEV_EXECUTION_TIMEOUT_MS,
): Promise<boolean> {
  const realm: BrowserExecutionTarget['realm'] = session.execution?.realm ?? session.page;
  let observation: JSHandle<unknown>;
  try {
    observation = await realm.waitForFunction(
      () => {
        const fatal = document.querySelector('#forgeax-fatal');
        if (fatal?.checkVisibility())
          return (
            document.querySelector('#forgeax-fatal-details')?.textContent?.trim() ||
            fatal.textContent?.trim() ||
            'Engine startup failed'
          ).slice(0, 16_384);
        return document.documentElement.dataset.forgeaxFrameSubmitted !== undefined;
      },
      undefined,
      { timeout: timeoutMs ?? 0 },
    );
  } catch {
    return false;
  }
  try {
    const result: unknown = await observation.jsonValue();
    if (typeof result === 'string')
      throw Object.assign(new Error(`live-startup-failed: ${result}`), {
        code: 'live-startup-failed',
        detail: { reason: result },
      });
    return result === true;
  } finally {
    await observation.dispose();
  }
}

async function submittedFrameId(session: BrowserCaptureSession): Promise<number | undefined> {
  const realm: BrowserExecutionTarget['realm'] = session.execution?.realm ?? session.page;
  const value = await realm.evaluate(() => document.documentElement.dataset.forgeaxFrameSubmitted);
  if (value === undefined) return undefined;
  const frame = Number(value);
  return Number.isSafeInteger(frame) ? frame : undefined;
}

async function waitForFrameAfter(
  session: BrowserCaptureSession,
  previous: number | undefined,
): Promise<void> {
  const realm: BrowserExecutionTarget['realm'] = session.execution?.realm ?? session.page;
  await realm.waitForFunction(
    (before) => Number(document.documentElement.dataset.forgeaxFrameSubmitted) > (before ?? 0),
    previous,
    { timeout: 120_000 },
  );
}

async function waitForProfilerCompletion(
  state: LiveDevDaemonState,
  previousFrame: number | undefined,
  timeoutMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  let frameId = previousFrame;
  while (Date.now() < deadline) {
    if (state.session === undefined)
      throw bridgeError('live-not-ready', 'The live session closed.');
    await waitForFrameAfter(state.session, frameId);
    frameId = await submittedFrameId(state.session);
    const active = await bridgeEval(state, 'return profiler?.activeCaptureId() ?? null;', 5_000);
    if (active === null || active === undefined) return frameId;
  }
  throw bridgeError(
    'profile-capture-timeout',
    'The live profiler did not finish before the bounded frame window.',
  );
}

function rhiCaptureScript(runId: string): string {
  return `return (async () => {
    if (rhiCapture === undefined) return { ok: false, error: { code: 'capture-unavailable', hint: 'Start dev with RHI diagnostics enabled.' } };
    // Software WebGPU can need more than the recorder's 30 s default to
    // snapshot a full live resource set. Keep this a bounded diagnostic wait,
    // but align it with the route's 120 s bridge deadline rather than failing
    // a valid capture midway through readback.
    const captured = await rhiCapture.captureFrame({ snapshotTimeoutMs: 120_000 });
    if (!captured.ok) return { ok: false, error: captured.error };
    // Resumable chunked upload: renderer memory stays bounded to a few chunks.
    const uploaded = await rhiCapture.upload(captured.value, { runId: ${JSON.stringify(runId)} });
    if (!uploaded.ok) return { ok: false, error: uploaded.error };
    return { ok: true, value: { ...uploaded.value, source: 'live', runId: ${JSON.stringify(runId)} } };
  })();`;
}

function assertLiveIdentity(
  state: LiveDevDaemonState,
  args: Record<string, unknown>,
): ReturnType<typeof commandError> | undefined {
  if (args.revision !== undefined && args.revision !== state.status.revision) {
    return commandError(
      'live-revision-stale',
      'The runtime changed; inspect the current scene before repeating this operation.',
      { revision: state.status.revision },
    );
  }
  if (typeof args.ref === 'string') {
    const [revision, rawEntity, extra] = args.ref.split('/');
    const entity = Number(rawEntity);
    if (
      extra !== undefined ||
      rawEntity === undefined ||
      !Number.isSafeInteger(entity) ||
      entity < 0
    ) {
      return commandError('live-reference-invalid', 'Use an unmodified ref returned by dev find.');
    }
    if (revision !== state.status.revision)
      return commandError(
        'live-revision-stale',
        'This entity reference belongs to an older runtime; use dev find again.',
      );
    args.entity = entity;
  }
  return undefined;
}

function assertRuntimeHealth(status: LiveDevStatus): ReturnType<typeof commandError> | undefined {
  const execution = status.execution;
  if (!isExecutionReport(execution) || execution.world.identity !== status.worldIdentity) {
    return commandError(
      'live-verification-unavailable',
      'The current execution report is unavailable.',
      {
        revision: status.revision,
      },
    );
  }
  if (
    execution.fault !== null ||
    execution.engine.health !== 'running' ||
    execution.world.health !== 'healthy' ||
    execution.world.partialWrite ||
    (execution.render !== undefined && execution.render.state !== 'alive')
  ) {
    return commandError(
      'live-runtime-failed',
      'Repair the execution fault before verifying again.',
      {
        execution,
      },
    );
  }
  if (execution.frame.completed < 1) {
    return commandError(
      'live-verification-unavailable',
      'No completed Engine frame has been observed.',
    );
  }
  return undefined;
}

async function refreshFrameStatus(state: LiveDevDaemonState): Promise<void> {
  if (state.session === undefined) return;
  const frameId = await submittedFrameId(state.session);
  if (frameId !== undefined) state.status = { ...state.status, frameId };
}

function bridgeError(code: string, hint: string): Error & { readonly code: string } {
  const error = new Error(hint) as Error & { code: string };
  error.code = code;
  return error;
}

interface BridgeCall {
  readonly promise: Promise<unknown>;
  readonly started: () => boolean;
  cancel(): Promise<boolean>;
}

function bridgeRequest(
  state: LiveDevDaemonState,
  request:
    | { readonly type: 'eval'; readonly code: string; readonly worldIdentity?: string }
    | { readonly type: 'status' },
  timeoutMs: number | null = 10_000,
): BridgeCall {
  if (state.bridge?.readyState !== WebSocket.OPEN) {
    return {
      promise: Promise.reject(
        bridgeError(
          'live-app-bridge-unavailable',
          'The actual App execution bridge is not connected.',
        ),
      ),
      started: () => false,
      cancel: () => Promise.resolve(false),
    };
  }
  const id = state.bridgeNextId++;
  const progress = { started: false };
  const promise = new Promise((resolveResult, rejectResult) => {
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            state.bridgePending.delete(id);
            rejectResult(
              bridgeError(
                'live-app-bridge-timeout',
                'The actual App execution bridge did not answer before the deadline.',
              ),
            );
          }, timeoutMs);
    state.bridgePending.set(id, {
      resolve: resolveResult,
      reject: rejectResult,
      timer,
      progress,
      cancelResolve: undefined,
    });
    try {
      state.bridge?.send(
        JSON.stringify({
          id,
          ...request,
        }),
      );
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      state.bridgePending.delete(id);
      rejectResult(error);
    }
  }).then((payload) => {
    if (payload !== null && typeof payload === 'object' && Reflect.get(payload, 'ok') === false) {
      const error = Reflect.get(payload, 'error');
      const errorRecord =
        error !== null && typeof error === 'object'
          ? (error as { readonly code?: unknown; readonly hint?: unknown })
          : undefined;
      throw bridgeError(
        typeof errorRecord?.code === 'string' ? errorRecord.code : 'live-app-eval-failed',
        typeof errorRecord?.hint === 'string' ? errorRecord.hint : 'The App evaluation failed.',
      );
    }
    return payload !== null && typeof payload === 'object' && Reflect.get(payload, 'ok') === true
      ? Reflect.get(payload, 'value')
      : payload;
  });
  return {
    promise,
    started: () => progress.started,
    cancel: () => {
      const pending = state.bridgePending.get(id);
      if (pending === undefined) return Promise.resolve(true);
      const outcome = new Promise<boolean>((resolve) => {
        pending.cancelResolve = resolve;
      });
      try {
        state.bridge?.send(JSON.stringify({ type: 'cancel', id }));
      } catch {
        pending.cancelResolve?.(true);
        pending.cancelResolve = undefined;
      }
      return outcome;
    },
  };
}

function bridgeCall(
  state: LiveDevDaemonState,
  code: string,
  timeoutMs: number | null = 10_000,
  worldIdentity: string | null = state.status.worldIdentity ?? null,
): BridgeCall {
  return bridgeRequest(
    state,
    {
      type: 'eval',
      code,
      ...(worldIdentity === null ? {} : { worldIdentity }),
    },
    timeoutMs,
  );
}

function bridgeEval(
  state: LiveDevDaemonState,
  code: string,
  timeoutMs: number | null = 10_000,
): Promise<unknown> {
  return bridgeCall(state, code, timeoutMs).promise;
}

/** Revoke the synthetic input lease out-of-band from user eval. This message
 * is handled by both the main-realm and Worker bridges immediately, so a
 * disconnected HTTP caller cannot leave a held key waiting for another eval. */
function revokeLiveInput(state: LiveDevDaemonState): void {
  try {
    if (state.bridge?.readyState === WebSocket.OPEN)
      state.bridge.send(JSON.stringify({ type: 'input-clear' }));
  } catch {
    // Bridge teardown already revokes the page-side lease.
  }
}

function openLiveInput(state: LiveDevDaemonState): void {
  try {
    if (state.bridge?.readyState === WebSocket.OPEN)
      state.bridge.send(JSON.stringify({ type: 'input-lease-open' }));
  } catch {
    // A disconnected bridge cannot admit this evaluation anyway.
  }
}

function finishLiveProfiler(
  state: LiveDevDaemonState,
  expected?: { readonly worldIdentity?: string; readonly captureId?: string },
): void {
  try {
    if (state.bridge?.readyState === WebSocket.OPEN)
      state.bridge.send(JSON.stringify({ type: 'profile-finish', ...(expected ?? {}) }));
  } catch {
    // Diagnostic cleanup is best effort and never changes the App state.
  }
}

async function refreshBridgeStatus(state: LiveDevDaemonState): Promise<boolean> {
  if (state.bridge?.readyState !== WebSocket.OPEN) {
    state.status = { ...state.status, bridgeConnected: false };
    return false;
  }
  const bridge = state.bridge;
  const value = await bridgeRequest(state, { type: 'status' }).promise;
  if (state.bridge !== bridge || isStopped(state)) return false;
  const record = value as {
    readonly worldIdentity?: unknown;
    readonly execution?: unknown;
    readonly workers?: unknown;
  };
  if (typeof record.worldIdentity !== 'string')
    throw bridgeError(
      'live-world-identity-missing',
      'The App bridge did not publish a World identity.',
    );
  const worldReplaced =
    state.status.worldIdentity !== undefined && state.status.worldIdentity !== record.worldIdentity;
  state.status = {
    ...state.status,
    ...(worldReplaced
      ? {
          generation: state.status.generation + 1,
          revision: randomUUID(),
          loadId: randomUUID(),
          error: undefined,
        }
      : {}),
    phase: state.status.phase,
    worldIdentity: record.worldIdentity,
    workers: record.workers as ExecutionSelection | undefined,
    execution: record.execution as ExecutionReport | undefined,
    bridgeConnected: true,
  };
  if (
    state.status.phase === 'waiting' &&
    !state.reloadRequested &&
    state.reloadInFlight === undefined &&
    state.session !== undefined &&
    (await submittedFrameId(state.session)) !== undefined
  )
    state.status = { ...state.status, phase: 'ready', error: undefined };
  if (worldReplaced) await writeSessionFile(state);
  return true;
}

async function requireCurrentBridge(
  state: LiveDevDaemonState,
  response: ServerResponse,
): Promise<boolean> {
  try {
    if (!(await reconcileProjectInputs(state))) {
      jsonResponse(response, 409, {
        ok: false,
        error: commandError(
          'live-not-ready',
          state.status.error ?? 'Project inputs changed; wait for the new runtime.',
        ),
      });
      return false;
    }
    if (
      state.reloadInFlight !== undefined ||
      state.reloadRequested ||
      state.status.phase === 'reloading'
    ) {
      jsonResponse(response, 409, {
        ok: false,
        error: commandError('live-not-ready', 'Project inputs changed; wait for the new runtime.'),
      });
      return false;
    }
    if (state.status.phase === 'failed') {
      jsonResponse(response, 409, {
        ok: false,
        error: commandError('live-not-ready', state.status.error ?? 'Project startup failed.'),
      });
      return false;
    }
    if (await refreshBridgeStatus(state)) return true;
  } catch (error) {
    jsonResponse(response, 409, {
      ok: false,
      error: commandError(
        typeof (error as { readonly code?: unknown })?.code === 'string'
          ? ((error as { readonly code: string }).code ?? 'live-app-bridge-unavailable')
          : 'live-app-bridge-unavailable',
        error instanceof Error
          ? error.message
          : 'The actual App execution realm is not available for this request.',
      ),
    });
    return false;
  }
  jsonResponse(response, 409, {
    ok: false,
    error: commandError(
      'live-app-bridge-unavailable',
      'The actual App execution realm is not connected; wait for dev status to report ready.',
    ),
  });
  return false;
}

function rejectBridgePending(state: LiveDevDaemonState, error: unknown): void {
  for (const pending of state.bridgePending.values()) {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.cancelResolve?.(false);
    pending.reject(error);
  }
  state.bridgePending.clear();
}

function installBridgeRelay(state: LiveDevDaemonState): void {
  const server = state.server;
  if (server === undefined) return;
  const bridgeServer = new WebSocketServer({ noServer: true });
  state.bridgeServer = bridgeServer;
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/bridge') {
      socket.destroy();
      return;
    }
    bridgeServer.handleUpgrade(request, socket, head, (client) =>
      bridgeServer.emit('connection', client, request),
    );
  });
  bridgeServer.on('connection', (client: WebSocket) => {
    state.bridge?.close();
    state.bridge = client;
    state.status = { ...state.status, bridgeConnected: true };
    client.on('message', (raw) => {
      let message: {
        readonly type?: string;
        readonly id?: number;
        readonly payload?: unknown;
        readonly admitted?: boolean;
      };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      const id = message.id;
      if (id === undefined || !Number.isSafeInteger(id)) return;
      const pending = state.bridgePending.get(id);
      if (pending === undefined) return;
      if (message.type === 'started') {
        pending.progress.started = true;
        return;
      }
      if (message.type === 'canceled') {
        const admitted = message.admitted === true;
        pending.cancelResolve?.(admitted);
        pending.cancelResolve = undefined;
        if (!admitted) {
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          state.bridgePending.delete(id);
          pending.reject(
            bridgeError(
              'live-eval-cancelled-before-execution',
              'The evaluation was cancelled before it started.',
            ),
          );
        } else {
          pending.progress.started = true;
        }
        return;
      }
      if (message.type !== 'result') return;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      state.bridgePending.delete(id);
      pending.cancelResolve?.(true);
      pending.resolve(message.payload);
    });
    client.on('close', () => {
      if (state.bridge !== client) return;
      state.bridge = undefined;
      state.status = {
        ...state.status,
        bridgeConnected: false,
        phase: state.status.phase === 'ready' ? 'waiting' : state.status.phase,
      };
      rejectBridgePending(
        state,
        bridgeError(
          'live-app-bridge-disconnected',
          'The actual App execution bridge disconnected.',
        ),
      );
    });
    client.on('error', () => undefined);
  });
}

async function openSession(state: LiveDevDaemonState): Promise<void> {
  const stopped = () => state.status.phase === 'stopped';
  if (stopped()) return;
  const loadId = randomUUID();
  const revision = randomUUID();
  state.status = {
    ...state.status,
    revision,
    loadId,
    generation: state.status.generation + 1,
    phase: 'starting',
    unfinishedEval: false,
    bridgeConnected: false,
    worldIdentity: undefined,
    frameId: undefined,
    workers: undefined,
    execution: undefined,
    backend: 'unknown',
    fallbackReason: undefined,
    carrier: 'private-browser',
    carrierTarget: undefined,
    carrierFallbackReason: undefined,
    error: undefined,
  };
  await writeSessionFile(state);
  try {
    await replaceProjectProcess(state, state.status.generation);
    if (stopped()) return;
    const { createBrowserCapture } = await import('./browser-capture.js');
    if (stopped()) return;
    state.browser ??= createBrowserCapture(state.executionRoot);
    state.session = await state.browser.open({
      backend: state.status.backendRequested,
      headless: state.status.headless,
      launchProfile: 'development',
      ...ciCaptureViewport(),
      outputDir: resolve(
        process.env.XDG_DATA_HOME ??
          (process.platform === 'darwin'
            ? resolve(homedir(), 'Library/Application Support')
            : process.platform === 'win32'
              ? (process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData/Local'))
              : resolve(homedir(), '.local/share')),
        'ForgeaX/artifacts',
        revision,
      ),
      ...(state.projectUrl === undefined ? {} : { serverUrl: state.projectUrl }),
      ...(state.carrier === undefined
        ? {}
        : {
            carrier: state.carrier,
            carrierGeneration: state.status.generation,
            ...(state.carrierRun === undefined ? {} : { carrierRun: state.carrierRun }),
          }),
    });
    if (stopped()) {
      await state.session.close();
      return;
    }
    if (state.snapshot) {
      const append = (level: string, text: string) => {
        state.logs.push({ sequence: ++state.logSequence, level, text: text.slice(0, 4096) });
        if (state.logs.length > 100) state.logs.shift();
      };
      state.session.page.on('console', (message) => append(message.type(), message.text()));
      state.session.page.on('pageerror', (error) => append('error', error.message));
      state.session.page.on('close', () => {
        if (!stopped() && state.reloadInFlight === undefined)
          state.status = { ...state.status, phase: 'failed', error: 'run-page-lost' };
      });
    }
    const browserReport = state.session.report();
    state.status = {
      ...state.status,
      backend: browserReport.backend,
      fallbackReason: browserReport.fallbackReason,
      carrier: browserReport.carrier,
      carrierTarget: browserReport.carrierTarget,
      carrierFallbackReason: browserReport.carrierFallbackReason,
    };
    // A display host carrier owns the user's visible workspace and may be backgrounded
    // while the CLI keeps running. Only the private-browser fallback is safe
    // to foreground because it is Engine-owned for this run.
    if (!state.status.headless && state.status.carrier === 'private-browser') {
      await state.session.page.bringToFront();
    }
    const { readProjectStartupTimeoutMs } = await import('./project.js');
    const startupPolicy = await readProjectStartupTimeoutMs(state.executionRoot);
    if (!startupPolicy.ok) throw startupPolicy.error;
    const firstFrame = await waitForFirstFrame(
      state.session,
      startupPolicy.value === undefined ? DEV_EXECUTION_TIMEOUT_MS : startupPolicy.value,
    );
    if (stopped()) return;
    const connected = firstFrame && (await refreshBridgeStatus(state).catch(() => false));
    if (stopped()) return;
    if (!connected) {
      const errors = state.session.report().pageErrors;
      state.status = {
        ...state.status,
        phase: errors.length > 0 ? 'failed' : 'waiting',
        url: state.session.url,
        frameId: await submittedFrameId(state.session),
        error:
          errors[0] ??
          'live-app-bridge-unavailable: the actual App execution realm has not connected',
      };
    } else {
      state.status = {
        ...state.status,
        phase: state.reloadRequested ? 'reloading' : 'ready',
        url: state.session.url,
        frameId: await submittedFrameId(state.session),
      };
    }
  } catch (error) {
    await stopProjectProcess(state);
    if (stopped()) return;
    state.status = {
      ...state.status,
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeSessionFile(state);
}

async function reloadSession(state: LiveDevDaemonState): Promise<void> {
  if (state.reloadInFlight !== undefined) {
    state.reloadRequested = true;
    return state.reloadInFlight;
  }
  const operation = (async () => {
    do {
      state.reloadRequested = false;
      await reloadSessionOwned(state);
    } while (state.reloadRequested && state.status.phase !== 'stopped');
  })();
  state.reloadInFlight = operation.finally(() => {
    state.reloadInFlight = undefined;
  });
  return state.reloadInFlight;
}

async function reloadSessionOwned(state: LiveDevDaemonState): Promise<void> {
  if (state.status.phase === 'stopped') return;
  try {
    state.inputs = await checkProjectInputs(state);
  } catch (error) {
    failProjectInputs(state, error);
    return;
  }
  if (isStopped(state)) return;
  state.observation = undefined;
  state.status = {
    ...state.status,
    phase: 'reloading',
    generation: state.status.generation + 1,
    revision: randomUUID(),
    loadId: randomUUID(),
  };
  await writeSessionFile(state);
  rejectBridgePending(
    state,
    bridgeError('live-reload-cancelled', 'The previous App execution was destroyed by reload.'),
  );
  state.bridge?.close();
  await stopProjectProcess(state);
  await state.session?.close();
  state.session = undefined;
  state.evalRunning = false;
  state.status = { ...state.status, unfinishedEval: false };
  // A second edit can arrive while the old project process is being torn
  // down. Do not spend another cold build on that intermediate input: the
  // reload loop will immediately consume the latest hash and start only the
  // final project revision. This keeps a burst of edits within one startup
  // window instead of serialising multiple browser launches.
  const latestInputs = await checkProjectInputs(state);
  if (latestInputs !== state.inputs) {
    state.inputs = latestInputs;
    state.reloadRequested = true;
    return;
  }
  await openSession(state);
  await reconcileProjectInputs(state);
  await writeSessionFile(state);
}

function isStopped(state: LiveDevDaemonState): boolean {
  return state.status.phase === 'stopped';
}

function checkProjectInputs(state: LiveDevDaemonState): Promise<string> {
  if (state.snapshot) return Promise.resolve(state.inputSnapshot?.version ?? 'snapshot-not-ready');
  // Concurrent requests share one in-flight scan, never a cached successful check.
  state.inputCheck ??= readLiveProjectInputs(state.root, state.projectInputPaths).finally(() => {
    state.inputCheck = undefined;
  });
  return state.inputCheck;
}

function failProjectInputs(state: LiveDevDaemonState, error: unknown): void {
  if (isStopped(state)) return;
  state.inputs = undefined;
  state.status = {
    ...state.status,
    phase: 'failed',
    error: `live-inputs-unavailable: ${error instanceof Error ? error.message : String(error)}`,
  };
}

async function reconcileProjectInputs(state: LiveDevDaemonState): Promise<boolean> {
  if (state.snapshot) return !isStopped(state);
  if (isStopped(state)) return false;
  // The initial owner is still publishing its control session. A status query
  // has no accepted input baseline to replace and must not start another owner.
  if (
    state.status.phase === 'starting' &&
    state.inputs === undefined &&
    state.reloadInFlight === undefined
  )
    return false;
  try {
    const inputs = await checkProjectInputs(state);
    if (isStopped(state)) return false;
    if (inputs === state.inputs) return true;
    state.status = { ...state.status, phase: 'reloading' };
    if (state.reloadInFlight !== undefined) state.reloadRequested = true;
    else void reloadSession(state).catch((error) => failProjectInputs(state, error));
  } catch (error) {
    failProjectInputs(state, error);
  }
  return false;
}

function pollProjectInputs(state: LiveDevDaemonState, delayMs = 1_000): void {
  // Event delivery is not an authority. Poll even with no CLI requests, and
  // check again around operations and reload before publishing success.
  state.inputTimer = setTimeout(() => {
    const started = performance.now();
    const cpu = process.cpuUsage();
    void reconcileProjectInputs(state).finally(() => {
      const spent = process.cpuUsage(cpu);
      const costMs = Math.max(performance.now() - started, (spent.user + spent.system) / 1_000);
      // Keep idle scanning near a 5% duty budget even on large/slow trees.
      // This delay never applies to explicit command admission checks.
      if (!isStopped(state)) pollProjectInputs(state, Math.max(1_000, costMs * 20));
    });
  }, delayMs);
  state.inputTimer.unref();
}

async function stopProjectProcess(state: LiveDevDaemonState): Promise<void> {
  const child = state.projectProcess;
  state.projectProcess = undefined;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function replaceProjectProcess(state: LiveDevDaemonState, generation: number): Promise<void> {
  await stopProjectProcess(state);
  const child = spawn(
    process.execPath,
    // The daemon owns the control endpoint, while the project child owns the
    // Vite endpoint. Keep the latter OS-assigned so an unrelated 5173 listener
    // cannot hold a live session in starting/failed state. The project host
    // materializes port 0 before asking Vite to listen and reports its actual
    // URL back through the ready line.
    [
      state.snapshot
        ? resolve(state.executionRoot, 'node_modules/@forgeax/engine/dist/bin/forgeax.mjs')
        : CLI_ENTRY,
      '--__forgeax-live-project',
      state.executionRoot,
      String(generation),
      '0',
    ],
    {
      env: {
        ...process.env,
        // Independent runs consume the copied package inputs, not a mutable
        // contributor build cache selected by the launching shell.
        ...(state.snapshot ? { FORGEAX_SHARED_APP_INPUTS_MANIFEST: undefined } : {}),
        VITE_FORGEAX_ENGINE_BRIDGE: '1',
        VITE_FORGEAX_ENGINE_BRIDGE_PORT: new URL(state.status.endpoint).port,
        FORGEAX_EXECUTION_WORKERS:
          state.requestedWorkers === undefined ? undefined : JSON.stringify(state.requestedWorkers),
        FORGEAX_ANIMATION_PLAYBACK: JSON.stringify(state.animation),
        ...(state.rhiCapture ? { FORGEAX_ENGINE_RHI_DEBUG: '1' } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  state.projectProcess = child;
  const log = createWriteStream(resolve(dirname(state.sessionPath), 'dev.log'), { flags: 'a' });
  child.stderr?.pipe(log, { end: false });
  child.once('close', () => log.end());
  await new Promise<void>((resolveReady, rejectReady) => {
    let output = '';
    // A cold SDK tree may need to build the shader and asset closure before Vite
    // can publish its ready line. The persistent service owns that work, so a
    // short CLI-style deadline would turn a healthy cold start into a false
    // failed instance. Keep the bound finite while allowing one cold build.
    const timer = setTimeout(
      () => rejectReady(new Error('live project backend build timed out')),
      300_000,
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      log.write(chunk);
      output += chunk;
      const lines = output.split('\n');
      output = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const result = JSON.parse(line) as {
            readonly ready?: boolean;
            readonly error?: string;
            readonly generation?: number;
            readonly url?: string;
            readonly inputPaths?: readonly string[];
            readonly inputVersion?: string;
          };
          if (result.ready === true && result.generation === generation) {
            clearTimeout(timer);
            state.projectUrl = result.url;
            if (!state.snapshot && result.inputPaths && result.inputVersion) {
              state.projectInputPaths = result.inputPaths;
              state.inputs = result.inputVersion;
            }
            resolveReady();
            return;
          }
          if (result.error !== undefined) {
            clearTimeout(timer);
            rejectReady(new Error(result.error));
            return;
          }
        } catch {
          // Preserve non-JSON build diagnostics until a structured terminal line.
        }
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectReady(
        new Error(
          `live project backend exited ${code} before readiness; inspect ${resolve(dirname(state.sessionPath), 'dev.log')}`,
        ),
      );
    });
  });
}

/** Internal dev resource entry; it is never a public command. */
export async function runLiveProjectProcess(
  rootInput: string,
  generationInput: string,
  projectPortInput = '0',
): Promise<void> {
  const root = resolve(rootInput);
  const generation = Number(generationInput);
  const projectPort = Number(projectPortInput);
  if (!Number.isSafeInteger(projectPort) || projectPort < 0 || projectPort > 65_535) {
    throw new Error(`live project process received invalid project port: ${projectPortInput}`);
  }
  const startedAt = Date.now();
  process.stderr.write('live project: loading DevKit host\n');
  const { readProjectFacts } = await import('./project.js');
  const facts = await readProjectFacts(root);
  let inputPaths: readonly string[] | undefined;
  const built = facts.ok
    ? await import('./host.js').then(({ startDevProjectWithHost }) => {
        process.stderr.write(
          `live project: starting project backend after ${Date.now() - startedAt}ms\n`,
        );
        return startDevProjectWithHost({ root, json: true, port: projectPort }, (paths) => {
          inputPaths = paths;
        });
      })
    : facts;
  if (!built.ok) {
    process.stderr.write(`${JSON.stringify(built.error)}\n`);
    process.stdout.write(
      `${JSON.stringify({ error: `${built.error.code}: ${built.error.hint}; inspect ${resolve(root, '.forgeax/dev.log')}`, generation })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const url =
    built.ok &&
    built.value !== null &&
    typeof built.value === 'object' &&
    'urls' in built.value &&
    built.value.urls !== null &&
    typeof built.value.urls === 'object' &&
    'local' in built.value.urls &&
    Array.isArray(built.value.urls.local)
      ? built.value.urls.local[0]
      : undefined;
  const inputVersion = await readLiveProjectInputs(root, inputPaths);
  process.stdout.write(
    `${JSON.stringify({ ready: true, generation, url, inputPaths, inputVersion })}\n`,
  );
  await new Promise<void>((resolveExit) => {
    const stop = (): void => {
      void import('./host.js')
        .then(({ disposeDevKitHosts }) => disposeDevKitHosts())
        .finally(resolveExit);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function handleRequest(
  state: LiveDevDaemonState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (state.controlToken && request.headers.authorization !== `Bearer ${state.controlToken}`) {
    jsonResponse(response, 403, {
      ok: false,
      error: commandError('run-unauthorized', 'Use the Engine run client.'),
    });
    return;
  }
  if (url.pathname === '/observe') {
    const { endpoint: _endpoint, url: _url, ...status } = state.status;
    jsonResponse(response, 200, {
      ok: true,
      value: {
        status,
        image: state.observation ?? null,
        logs: state.logs,
        firstLogSequence: state.logs[0]?.sequence ?? state.logSequence + 1,
        nextLogSequence: state.logSequence + 1,
        droppedLogs: state.logSequence - state.logs.length,
      },
    });
    return;
  }
  let evalIdentity: { readonly revision: string; readonly loadId: string } | undefined;
  let profileCaptureId: string | undefined;
  let profileCaptureWorldIdentity: string | undefined;
  let revokeLeaseForRequest: (() => void) | undefined;
  const clearEvalState = async (): Promise<void> => {
    const identity = evalIdentity;
    evalIdentity = undefined;
    if (
      identity === undefined ||
      state.status.revision !== identity.revision ||
      state.status.loadId !== identity.loadId
    )
      return;
    state.evalRunning = false;
    state.status = { ...state.status, unfinishedEval: false };
    await writeSessionFile(state);
  };
  if (request.method === 'GET' && url.pathname === '/status') {
    // Status is polled by the live-sync probe while a replacement project is
    // booting.  The reload owner already captured the input hash before it
    // destroyed the old session; rescanning the entire project tree on every
    // status request only contends with the new Vite/Pack startup and can
    // starve the browser long enough to turn a valid reload into a timeout.
    // Keep direct control requests authoritative (requireCurrentBridge still
    // performs a fresh scan) and let the background poller reconcile edits
    // once the replacement reaches a stable state.
    if (state.reloadInFlight === undefined && !state.reloadRequested)
      await reconcileProjectInputs(state);
    // The owner's health endpoint must not wait for the game frame loop. One
    // outstanding bridge request already represents a probe; do not queue more.
    if (!state.snapshot && state.bridgePending.size === 0 && state.reloadInFlight === undefined) {
      void refreshBridgeStatus(state)
        .then(() => refreshFrameStatus(state))
        .catch((error) => {
          if (state.status.phase === 'ready' || state.status.phase === 'waiting') {
            state.status = {
              ...state.status,
              phase: 'waiting',
              error: error instanceof Error ? error.message : String(error),
            };
          }
        });
    }
    jsonResponse(response, 200, { ok: true, value: publicStatus(state.status) });
    return;
  }
  if (request.method !== 'POST') {
    jsonResponse(response, 405, {
      ok: false,
      error: commandError(
        'live-method-not-allowed',
        'Use GET /status or a supported POST operation.',
      ),
    });
    return;
  }
  try {
    if (url.pathname === '/reload') {
      await reloadSession(state);
      jsonResponse(
        response,
        state.status.phase === 'ready' ? 200 : 409,
        readyResult({ ok: true, value: publicStatus(state.status) }),
      );
      return;
    }
    if (url.pathname === '/stop') {
      await stopLiveDaemon(state);
      jsonResponse(response, 200, { ok: true, value: publicStatus(state.status) });
      return;
    }
    if (url.pathname === '/rhi/capture') {
      if (state.evalRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'RHI capture is blocked until the current evaluation completes.',
          ),
        });
        return;
      }
      const args = (await body(request)) as Record<string, unknown>;
      if (!(await requireCurrentBridge(state, response))) return;
      const before = state.status;
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        jsonResponse(response, 409, { ok: false, error: identityError });
        return;
      }
      if (state.session === undefined || before.phase !== 'ready') {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const runId = `live-rhi-${randomUUID()}`;
      state.evalRunning = true;
      evalIdentity = { revision: before.revision, loadId: before.loadId };
      state.status = { ...state.status, unfinishedEval: true };
      await writeSessionFile(state);
      try {
        const captured = await bridgeEval(state, rhiCaptureScript(runId), 120_000);
        if (
          captured === null ||
          typeof captured !== 'object' ||
          Reflect.get(captured, 'ok') !== true
        ) {
          const error =
            captured !== null &&
            typeof captured === 'object' &&
            Reflect.get(captured, 'error') !== undefined
              ? (Reflect.get(captured, 'error') as Record<string, unknown>)
              : commandError('capture-unavailable', 'The live App did not return an RHI tape.');
          jsonResponse(response, 409, { ok: false, error });
          return;
        }
        if (!(await requireCurrentBridge(state, response))) return;
        const after = state.status;
        if (
          before.revision !== after.revision ||
          before.loadId !== after.loadId ||
          before.worldIdentity !== after.worldIdentity
        ) {
          jsonResponse(response, 409, {
            ok: false,
            error: commandError(
              'live-instance-changed',
              'The live instance changed while capturing RHI work; retry against the new status.',
            ),
          });
          return;
        }
        const value = Reflect.get(captured, 'value');
        if (value === null || typeof value !== 'object') {
          jsonResponse(response, 500, {
            ok: false,
            error: commandError(
              'capture-artifact-invalid',
              'The live RHI provider returned no artifact reference.',
            ),
          });
          return;
        }
        const artifact = value as Record<string, unknown>;
        if (typeof args.output === 'string' && typeof artifact.path === 'string') {
          const output = resolve(state.root, args.output);
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, await readFile(artifact.path));
          artifact.path = output;
        }
        jsonResponse(response, 200, {
          ok: true,
          value: { revision: after.revision, frameId: after.frameId, ...artifact },
        });
        return;
      } finally {
        await clearEvalState();
      }
    }
    if (url.pathname === '/capture' || url.pathname === '/verify') {
      const verifying = url.pathname === '/verify';
      if (state.captureRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError('run-capture-busy', 'Wait for the current capture.'),
        });
        return;
      }
      state.captureRunning = true;
      await state.observationInFlight;
      try {
        if (state.evalRunning) {
          jsonResponse(response, 409, {
            ok: false,
            error: commandError(
              'live-eval-running',
              'Capture is blocked until the current evaluation completes.',
            ),
          });
          return;
        }
        const args = (await body(request)) as {
          readonly output?: unknown;
          readonly checkpoint?: unknown;
          readonly requireUi?: boolean;
          readonly revision?: unknown;
          readonly timeoutMs?: number;
        };
        if (verifying && typeof args.revision !== 'string') {
          jsonResponse(response, 400, {
            ok: false,
            error: commandError(
              'live-revision-required',
              'Pass the revision of the execution to verify.',
            ),
          });
          return;
        }
        if (
          verifying &&
          args.timeoutMs !== undefined &&
          (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1)
        ) {
          jsonResponse(response, 400, {
            ok: false,
            error: commandError(
              'live-invalid-timeout',
              'Verification timeoutMs must be a positive integer.',
            ),
          });
          return;
        }
        if (!(await requireCurrentBridge(state, response))) return;
        await refreshFrameStatus(state);
        const before = state.status;
        const identityError = assertLiveIdentity(state, args);
        if (identityError !== undefined) {
          jsonResponse(response, 409, { ok: false, error: identityError });
          return;
        }
        if (state.session === undefined || before.phase !== 'ready') {
          jsonResponse(response, 409, {
            ok: false,
            error: commandError(
              'live-not-ready',
              'Wait for the live instance to reach a submitted frame.',
            ),
          });
          return;
        }
        const healthError = verifying ? assertRuntimeHealth(before) : undefined;
        if (healthError !== undefined) {
          jsonResponse(response, 409, { ok: false, error: healthError });
          return;
        }
        // Fail before entering the 120s compositor wait when the project has no
        // renderable camera. Capture is an observation of the live World, so the
        // realm's structured camera error is the honest terminal result.
        try {
          await bridgeCall(state, 'return simulation.observation?.camera.get();', 5_000).promise;
        } catch (error) {
          const code =
            typeof (error as { readonly code?: unknown })?.code === 'string'
              ? (error as { readonly code: string }).code
              : 'live-camera-unavailable';
          jsonResponse(response, 409, {
            ok: false,
            error: commandError(
              code,
              error instanceof Error ? error.message : 'The live World has no active camera.',
            ),
          });
          return;
        }
        const record = await state.session.capture(
          typeof args.checkpoint === 'string' ? args.checkpoint : undefined,
          {
            purpose: verifying ? 'validate' : 'observe',
            ...(verifying && before.frameId !== undefined ? { afterFrameId: before.frameId } : {}),
            ...(verifying && args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
            ...(args.requireUi === undefined ? {} : { requireUi: args.requireUi }),
            ...(typeof args.output === 'string' ? { output: args.output } : {}),
          },
        );
        if (!(await requireCurrentBridge(state, response))) return;
        await refreshFrameStatus(state);
        const after = state.status;
        if (
          before.revision !== after.revision ||
          before.loadId !== after.loadId ||
          before.worldIdentity !== after.worldIdentity
        ) {
          jsonResponse(response, 409, {
            ok: false,
            error: commandError(
              'live-instance-changed',
              'The live instance changed while capturing; retry against the new status.',
            ),
          });
          return;
        }
        const finalHealthError = verifying ? assertRuntimeHealth(after) : undefined;
        if (finalHealthError !== undefined) {
          jsonResponse(response, 409, { ok: false, error: finalHealthError });
          return;
        }
        const report = state.session.report();
        const reportPath = `${record.output}.json`;
        const reportBytes = `${JSON.stringify({ revision: after.revision, ...(verifying ? { execution: after.execution } : {}), record, consoleErrors: report.consoleErrors, pageErrors: report.pageErrors }, null, 2)}\n`;
        await writeFile(reportPath, reportBytes, 'utf8');
        if (
          verifying &&
          (!record.ok || report.consoleErrors.length > 0 || report.pageErrors.length > 0)
        ) {
          jsonResponse(response, 409, {
            ok: false,
            error: commandError(
              'live-runtime-failed',
              'Runtime errors were observed during verification.',
              {
                output: record.output,
                report: reportPath,
              },
            ),
          });
          return;
        }
        jsonResponse(response, 200, {
          ok: true,
          artifacts: [
            { kind: 'png', uri: record.output, mediaType: 'image/png', digest: record.digest },
            {
              kind: 'tool-result',
              uri: reportPath,
              mediaType: 'application/json',
              digest: `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`,
            },
          ],
          value: {
            revision: after.revision,
            ...(verifying ? { verified: 'runtime' as const } : {}),
            ...(state.snapshot ? { runId: after.runId, inputVersion: after.inputVersion } : {}),
            frameId: record.runtime.engineFrameId,
            screenshot: {
              kind: 'screenshot',
              uri: record.output,
              mediaType: 'image/png',
              digest: record.digest,
            },
            report: {
              kind: 'tool-result',
              uri: reportPath,
              mediaType: 'application/json',
              digest: `sha256:${createHash('sha256').update(reportBytes).digest('hex')}`,
            },
            pixels: {
              width: record.pixels.width,
              height: record.pixels.height,
              rendered: record.pixels.rendered,
            },
            errors: { console: report.consoleErrors.length, page: report.pageErrors.length },
          },
        });
        return;
      } finally {
        state.captureRunning = false;
      }
    }
    if (
      url.pathname === '/camera/get' ||
      url.pathname === '/camera/set' ||
      url.pathname === '/camera/release' ||
      url.pathname === '/find' ||
      url.pathname === '/focus'
    ) {
      if (state.evalRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'Observation mutation is blocked until the current evaluation completes.',
          ),
        });
        return;
      }
      if (state.session === undefined) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const args = (await body(request)) as Record<string, unknown>;
      if (!(await requireCurrentBridge(state, response))) return;
      if (state.status.phase !== 'ready') {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        jsonResponse(response, 409, { ok: false, error: identityError });
        return;
      }
      if (
        url.pathname === '/focus' &&
        (typeof args.name === 'string') === (typeof args.ref === 'string')
      ) {
        jsonResponse(response, 400, {
          ok: false,
          error: commandError('live-target-required', 'Pass exactly one of --name or --ref.'),
        });
        return;
      }
      const before = state.status;
      const operation = url.pathname.slice(1);
      const script =
        operation === 'camera/get'
          ? 'return simulation.observation?.camera.get();'
          : operation === 'camera/release'
            ? 'simulation.observation.release(); return simulation.observation.camera.get();'
            : operation === 'find'
              ? `return simulation.observation.find(${JSON.stringify(args)});`
              : operation === 'camera/set'
                ? `return simulation.observation?.camera.set(${JSON.stringify(args)});`
                : `return simulation.observation?.focus(${JSON.stringify(args)});`;
      const result = await bridgeEval(state, script);
      if (operation !== 'camera/get' && operation !== 'find')
        await waitForFrameAfter(state.session, before.frameId);
      if (!(await requireCurrentBridge(state, response))) return;
      await refreshFrameStatus(state);
      if (
        before.revision !== state.status.revision ||
        before.loadId !== state.status.loadId ||
        before.worldIdentity !== state.status.worldIdentity
      ) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-instance-changed',
            'The live instance or World changed while applying the camera operation; retry against the new status.',
          ),
        });
        return;
      }
      jsonResponse(response, 200, {
        ok: true,
        value: {
          revision: state.status.revision,
          frameId: state.status.frameId,
          ...observationValue(result, state.status.revision),
        },
      });
      return;
    }
    if (url.pathname === '/profile/capture') {
      if (state.evalRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError('live-eval-running', 'Profile capture is already running.'),
        });
        return;
      }
      const args = (await body(request)) as Record<string, unknown>;
      if (!(await requireCurrentBridge(state, response))) return;
      const before = state.status;
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        jsonResponse(response, 409, { ok: false, error: identityError });
        return;
      }
      if (state.session === undefined || before.phase !== 'ready') {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const frameLimit =
        typeof args.frameLimit === 'number' && Number.isSafeInteger(args.frameLimit)
          ? Math.min(120, Math.max(1, args.frameLimit))
          : 30;
      const eventLimit =
        typeof args.eventLimit === 'number' && Number.isSafeInteger(args.eventLimit)
          ? Math.min(20_000, Math.max(64, args.eventLimit))
          : 4_096;
      state.evalRunning = true;
      evalIdentity = { revision: before.revision, loadId: before.loadId };
      profileCaptureWorldIdentity = before.worldIdentity;
      state.status = { ...state.status, unfinishedEval: true };
      await writeSessionFile(state);
      const clearProfileState = async (): Promise<void> => {
        if (
          evalIdentity === undefined ||
          state.status.revision !== evalIdentity.revision ||
          state.status.loadId !== evalIdentity.loadId
        )
          return;
        state.evalRunning = false;
        evalIdentity = undefined;
        state.status = { ...state.status, unfinishedEval: false };
        await writeSessionFile(state);
      };
      const started = await bridgeEval(
        state,
        `return (() => {
          if (profiler === undefined) return { ok: false, error: { code: 'profile-capture-unavailable', hint: 'The live App has no profiler capability.' } };
          const result = profiler.startCapture({ frameLimit: ${frameLimit}, eventLimit: ${eventLimit} });
          return result.ok ? { ok: true, captureId: result.value.captureId } : result;
        })();`,
        10_000,
      );
      if (started === null || typeof started !== 'object' || Reflect.get(started, 'ok') !== true) {
        await clearProfileState();
        const error =
          started !== null &&
          typeof started === 'object' &&
          Reflect.get(started, 'error') !== undefined
            ? (Reflect.get(started, 'error') as Record<string, unknown>)
            : commandError('profile-capture-unavailable', 'The live App did not start profiling.');
        jsonResponse(response, 409, { ok: false, error });
        return;
      }
      profileCaptureId =
        typeof Reflect.get(started, 'captureId') === 'string'
          ? (Reflect.get(started, 'captureId') as string)
          : undefined;
      await waitForProfilerCompletion(state, before.frameId, 120_000);
      const capture = await bridgeEval(state, 'return profiler?.latestCapture() ?? null;', 10_000);
      if (capture === null || typeof capture !== 'object') {
        throw bridgeError(
          'profile-capture-unavailable',
          'The live profiler finished without an artifact.',
        );
      }
      if (!(await requireCurrentBridge(state, response))) {
        await clearProfileState();
        return;
      }
      const after = state.status;
      if (
        before.revision !== after.revision ||
        before.loadId !== after.loadId ||
        before.worldIdentity !== after.worldIdentity
      ) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-instance-changed',
            'The live instance changed while profiling; retry against the new status.',
          ),
        });
        await clearProfileState();
        return;
      }
      const output = resolve(
        state.root,
        typeof args.output === 'string'
          ? args.output
          : `.forgeax/profiles/${before.revision}-${String(Date.now())}.json`,
      );
      await mkdir(dirname(output), { recursive: true });
      const bytes = `${JSON.stringify(capture, null, 2)}\n`;
      await writeFile(output, bytes, 'utf8');
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      await clearProfileState();
      profileCaptureId = undefined;
      profileCaptureWorldIdentity = undefined;
      jsonResponse(response, 200, {
        ok: true,
        value: {
          revision: after.revision,
          captureId: Reflect.get(capture, 'captureId'),
          artifact: { kind: 'profile-capture', uri: output, path: output, digest },
        },
      });
      return;
    }
    if (url.pathname === '/eval') {
      const args = (await body(request)) as {
        readonly code?: unknown;
        readonly timeoutMs?: unknown;
        readonly revision?: unknown;
        readonly lease?: unknown;
      };
      if (typeof args.revision !== 'string') {
        jsonResponse(response, 400, {
          ok: false,
          error: commandError(
            'live-revision-required',
            'Pass --revision from dev status before evaluating code.',
          ),
        });
        return;
      }
      if (typeof args.code !== 'string' || args.code.trim().length === 0) {
        jsonResponse(response, 400, {
          ok: false,
          error: commandError(
            'live-invalid-eval',
            'Provide a non-empty JavaScript expression in code.',
          ),
        });
        return;
      }
      if (state.evalRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'Only status, reload, and stop are available while eval is running.',
          ),
        });
        return;
      }
      if (state.session === undefined) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      if (!(await requireCurrentBridge(state, response))) return;
      if (state.status.phase !== 'ready') {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const before = state.status;
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        jsonResponse(response, 409, { ok: false, error: identityError });
        return;
      }
      state.evalRunning = true;
      evalIdentity = { revision: before.revision, loadId: before.loadId };
      state.status = { ...state.status, unfinishedEval: true };
      await writeSessionFile(state);
      const timeout = typeof args.timeoutMs === 'number' ? Math.max(0, args.timeoutMs) : 30_000;
      // The caller timeout only bounds the HTTP wait. The bridge request stays
      // pending until the actual realm returns or a hard reload/stop closes it.
      // `lease: true` makes synthetic input a lexical session resource. The
      // actual realm clears it after normal return or throw; bridge teardown
      // and Worker disconnects cover the remaining owner boundaries.
      openLiveInput(state);
      const evaluationCode =
        args.lease === true
          ? `try { ${args.code} } finally { simulation?.input?.revokeInjectedLease?.(); if (simulation?.input?.revokeInjectedLease === undefined) simulation?.input?.clearInjected?.(); }`
          : args.code;
      const evaluationCall = bridgeCall(state, evaluationCode, null);
      let leaseActive = args.lease === true;
      const revokeLease = (): void => {
        if (!leaseActive) return;
        leaseActive = false;
        revokeLiveInput(state);
        void evaluationCall.cancel().catch(() => {});
      };
      const finishLease = (): void => {
        leaseActive = false;
        if (revokeLeaseForRequest === revokeLease) revokeLeaseForRequest = undefined;
        request.off('aborted', revokeLease);
        response.off('close', revokeLease);
      };
      if (leaseActive) {
        revokeLeaseForRequest = revokeLease;
        request.once('aborted', revokeLease);
        response.once('close', revokeLease);
      }
      const evaluation = evaluationCall.promise;
      const timed = await Promise.race([
        evaluation.then((value) => ({ state: 'completed' as const, value })),
        new Promise<{ state: 'continuing' }>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ state: 'continuing' }), timeout),
        ),
      ]);
      if (timed.state === 'continuing') {
        if (!evaluationCall.started()) {
          const admitted = await Promise.race([
            evaluationCall.cancel(),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
          ]);
          void evaluation.catch(() => {});
          if (!admitted) {
            finishLease();
            state.evalRunning = false;
            evalIdentity = undefined;
            state.status = { ...state.status, unfinishedEval: false };
            await writeSessionFile(state);
            jsonResponse(response, 409, {
              ok: false,
              error: commandError(
                'live-eval-cancelled-before-execution',
                'The evaluation did not start before the caller deadline and was cancelled.',
                { continuing: false, revision: before.revision },
              ),
            });
            return;
          }
        }
        jsonResponse(response, 408, {
          ok: false,
          error: commandError(
            'live-eval-continuing',
            'The caller wait ended; the owner still tracks the evaluation.',
            { continuing: true, revision: before.revision },
          ),
        });
        void evaluation.then(
          () => {
            finishLease();
            if (state.status.revision !== before.revision || state.status.loadId !== before.loadId)
              return;
            state.evalRunning = false;
            state.status = { ...state.status, unfinishedEval: false };
            void writeSessionFile(state);
          },
          () => {
            finishLease();
            if (state.status.revision !== before.revision || state.status.loadId !== before.loadId)
              return;
            state.evalRunning = false;
            state.status = { ...state.status, unfinishedEval: false };
            void writeSessionFile(state);
          },
        );
        return;
      }
      finishLease();
      state.evalRunning = false;
      evalIdentity = undefined;
      state.status = { ...state.status, unfinishedEval: false };
      if (!(await requireCurrentBridge(state, response))) return;
      await writeSessionFile(state);
      jsonResponse(response, 200, {
        ok: true,
        value: { revision: before.revision, result: timed.value },
      });
      return;
    }
    jsonResponse(response, 404, {
      ok: false,
      error: commandError('live-route-not-found', 'Use status, reload, stop, eval, or capture.'),
    });
  } catch (error) {
    if (profileCaptureId !== undefined) {
      finishLiveProfiler(state, {
        ...(profileCaptureWorldIdentity === undefined
          ? {}
          : { worldIdentity: profileCaptureWorldIdentity }),
        captureId: profileCaptureId,
      });
    }
    profileCaptureId = undefined;
    profileCaptureWorldIdentity = undefined;
    revokeLeaseForRequest?.();
    revokeLeaseForRequest = undefined;
    if (
      evalIdentity !== undefined &&
      state.status.revision === evalIdentity.revision &&
      state.status.loadId === evalIdentity.loadId
    ) {
      state.evalRunning = false;
      state.status = { ...state.status, unfinishedEval: false };
      void writeSessionFile(state);
    }
    const diagnostic = error as { code?: unknown; hint?: unknown; detail?: unknown };
    jsonResponse(response, 500, {
      ok: false,
      error: commandError(
        typeof diagnostic?.code === 'string' ? diagnostic.code : 'live-operation-failed',
        typeof diagnostic?.hint === 'string'
          ? diagnostic.hint
          : error instanceof Error
            ? error.message
            : String(error),
        diagnostic?.detail !== null && typeof diagnostic?.detail === 'object'
          ? (diagnostic.detail as Record<string, unknown>)
          : {},
      ),
    });
  }
}

/** One bounded producer per run; observing its cached output never advances the game. */
function pollRunObservation(state: LiveDevDaemonState): void {
  const tick = async () => {
    if (isStopped(state)) return;
    try {
      if (
        (state.status.phase === 'ready' || state.status.phase === 'waiting') &&
        !state.captureRunning &&
        !state.evalRunning &&
        !state.reloadInFlight &&
        state.session
      ) {
        await refreshBridgeStatus(state);
        // A reconnect must prove a live World and submitted frame before capture.
        if (state.status.phase !== 'ready') return;
        await refreshFrameStatus(state);
        const session = state.session;
        const revision = state.status.revision;
        const { captureBrowserExecutionSurface } = await import('./browser-capture.js');
        const png = await captureBrowserExecutionSurface(
          session.execution ?? { kind: 'page', ownerPage: session.page, realm: session.page },
          Date.now() + 5_000,
          session.report().viewport,
        );
        if (
          state.session === session &&
          state.status.revision === revision &&
          png.byteLength <= 4 * 1024 * 1024
        ) {
          state.observation = {
            capturedAt: new Date().toISOString(),
            revision,
            frameId: state.status.frameId,
            png: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
          };
        }
      }
    } catch {
      // Status carries target failures; a missed observation never fails the run.
    } finally {
      state.observationInFlight = undefined;
      if (!isStopped(state))
        state.observationTimer = setTimeout(() => {
          state.observationInFlight = tick();
        }, 5_000);
    }
  };
  state.observationInFlight = tick();
}

/** One stop path shared by HTTP control, host disposal and startup rollback. */
function stopLiveDaemon(state: LiveDevDaemonState): Promise<void> {
  if (state.stopPromise !== undefined) return state.stopPromise;
  state.stopPromise = (async () => {
    if (state.observationTimer !== undefined) clearTimeout(state.observationTimer);
    if (state.inputTimer !== undefined) clearTimeout(state.inputTimer);
    state.inputTimer = undefined;
    state.reloadRequested = false;
    state.status = {
      ...state.status,
      phase: 'stopped',
      generation: state.status.generation + 1,
      revision: randomUUID(),
      loadId: randomUUID(),
    };
    state.evalRunning = false;
    state.status = { ...state.status, unfinishedEval: false };
    const failures: unknown[] = [];
    const release = async (cleanup: () => unknown | Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    };
    if (state.server?.listening) await release(() => writeSessionFile(state));
    await release(() => state.session?.close());
    await release(() => state.observationInFlight);
    rejectBridgePending(
      state,
      bridgeError('live-stop-cancelled', 'The live App execution was destroyed by stop.'),
    );
    await release(() => state.bridge?.close());
    await release(() => state.bridgeServer?.close());
    await release(() => stopProjectProcess(state));
    if (state.inputTimer !== undefined) clearTimeout(state.inputTimer);
    await release(() => state.browser?.close());
    await release(() => state.server?.close());
    await release(() => state.inputSnapshot?.dispose());
    if (state.ownerClaimed) {
      await release(() => unlink(resolve(runStateDirectory(state.root), 'owner.json')));
      state.ownerClaimed = false;
    }
    await release(async () => {
      const current = await readSession(state.root, state.snapshot).catch(() => undefined);
      if (current?.pid === process.pid && current.endpoint === state.status.endpoint)
        await removeLiveDevSession(state.root, { snapshot: state.snapshot });
    });
    if (failures.length) throw new AggregateError(failures, 'Live owner cleanup failed');
  })();
  return state.stopPromise;
}

export async function runLiveDevDaemon(
  rootInput: string,
  port: number,
  sessionFile: string | undefined = undefined,
  options: LiveDevDaemonOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (options.snapshot && options.carrier)
    throw new Error('Independent runs require an Engine-owned browser.');
  const root = resolve(rootInput);
  const carrierRun =
    options.carrier === undefined
      ? undefined
      : (options.carrierRun ?? {
          serviceId: `live-dev-service-${randomUUID()}`,
          runId: `live-dev-run-${randomUUID()}`,
        });
  const state: LiveDevDaemonState = {
    root,
    ownerClaimed: false,
    snapshot: options.snapshot === true,
    controlToken: options.snapshot ? randomUUID() : undefined,
    executionRoot: root,
    inputSnapshot: undefined,
    observation: undefined,
    observationTimer: undefined,
    observationInFlight: undefined,
    logs: [],
    logSequence: 0,
    captureRunning: false,
    sessionPath: sessionFile ?? sessionPath(root, options.snapshot),
    browser: undefined,
    carrier: options.carrier,
    carrierRun,
    requestedWorkers: options.workers ?? environmentExecutionWorkers(),
    animation:
      options.animation === undefined
        ? environmentAnimationPlayback()
        : animationPlayback(options.animation),
    rhiCapture: options.rhiCapture ?? process.env.FORGEAX_DEV_RHI_CAPTURE === '1',
    session: undefined,
    projectUrl: undefined,
    status: {
      schemaVersion: '1.0.0',
      ...(options.snapshot ? { runId: randomUUID() } : {}),
      root,
      endpoint: `http://127.0.0.1:${port}`,
      pid: process.pid,
      generation: 0,
      revision: randomUUID(),
      loadId: randomUUID(),
      phase: 'starting',
      unfinishedEval: false,
      url: undefined,
      frameId: undefined,
      worldIdentity: undefined,
      workers: undefined,
      backendRequested:
        options.backend ??
        (process.env.FORGEAX_DEV_BACKEND === 'hardware' ||
        process.env.FORGEAX_DEV_BACKEND === 'software'
          ? process.env.FORGEAX_DEV_BACKEND
          : 'auto'),
      backend: 'unknown',
      fallbackReason: undefined,
      carrier: 'private-browser',
      carrierTarget: undefined,
      carrierFallbackReason: undefined,
      headless: options.headless ?? process.env.FORGEAX_DEV_HEADLESS === 'true',
      bridgeConnected: false,
      error: undefined,
    },
    evalRunning: false,
    server: undefined,
    bridgeServer: undefined,
    bridge: undefined,
    bridgeNextId: 1,
    bridgePending: new Map(),
    projectProcess: undefined,
    inputs: undefined,
    projectInputPaths: undefined,
    inputCheck: undefined,
    inputTimer: undefined,
    reloadInFlight: undefined,
    reloadRequested: false,
  };
  state.server = createServer((request, response) => void handleRequest(state, request, response));
  // Stop may close the control server while the first browser session is opening.
  const closed = new Promise<void>((resolveClose) => state.server?.once('close', resolveClose));
  const onAbort = () => {
    void stopLiveDaemon(state).catch(() => {});
  };
  const claimFile = resolve(runStateDirectory(root), 'owner.json');
  try {
    if (state.snapshot) {
      await mkdir(dirname(claimFile), { recursive: true, mode: 0o700 });
      await writeFile(claimFile, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
      state.ownerClaimed = true;
    }
    installBridgeRelay(state);
    await once(state.server.listen(port, '127.0.0.1'), 'listening');
    await writeSessionFile(state);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) await stopLiveDaemon(state);
    else {
      if (state.snapshot) {
        try {
          state.inputSnapshot = await createRunSnapshot(
            root,
            resolve(runStateDirectory(root), `inputs-${state.status.runId}`),
          );
          if (isStopped(state)) {
            await state.inputSnapshot.dispose();
            return;
          }
          state.executionRoot = state.inputSnapshot.root;
          state.status = { ...state.status, inputVersion: state.inputSnapshot.version };
          await reloadSession(state);
          pollRunObservation(state);
        } catch (error) {
          if (isStopped(state)) return;
          state.status = { ...state.status, phase: 'failed', error: String(error) };
          await writeSessionFile(state);
        }
      } else {
        pollProjectInputs(state);
        await reloadSession(state);
      }
    }
    options.onReady?.(state.status);
    await closed;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await stopLiveDaemon(state);
  }
}

async function readSession(root: string, snapshot = false): Promise<LiveDevSessionFile> {
  return JSON.parse(await readFile(sessionPath(root, snapshot), 'utf8')) as LiveDevSessionFile;
}

async function requestJson(
  session: LiveDevSessionFile,
  path: string,
  method: 'GET' | 'POST',
  value?: unknown,
): Promise<unknown> {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      `${session.endpoint}${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(session.controlToken ? { authorization: `Bearer ${session.controlToken}` } : {}),
        },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(raw) as unknown;
            resolveResponse(parsed);
          } catch (error) {
            rejectResponse(error);
          }
        });
      },
    );
    request.setTimeout(path === '/status' ? 5_000 : 330_000, () =>
      request.destroy(new Error(LIVE_DEV_REQUEST_TIMEOUT)),
    );
    request.on('error', rejectResponse);
    if (value !== undefined) request.write(JSON.stringify(value));
    request.end();
  });
}

export async function liveDevStatus(
  rootInput: string,
  options: { readonly snapshot?: boolean } = {},
): Promise<unknown> {
  const root = resolve(rootInput);
  let session: LiveDevSessionFile;
  try {
    session = await readSession(root, options.snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: true, value: { root, phase: 'stopped' } };
    throw error;
  }
  try {
    return await requestJson(session, '/status', 'GET');
  } catch (error) {
    return {
      ok: true,
      value: {
        root,
        phase: 'unreachable',
        endpoint: session.endpoint,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function clearDeadRunClaim(root: string): Promise<void> {
  const path = resolve(runStateDirectory(root), 'owner.json');
  let pid: number;
  try {
    ({ pid } = JSON.parse(await readFile(path, 'utf8')) as { pid: number });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid run owner claim.');
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    await unlink(path);
  }
}

export async function liveDevControl(
  rootInput: string,
  operation: Exclude<LiveOperation, 'status'>,
  value?: unknown,
  options: { readonly snapshot?: boolean } = {},
): Promise<unknown> {
  const root = resolve(rootInput);
  try {
    return await requestJson(
      await readSession(root, options.snapshot),
      `/${operation}`,
      'POST',
      value,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (options.snapshot && operation === 'stop') await clearDeadRunClaim(root);
      if (operation === 'observe')
        return { ok: true, value: { status: { root, phase: 'stopped' }, image: null, logs: [] } };
      return operation === 'stop'
        ? { ok: true, value: { root, phase: 'stopped' } }
        : { ok: false, error: commandError('live-not-running', 'Run forgeax dev start first.') };
    }
    if (operation === 'stop') {
      const recorded = await readSession(root, options.snapshot).catch(() => undefined);
      if (recorded !== undefined && Number.isSafeInteger(recorded.pid) && recorded.pid > 0) {
        try {
          process.kill(recorded.pid, 0);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === 'ESRCH') {
            await removeLiveDevSession(root, options);
            if (options.snapshot) await clearDeadRunClaim(root);
            return { ok: true, value: { root, phase: 'stopped' } };
          }
        }
      }
    }
    return {
      ok: false,
      error: commandError(
        'live-unreachable',
        'The recorded owner did not respond; inspect dev status.',
        { cause: error instanceof Error ? error.message : String(error) },
      ),
    };
  }
}

/** A successful lifecycle operation means controls can run now. */
function readyResult(result: unknown): unknown {
  const response = result as { ok: boolean; value?: { phase?: string; error?: string } };
  if (!response.ok || response.value?.phase === 'ready') return result;
  return {
    ok: false,
    error: commandError(
      'live-not-ready',
      response.value?.error ?? 'The owner is not ready; inspect dev status before retrying.',
      { status: response.value },
    ),
  };
}

export async function startLiveDev(
  rootInput: string,
  options: {
    readonly snapshot?: boolean;
    readonly headless?: boolean;
    readonly backend?: LiveDevBackend;
    readonly workers?: ExecutionWorkersOptions;
    readonly animation?: AnimationPlaybackOptions;
    readonly rhiCapture?: boolean;
    /** Explicit process-local composition; never sent through detached CLI arguments. */
    readonly inProcess?: {
      readonly carrier?: BrowserCarrierAdapter;
      readonly signal: AbortSignal;
      /** Attach the actual daemon lifetime to the embedding owner's existing cleanup. */
      readonly onStart?: (closed: Promise<void>) => void;
    };
  } = {},
): Promise<unknown> {
  const root = resolve(rootInput);
  if (options.snapshot && options.inProcess)
    return {
      ok: false,
      error: commandError('run-owner-invalid', 'Independent runs require a detached Engine owner.'),
    };
  try {
    const existing = await liveDevStatus(root, options);
    if (
      existing !== null &&
      typeof existing === 'object' &&
      'value' in existing &&
      existing.value !== null &&
      typeof existing.value === 'object' &&
      'phase' in existing.value &&
      existing.value.phase !== 'stopped'
    ) {
      const configuration = existing.value as {
        backendRequested?: LiveDevBackend;
        headless?: boolean;
      };
      if (
        (options.backend !== undefined && options.backend !== configuration.backendRequested) ||
        (options.headless !== undefined && options.headless !== configuration.headless)
      ) {
        return {
          ok: false,
          error: commandError(
            'live-configuration-conflict',
            'This project already has an owner with different browser options. Stop it before starting with the requested options.',
            {
              current: configuration,
              requested: { backend: options.backend, headless: options.headless },
            },
          ),
        };
      }
      return readyResult(existing);
    }
  } catch (error) {
    return {
      ok: false,
      error: commandError(
        'live-discovery-invalid',
        'Inspect the existing dev session before starting another owner.',
        { cause: String(error) },
      ),
    };
  }
  if (options.snapshot) {
    const claimed = await access(resolve(runStateDirectory(root), 'owner.json')).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (claimed)
      return {
        ok: false,
        error: commandError(
          'run-owner-busy',
          'The previous run is starting or stopping. Wait for its lifecycle to finish; use stop to clear a dead owner.',
        ),
      };
  }
  const { readProjectStartupTimeoutMs } = await import('./project.js');
  const startupPolicy = await readProjectStartupTimeoutMs(root);
  if (!startupPolicy.ok) return startupPolicy;
  const startupTimeout =
    startupPolicy.value === undefined ? DEV_PREPARATION_TIMEOUT_MS : startupPolicy.value;
  const portProbe = createServer();
  await once(portProbe.listen(0, '127.0.0.1'), 'listening');
  const address = portProbe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose) => portProbe.close(() => resolveClose()));
  if (options.inProcess !== undefined) {
    const { inProcess, ...configuration } = options;
    inProcess.signal.throwIfAborted();
    const startup = new AbortController();
    return new Promise((resolveReady, rejectReady) => {
      const closed = runLiveDevDaemon(root, port, sessionPath(root, options.snapshot), {
        ...configuration,
        ...inProcess,
        signal: AbortSignal.any([inProcess.signal, startup.signal]),
        onReady: (status) => resolveReady(readyResult({ ok: true, value: publicStatus(status) })),
      });
      void closed.catch(rejectReady);
      try {
        inProcess.onStart?.(closed);
      } catch (error) {
        startup.abort(error);
        rejectReady(error);
      }
    });
  }
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      '--__forgeax-live-daemon',
      root,
      String(port),
      options.snapshot ? 'snapshot' : 'live',
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ...(options.headless === undefined
          ? {}
          : { FORGEAX_DEV_HEADLESS: String(options.headless) }),
        ...(options.backend === undefined ? {} : { FORGEAX_DEV_BACKEND: options.backend }),
        ...(options.workers === undefined
          ? {}
          : { FORGEAX_EXECUTION_WORKERS: JSON.stringify(options.workers) }),
        ...(options.animation === undefined
          ? {}
          : { FORGEAX_ANIMATION_PLAYBACK: JSON.stringify(animationPlayback(options.animation)) }),
        ...(options.rhiCapture === undefined
          ? {}
          : { FORGEAX_DEV_RHI_CAPTURE: options.rhiCapture ? '1' : '0' }),
      },
    },
  );
  child.unref();
  const file = sessionPath(root, options.snapshot);
  // Building the project child and opening the controlled Page are bounded by
  // the same startup path as an ordinary `project preview`; a cold SDK tree
  // can take longer than a short CLI polling window. Keep the daemon detached
  // while the caller waits for its terminal starting state.
  const deadline = startupTimeout === null ? Infinity : Date.now() + startupTimeout;
  while (Date.now() < deadline) {
    try {
      await access(file);
      const status = await liveDevStatus(root, options);
      if (
        status !== null &&
        typeof status === 'object' &&
        'value' in status &&
        status.value !== null &&
        typeof status.value === 'object' &&
        'phase' in status.value &&
        status.value.phase !== 'starting' &&
        status.value.phase !== 'waiting' &&
        status.value.phase !== 'reloading'
      ) {
        // A short status timeout cannot decide the longer startup of our own
        // still-live child. Other transport errors and replacement owners fail.
        let ownStartupTimeout = false;
        if (
          status.value.phase === 'unreachable' &&
          'error' in status.value &&
          status.value.error === LIVE_DEV_REQUEST_TIMEOUT &&
          child.pid !== undefined
        ) {
          const recorded = await readSession(root, options.snapshot).catch(() => undefined);
          if (recorded?.pid === child.pid && recorded.endpoint === `http://127.0.0.1:${port}`) {
            try {
              process.kill(child.pid, 0);
              ownStartupTimeout = true;
            } catch {
              // The recorded child exited; retain the original status failure.
            }
          }
        }
        if (!ownStartupTimeout) return readyResult(status);
      }
    } catch {
      // The daemon may not have published its session file yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LIVE_DEV_POLL_INTERVAL_MS));
  }
  return {
    ok: false,
    error: commandError(
      'live-start-timeout',
      'Startup did not finish before the deadline; dev status reports whether the owner is still running.',
    ),
  };
}

export async function removeLiveDevSession(
  rootInput: string,
  options: { readonly snapshot?: boolean } = {},
): Promise<void> {
  try {
    await unlink(sessionPath(resolve(rootInput), options.snapshot));
  } catch {
    // The service owns the session file and may remove it during shutdown.
  }
}
