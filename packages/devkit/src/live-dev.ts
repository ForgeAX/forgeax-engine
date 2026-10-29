import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
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
import { captureRenderFailure } from './capture-render-failure.js';
import { executionHealth } from './execution-health.js';
import { environmentExecutionWorkers } from './execution-workers.js';
import { failureSummary } from './failure-summary.js';
import { LIVE_BRIDGE_OWNER_PARAM, ownerPageUrl } from './live-bridge-url.js';
import {
  acquireStartLock,
  changedLiveOptions,
  exited,
  type LiveOwnerOptions,
  liveDaemonOrphans,
  liveDaemonProcess,
  liveDevBuildIdentity,
  processAlive,
  type RequestedOwnerOptions,
  terminateLiveDaemon,
  writeFileAtomic,
} from './live-dev-owner.js';
import {
  type LookDriver,
  LookRequestError,
  type LookResult,
  lookAtLive,
  parseLookRequest,
} from './live-look.js';
import { liveProjectReadyLogLine, readLiveProjectInputs } from './live-project-inputs.js';
import { createRunSnapshot, runStateDirectory } from './run-snapshot.js';
import { DEV_EXECUTION_TIMEOUT_MS, DEV_PREPARATION_TIMEOUT_MS } from './startup-budget.js';
import type {
  BrowserCarrierAdapter,
  BrowserCarrierRunIdentity,
  BrowserCarrierTarget,
  BrowserExecutionTarget,
} from './tools/display-carrier.js';
import type { CommandError, CommandResult } from './types.js';

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
  /** DevKit code identity; `dev start` replaces an owner from another build. */
  readonly build?: string;
  /** Normalized browser options; `dev start` replaces an owner on an explicit change. */
  readonly options?: LiveOwnerOptions;
}

interface LiveEvaluation {
  /** Its caller wait ended (`live-eval-continuing`); release depends on the realm returning. */
  continuing: boolean;
}

type LiveOperation =
  | 'status'
  | 'observe'
  | 'reload'
  | 'stop'
  | 'capture'
  | 'look'
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
  /**
   * The admitted evaluation that holds the realm (eval, RHI or profile
   * capture). Its object identity is the ownership token: only the request
   * that admitted it releases it, and reload/stop retire it.
   */
  evaluation: LiveEvaluation | undefined;
  server: ReturnType<typeof createServer> | undefined;
  bridgeServer: WebSocketServer | undefined;
  bridge: WebSocket | undefined;
  /** Minted per opened page; only the page this owner launched presents it. */
  bridgeToken: string;
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
  /** When the current page's App bridge closed without a reconnect yet. */
  bridgeLostAt?: number | undefined;
  /** Serializes session file writes so the last write carries the latest state. */
  sessionWrite?: Promise<void>;
  sessionWritten?: boolean;
}

// A first live launch may have to build the shader and Pack closure before
// Vite can publish its endpoint. Keep the caller's polling window aligned with
// the bounded project-process build timeout below instead of failing exactly
// when a cold, valid project becomes ready.
const LIVE_DEV_POLL_INTERVAL_MS = 100;
const LIVE_DEV_REQUEST_TIMEOUT = 'live-request-timeout: the owner did not respond';
// A runtime replacement after an edit rebuilds the project child and waits
// for the first frame. Commands absorb that self-resolving window instead of
// returning a not-ready failure that the caller can only poll around.
const LIVE_READY_WAIT_MS = 120_000;
/** Status error prefix for a startup failure that newer inputs replaced. */
const LIVE_STARTUP_SUPERSEDED = 'live-startup-superseded';

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

/** Keep the realm owner's diagnostic across the live command boundary. */
function operationError(error: unknown, code: string, hint: string): CommandError {
  const diagnostic =
    error !== null && typeof error === 'object'
      ? (error as Partial<Record<keyof CommandError, unknown>>)
      : undefined;
  return {
    code: typeof diagnostic?.code === 'string' ? diagnostic.code : code,
    expected:
      typeof diagnostic?.expected === 'string'
        ? diagnostic.expected
        : 'the live DevKit service to accept the request',
    hint: typeof diagnostic?.hint === 'string' ? diagnostic.hint : hint,
    detail:
      diagnostic?.detail !== null &&
      typeof diagnostic?.detail === 'object' &&
      !Array.isArray(diagnostic.detail)
        ? (diagnostic.detail as Record<string, unknown>)
        : {},
  };
}

/** The build identity of this DevKit, recorded by owners and compared by `dev start`. */
export function currentLiveDevBuild(): Promise<string> {
  return liveDevBuildIdentity(CLI_ENTRY);
}

function ownsSessionRecord(state: LiveDevDaemonState, recorded: unknown): boolean {
  const record = recorded as Partial<LiveDevSessionFile> | undefined;
  return record?.pid === state.status.pid && record.endpoint === state.status.endpoint;
}

async function writeSessionRecord(state: LiveDevDaemonState): Promise<void> {
  // A stopped owner never publishes again: its record would outlive it.
  if (isStopped(state)) return;
  if (state.sessionWritten) {
    const recorded = await readFile(state.sessionPath, 'utf8').then(
      (raw) => JSON.parse(raw) as unknown,
      () => undefined,
    );
    // Another owner replaced this one (or stop removed the record): never
    // overwrite it. A displaced owner releases its browser and project child.
    if (!ownsSessionRecord(state, recorded)) {
      if (!isStopped(state)) void stopLiveDaemon(state).catch(() => {});
      return;
    }
  }
  await writeFileAtomic(
    state.sessionPath,
    `${JSON.stringify({
      root: state.root,
      sessionPath: state.sessionPath,
      ...(state.controlToken ? { controlToken: state.controlToken } : {}),
      endpoint: state.status.endpoint,
      pid: state.status.pid,
      revision: state.status.revision,
      loadId: state.status.loadId,
      build: await currentLiveDevBuild(),
      options: {
        headless: state.status.headless,
        backend: state.status.backendRequested,
        rhiCapture: state.rhiCapture,
        workers: state.requestedWorkers ?? {},
        animation: state.animation,
      },
    } satisfies LiveDevSessionFile)}\n`,
  );
  state.sessionWritten = true;
}

function writeSessionFile(state: LiveDevDaemonState): Promise<void> {
  const next = (state.sessionWrite ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeSessionRecord(state));
  state.sessionWrite = next;
  return next;
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
        return (
          (document.querySelector('canvas')?.forgeaxFrameProgress?.submitted?.frameId ?? 0) > 0
        );
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
  return realm.evaluate(
    () => document.querySelector('canvas')?.forgeaxFrameProgress?.submitted?.frameId,
  );
}

async function waitForFrameAfter(
  session: BrowserCaptureSession,
  previous: number | undefined,
  timeoutMs = 120_000,
): Promise<void> {
  const realm: BrowserExecutionTarget['realm'] = session.execution?.realm ?? session.page;
  await realm.waitForFunction(
    (afterFrameId) => {
      return (
        (document.querySelector('canvas')?.forgeaxFrameProgress?.submitted?.frameId ?? 0) >
        afterFrameId
      );
    },
    previous ?? 0,
    { timeout: timeoutMs },
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
  switch (executionHealth(execution)) {
    case 'faulted':
      return commandError(
        'live-runtime-failed',
        'Repair the execution fault before verifying again.',
        {
          execution,
        },
      );
    case 'no-completed-frame':
      return commandError(
        'live-verification-unavailable',
        'No completed Engine frame has been observed.',
      );
    case 'healthy':
      return undefined;
  }
}

async function refreshFrameStatus(state: LiveDevDaemonState): Promise<void> {
  if (state.session === undefined) return;
  const frameId = await submittedFrameId(state.session);
  if (frameId !== undefined) state.status = { ...state.status, frameId };
}

// Close codes shared with packages/app/src/internal/browser-remote-bridge.ts.
const BRIDGE_NOT_OWNER_CLOSE = 4403;
const BRIDGE_DISPLACED_CLOSE = 4409;

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
      const failure = operationError(error, 'live-app-eval-failed', 'The App evaluation failed.');
      throw Object.assign(new Error(failure.hint), failure);
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

async function requireCurrentBridge(state: LiveDevDaemonState, reply: LiveReply): Promise<boolean> {
  try {
    if (isStopped(state)) {
      reply(409, {
        ok: false,
        error: commandError('live-not-running', 'The live owner stopped; run forgeax dev start.'),
      });
      return false;
    }
    if (!(await reconcileProjectInputs(state))) {
      reply(409, {
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
      reply(409, {
        ok: false,
        error: commandError('live-not-ready', 'Project inputs changed; wait for the new runtime.'),
      });
      return false;
    }
    if (state.status.phase === 'failed') {
      reply(409, {
        ok: false,
        error: commandError('live-not-ready', state.status.error ?? 'Project startup failed.'),
      });
      return false;
    }
    if (await refreshBridgeStatus(state)) return true;
  } catch (error) {
    reply(409, {
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
  reply(409, {
    ok: false,
    error: commandError(
      'live-app-bridge-unavailable',
      'The actual App execution realm is not connected; wait for dev status to report ready.',
    ),
  });
  return false;
}

type LiveReply = (status: number, value: unknown) => void;

interface LiveOutcome {
  readonly status: number;
  readonly value: unknown;
  /** True once the attempt observed or changed the live instance. */
  readonly admitted: boolean;
}

/** Observations: re-running one against the replacement runtime has no effect to duplicate. */
const LIVE_OBSERVATIONS: ReadonlySet<string> = new Set([
  'capture',
  'look',
  'verify',
  'rhi/capture',
  'profile/capture',
  'camera/get',
  'find',
]);
const LIVE_MUTATIONS: ReadonlySet<string> = new Set([
  'eval',
  'camera/set',
  'camera/release',
  'focus',
]);
/** Self-resolving rejections: a reload, a replaced World, or another request still running. */
const LIVE_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'live-not-ready',
  'live-instance-changed',
  'live-eval-running',
  'run-capture-busy',
  'live-app-bridge-unavailable',
  'live-app-bridge-disconnected',
  'live-reload-cancelled',
]);

function isWaitingOperation(operation: string): boolean {
  return LIVE_OBSERVATIONS.has(operation) || LIVE_MUTATIONS.has(operation);
}

function pinnedRevision(args: Record<string, unknown>): string | undefined {
  if (typeof args.revision === 'string') return args.revision;
  return typeof args.ref === 'string' ? args.ref.split('/')[0] : undefined;
}

function outcomeErrorCode(outcome: LiveOutcome): string | undefined {
  const value = outcome.value as { readonly ok?: unknown; readonly error?: { code?: unknown } };
  return value?.ok === false && typeof value.error?.code === 'string'
    ? value.error.code
    : undefined;
}

function outcomeErrorDetail(outcome: LiveOutcome): Record<string, unknown> | undefined {
  const value = outcome.value as { readonly error?: { detail?: unknown } };
  const detail = value?.error?.detail;
  return typeof detail === 'object' && detail !== null
    ? (detail as Record<string, unknown>)
    : undefined;
}

/**
 * A rejection is retried only when repeating it cannot duplicate an effect or
 * change its target: an unadmitted request never touched the instance, and an
 * admitted observation that names no revision targets "the current runtime".
 * A pinned revision is never re-targeted; its disappearance is
 * `live-revision-stale`.
 */
export function retryable(
  outcome: LiveOutcome,
  operation: string,
  args: Record<string, unknown>,
): boolean {
  const code = outcomeErrorCode(outcome);
  if (code === undefined || !LIVE_TRANSIENT_CODES.has(code)) return false;
  if (!outcome.admitted) return true;
  // A look that waited out the game's whole startup budget would only wait it again.
  if (outcomeErrorDetail(outcome)?.startupWaited === true) return false;
  return LIVE_OBSERVATIONS.has(operation) && pinnedRevision(args) === undefined;
}

/** Wait until the owner can admit a request, a pinned revision is gone, or waiting cannot help. */
async function awaitAdmissibleRuntime(
  state: LiveDevDaemonState,
  pinned: string | undefined,
  deadline: number,
  abandoned: () => boolean,
): Promise<'ready' | 'stale' | 'settled'> {
  // One reopen per request: a page that cannot keep a bridge ends at the deadline.
  let reopened = false;
  for (;;) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LIVE_DEV_POLL_INTERVAL_MS));
    if (abandoned() || isStopped(state)) return 'settled';
    if (pinned !== undefined && state.status.revision !== pinned) return 'stale';
    // An evaluation past its caller wait ends only when its realm returns.
    if (state.evaluation?.continuing === true) return 'settled';
    const replacing = state.reloadInFlight !== undefined || state.reloadRequested;
    if (!replacing && state.status.phase === 'failed') {
      // Unreadable inputs stay with the input poller and its duty budget.
      if (state.inputs === undefined) return 'settled';
      // Otherwise a failure is terminal unless its inputs changed;
      // reconciliation starts that replacement and the wait continues.
      if (await reconcileProjectInputs(state)) return 'settled';
    }
    if (!replacing) reopened = (await advanceWaitingBridge(state, reopened)) || reopened;
    if (
      !replacing &&
      state.status.phase === 'ready' &&
      state.evaluation === undefined &&
      !state.captureRunning
    )
      return 'ready';
    if (Date.now() >= deadline) return 'settled';
  }
}

/**
 * A page normally reconnects its bridge within a few seconds (1 s backoff).
 * A page that stays disconnected (closed, crashed, or navigated away) never
 * will; reopen it through the ordinary reload instead of waiting out the
 * caller's whole readiness budget. Reload reads the same inputs, so the
 * replacement serves the same project; pinned requests end as stale.
 */
const LIVE_BRIDGE_REOPEN_MS = 5_000;

/** Returns whether this call reopened the page. */
async function advanceWaitingBridge(
  state: LiveDevDaemonState,
  reopened: boolean,
): Promise<boolean> {
  // `waiting` advances to `ready` only through a bridge status refresh, as a
  // `dev status` probe would perform; one outstanding probe is enough.
  if (state.status.phase === 'waiting' && state.bridgePending.size === 0)
    await refreshBridgeStatus(state).catch(() => false);
  return !reopened && reopenLostBridge(state);
}

function reopenLostBridge(state: LiveDevDaemonState): boolean {
  if (state.bridgeLostAt === undefined || state.bridge !== undefined) return false;
  if (state.session === undefined || state.status.phase !== 'waiting') return false;
  if (Date.now() - state.bridgeLostAt < LIVE_BRIDGE_REOPEN_MS) return false;
  state.bridgeLostAt = undefined;
  void reloadSession(state).catch(() => undefined);
  return true;
}

function withWaited(outcome: LiveOutcome, waitedMs: number): LiveOutcome {
  const value = outcome.value as {
    readonly ok?: unknown;
    readonly value?: unknown;
    readonly error?: { readonly detail?: unknown };
  };
  if (value?.ok === true && value.value !== null && typeof value.value === 'object')
    return { ...outcome, value: { ...value, value: { ...value.value, waitedMs } } };
  if (value?.ok === false && value.error !== undefined) {
    const detail =
      value.error.detail !== null && typeof value.error.detail === 'object'
        ? value.error.detail
        : {};
    return {
      ...outcome,
      value: { ...value, error: { ...value.error, detail: { ...detail, waitedMs } } },
    };
  }
  return outcome;
}

/**
 * Run one live operation, absorbing self-resolving readiness states within
 * `budgetMs`. The final attempt after waiting reports the settled state with
 * the operation's own structured error.
 */
async function runWhenReady(
  state: LiveDevDaemonState,
  url: URL,
  operation: string,
  args: Record<string, unknown>,
  budgetMs: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<LiveOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;
  let closed = false;
  // A caller that disconnected must not have its request admitted later.
  const onClose = () => {
    closed = true;
  };
  response.once('close', onClose);
  try {
    const abandoned = () => closed;
    const remaining = () => Math.max(0, deadline - Date.now());
    let outcome = await runLiveOperation(
      state,
      url,
      args,
      request,
      response,
      abandoned,
      remaining(),
    );
    let waited = false;
    while (budgetMs > 0 && retryable(outcome, operation, args)) {
      waited = true;
      const settled = await awaitAdmissibleRuntime(
        state,
        pinnedRevision(args),
        deadline,
        abandoned,
      );
      if (closed) return outcome;
      if (settled === 'stale') {
        outcome = {
          status: 409,
          admitted: false,
          value: {
            ok: false,
            error: commandError(
              'live-revision-stale',
              'The runtime was replaced while this request waited; inspect the current runtime before repeating it.',
              { revision: state.status.revision },
            ),
          },
        };
        break;
      }
      outcome = await runLiveOperation(state, url, args, request, response, abandoned, remaining());
      if (settled === 'settled' || Date.now() >= deadline) break;
    }
    return waited ? withWaited(outcome, Date.now() - startedAt) : outcome;
  } finally {
    response.off('close', onClose);
  }
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
    bridgeServer.handleUpgrade(request, socket, head, (client) => {
      // Every page the project's Vite serves dials this relay. Only the owner
      // page may replace the bridge; others are told once and keep running.
      if (url.searchParams.get(LIVE_BRIDGE_OWNER_PARAM) !== state.bridgeToken) {
        client.close(BRIDGE_NOT_OWNER_CLOSE, 'live-bridge-not-owner');
        return;
      }
      bridgeServer.emit('connection', client, request);
    });
  });
  bridgeServer.on('connection', (client: WebSocket) => {
    // A newer owner page (same token) takes over for good: the displaced page
    // must not retry, and its close handler no longer owns the pending calls.
    if (state.bridge !== undefined) {
      state.bridge.close(BRIDGE_DISPLACED_CLOSE, 'live-bridge-displaced');
      rejectBridgePending(
        state,
        bridgeError(
          'live-app-bridge-disconnected',
          'A newer owner page replaced the App execution bridge.',
        ),
      );
    }
    state.bridge = client;
    state.bridgeLostAt = undefined;
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
      state.bridgeLostAt = Date.now();
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

function liveArtifactDirectory(revision: string): string {
  return resolve(
    process.env.XDG_DATA_HOME ??
      (process.platform === 'darwin'
        ? resolve(homedir(), 'Library/Application Support')
        : process.platform === 'win32'
          ? (process.env.LOCALAPPDATA ?? resolve(homedir(), 'AppData/Local'))
          : resolve(homedir(), '.local/share')),
    'ForgeaX/artifacts',
    revision,
  );
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
    // Keep a superseded predecessor's cause visible until this generation is ready.
    error: state.status.error?.startsWith(LIVE_STARTUP_SUPERSEDED) ? state.status.error : undefined,
  };
  await writeSessionFile(state);
  try {
    await replaceProjectProcess(state, state.status.generation);
    if (stopped()) return;
    const { createBrowserCapture } = await import('./browser-capture.js');
    if (stopped()) return;
    // A reload opens its replacement page in the same warm browser.
    state.browser ??= createBrowserCapture(state.executionRoot, { retainBrowser: true });
    state.bridgeToken = randomUUID();
    // Only a bridge this new page opened and then lost is reopened.
    state.bridgeLostAt = undefined;
    state.session = await state.browser.open({
      backend: state.status.backendRequested,
      headless: state.status.headless,
      launchProfile: 'development',
      ...ciCaptureViewport(),
      outputDir: liveArtifactDirectory(revision),
      ...(state.projectUrl === undefined
        ? {}
        : { serverUrl: ownerPageUrl(state.projectUrl, state.bridgeToken) }),
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
        error: undefined,
        url: state.session.url,
        frameId: await submittedFrameId(state.session),
      };
    }
  } catch (error) {
    await stopProjectProcess(state);
    if (stopped()) return;
    if (await inputsSuperseded(state)) {
      // An edit saved during this generation's startup (for example while its
      // plugins compiled) supersedes the failure. The surrounding reload loop
      // starts the latest inputs; publishing `failed` first would make callers
      // treat a self-resolving state as terminal.
      state.reloadRequested = true;
      state.status = {
        ...state.status,
        phase: 'reloading',
        error: `${LIVE_STARTUP_SUPERSEDED}: ${error instanceof Error ? error.message : String(error)}`,
      };
      await writeSessionFile(state);
      return;
    }
    state.status = {
      ...state.status,
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeSessionFile(state);
}

async function inputsSuperseded(state: LiveDevDaemonState): Promise<boolean> {
  if (state.snapshot || state.inputs === undefined) return false;
  try {
    const latest = await checkProjectInputs(state);
    return !isStopped(state) && latest !== state.inputs;
  } catch {
    // Unreadable inputs keep the original startup failure; the input poller
    // reports and retries them through its existing owner.
    return false;
  }
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
  state.evaluation = undefined;
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
    // Wait for the exit after SIGKILL as well, so a replacement can bind the
    // released Vite port; the final bound covers a process that never reports.
    let timer = setTimeout(() => {
      child.kill('SIGKILL');
      timer = setTimeout(resolveStop, 1_000);
      timer.unref();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function loopbackPortFree(port: number): Promise<boolean> {
  const probe = createServer();
  try {
    await once(probe.listen(port, '127.0.0.1'), 'listening');
  } catch {
    return false;
  }
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return true;
}

/**
 * A replacement generation keeps the previous Vite port, so open tabs and
 * scripts hold one URL for the life of this dev owner. The port is yielded to
 * an OS-assigned one when another listener has taken it meanwhile.
 */
async function replacementProjectPort(previousUrl: string | undefined): Promise<number> {
  const port = previousUrl === undefined ? 0 : Number(new URL(previousUrl).port);
  if (!Number.isSafeInteger(port) || port <= 0) return 0;
  return (await loopbackPortFree(port)) ? port : 0;
}

/**
 * A strict Vite listen reports a held port as `Port N is already in use`; a
 * raw socket error carries `EADDRINUSE`. Both reach the child as the
 * CommandError's `detail.reason` (commandError) or its hint.
 */
function isAddressInUse(error: CommandError, port: number): boolean {
  const detail = error.detail as { readonly reason?: unknown } | undefined;
  const text = `${typeof detail?.reason === 'string' ? detail.reason : ''}\n${error.hint}`;
  return text.includes(`Port ${port} is already in use`) || /\bEADDRINUSE\b/.test(text);
}

/**
 * @internal Start the project backend on a reused port. Vite binds it strictly
 * seconds after the daemon's probe, so another listener can still take it; an
 * address-in-use failure then retries once on an OS-assigned port instead of
 * failing the generation. Every other failure (configuration, plugin, timeout)
 * is returned unchanged so it is neither repeated nor hidden.
 */
export async function startOnPreferredPort<T>(
  port: number,
  start: (port: number) => Promise<CommandResult<T>>,
): Promise<CommandResult<T>> {
  const first = await start(port);
  if (first.ok || port === 0 || !isAddressInUse(first.error, port)) return first;
  process.stderr.write(`live project: port ${port} was taken; using an OS-assigned port\n`);
  return start(0);
}

async function replaceProjectProcess(state: LiveDevDaemonState, generation: number): Promise<void> {
  await stopProjectProcess(state);
  const projectPort = await replacementProjectPort(state.projectUrl);
  const child = spawn(
    process.execPath,
    // The daemon owns the control endpoint, while the project child owns the
    // Vite endpoint. The first generation is OS-assigned so an unrelated 5173
    // listener cannot hold a live session in starting/failed state. The project
    // host materializes port 0 before asking Vite to listen and reports its
    // actual URL back through the ready line; later generations reuse it.
    [
      state.snapshot
        ? resolve(state.executionRoot, 'node_modules/@forgeax/engine/dist/bin/forgeax.mjs')
        : CLI_ENTRY,
      '--__forgeax-live-project',
      state.executionRoot,
      String(generation),
      String(projectPort),
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
  let output = '';
  child.once('close', () => {
    if (output.length > 0) log.write(output);
    log.end();
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    // A cold SDK tree may need to build the shader and asset closure before Vite
    // can publish its ready line. The persistent service owns that work, so a
    // short CLI-style deadline would turn a healthy cold start into a false
    // failed instance. Keep the bound finite while allowing one cold build.
    const timer = setTimeout(() => {
      // Keep an unterminated diagnostic fragment as evidence of the hang.
      if (output.length > 0) log.write(`${output}\n`);
      output = '';
      rejectReady(new Error('live project backend build timed out'));
    }, 300_000);
    let settled = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const lines = output.split('\n');
      output = lines.pop() ?? '';
      for (const line of lines) {
        let result:
          | {
              readonly ready?: boolean;
              readonly error?: string;
              readonly generation?: number;
              readonly url?: string;
              readonly inputPaths?: readonly string[];
              readonly inputVersion?: string;
            }
          | undefined;
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed !== null && typeof parsed === 'object') result = parsed as typeof result;
        } catch {
          // Preserve non-JSON build diagnostics until a structured terminal line.
        }
        log.write(
          `${result?.inputPaths === undefined ? line : liveProjectReadyLogLine(state.executionRoot, result, state.snapshot ? undefined : state.projectInputPaths)}\n`,
        );
        if (result === undefined || settled) continue;
        if (result.ready === true && result.generation === generation) {
          settled = true;
          clearTimeout(timer);
          state.projectUrl = result.url;
          if (!state.snapshot && result.inputPaths && result.inputVersion) {
            state.projectInputPaths = result.inputPaths;
            state.inputs = result.inputVersion;
          }
          resolveReady();
        } else if (result.error !== undefined) {
          settled = true;
          clearTimeout(timer);
          rejectReady(new Error(result.error));
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
        return startOnPreferredPort(projectPort, (port) =>
          startDevProjectWithHost(
            {
              root,
              json: true,
              port,
              // Children of one owner run one at a time; see startDevProjectWithHost.
              reuse: {
                generatedRoot: resolve(root, '.forgeax/generated/dev'),
                viteCacheDir: resolve(root, '.forgeax/dev/vite'),
              },
            },
            (paths) => {
              inputPaths = paths;
            },
          ),
        );
      })
    : facts;
  if (!built.ok) {
    process.stderr.write(`${JSON.stringify(built.error)}\n`);
    process.stdout.write(
      `${JSON.stringify({ error: `${failureSummary(built.error)}; inspect ${resolve(root, '.forgeax/dev.log')}`, generation })}\n`,
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

function respondObservation(state: LiveDevDaemonState, response: ServerResponse): void {
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
}

async function respondStatus(state: LiveDevDaemonState, response: ServerResponse): Promise<void> {
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
    respondObservation(state, response);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/status') {
    await respondStatus(state, response);
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
  const operation = url.pathname.slice(1);
  if (!isWaitingOperation(operation)) {
    const outcome = await runLiveOperation(state, url, {}, request, response);
    jsonResponse(response, outcome.status, outcome.value);
    return;
  }
  let input: Record<string, unknown>;
  try {
    const parsed = await body(request);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      jsonResponse(response, 400, {
        ok: false,
        error: commandError('tool-invalid-args', 'Send the operation arguments as a JSON object.'),
      });
      return;
    }
    input = parsed as Record<string, unknown>;
  } catch (error) {
    jsonResponse(response, 400, {
      ok: false,
      error: commandError(
        'live-operation-failed',
        error instanceof Error ? error.message : String(error),
      ),
    });
    return;
  }
  const { readyTimeoutMs, ...args } = input;
  if (
    readyTimeoutMs !== undefined &&
    (typeof readyTimeoutMs !== 'number' ||
      !Number.isSafeInteger(readyTimeoutMs) ||
      readyTimeoutMs < 0)
  ) {
    jsonResponse(response, 400, {
      ok: false,
      error: commandError(
        'live-invalid-timeout',
        'readyTimeoutMs must be a non-negative integer; 0 disables waiting.',
      ),
    });
    return;
  }
  const outcome = await runWhenReady(
    state,
    url,
    operation,
    args,
    readyTimeoutMs ?? LIVE_READY_WAIT_MS,
    request,
    response,
  );
  jsonResponse(response, outcome.status, outcome.value);
}

async function runLiveOperation(
  state: LiveDevDaemonState,
  url: URL,
  input: Record<string, unknown>,
  request: IncomingMessage,
  response: ServerResponse,
  abandoned: () => boolean = () => false,
  startupWaitMs?: number,
): Promise<LiveOutcome> {
  const attempt: LiveAttempt = {
    outcome: undefined,
    admitted: false,
    abandoned,
    ...(startupWaitMs === undefined ? {} : { startupWaitMs }),
  };
  await routeLiveOperation(state, url, input, request, response, attempt);
  return {
    ...(attempt.outcome ?? {
      status: 500,
      value: {
        ok: false,
        error: commandError('live-operation-failed', 'The live owner produced no response.'),
      },
    }),
    admitted: attempt.admitted,
  };
}

interface LiveAttempt {
  outcome: { readonly status: number; readonly value: unknown } | undefined;
  /** Set at the first effect on the live instance; only unadmitted mutations may be retried. */
  admitted: boolean;
  /** The caller disconnected; nothing may be admitted for it any more. */
  readonly abandoned: () => boolean;
  /** What is left of the caller's ready budget; a look spends it waiting out a startup overlay. */
  readonly startupWaitMs?: number;
}

/** Routes write their single response through `reply` and return early. */
function boundedCaptureLimit(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function captureResponseError(result: unknown, code: string, hint: string): unknown {
  if (result !== null && typeof result === 'object' && Reflect.get(result, 'error') !== undefined)
    return Reflect.get(result, 'error');
  return commandError(code, hint);
}

function sameLiveInstance(before: LiveDevStatus, after: LiveDevStatus): boolean {
  return (
    before.revision === after.revision &&
    before.loadId === after.loadId &&
    before.worldIdentity === after.worldIdentity
  );
}

function lookDriver(
  state: LiveDevDaemonState,
  session: BrowserCaptureSession,
  outputDir: string,
): LookDriver {
  const camera = async (script: string): Promise<unknown> =>
    bridgeCall(state, script, 5_000).promise;
  return {
    execution: session.execution ?? { kind: 'page', ownerPage: session.page, realm: session.page },
    outputDir,
    nextFrame: async (timeoutMs) =>
      waitForFrameAfter(session, await submittedFrameId(session), timeoutMs),
    cameraControl: async () => {
      const value = (await camera('return simulation.observation?.camera.get();')) as {
        readonly control?: unknown;
      } | null;
      return value?.control === 'observer' ? 'observer' : 'game';
    },
    setCamera: async (preset) => {
      const { name: _name, ...pose } = preset;
      await camera(`return simulation.observation?.camera.set(${JSON.stringify(pose)});`);
    },
    releaseCamera: async () => {
      await camera('simulation.observation?.release();');
    },
  };
}

function lookResponse(
  status: LiveDevStatus,
  look: LookResult,
  session: BrowserCaptureSession,
  elapsedMs: number,
): unknown {
  const report = session.report();
  return {
    ok: true,
    artifacts: look.views.map((view) => ({
      kind: 'png',
      uri: view.screenshot,
      mediaType: 'image/png',
      digest: view.digest,
    })),
    value: {
      revision: status.revision,
      frameId: status.frameId,
      elapsedMs,
      views: look.views.map(({ name, screenshot, metrics, findings }) => ({
        name,
        screenshot,
        metrics,
        findings,
      })),
      ...(look.rendererError === null ? {} : { rendererError: look.rendererError }),
      errors: { console: report.consoleErrors.length, page: report.pageErrors.length },
    },
  };
}

async function routeLiveOperation(
  state: LiveDevDaemonState,
  url: URL,
  input: Record<string, unknown>,
  request: IncomingMessage,
  response: ServerResponse,
  attempt: LiveAttempt,
): Promise<void> {
  const reply: LiveReply = (status, value) => {
    attempt.outcome = { status, value };
  };
  // Every admission point follows awaits, so re-check the caller right before it.
  const admit = (): boolean => {
    if (attempt.abandoned()) {
      reply(409, {
        ok: false,
        error: commandError(
          'live-request-abandoned',
          'The caller disconnected before the request was admitted.',
        ),
      });
      return false;
    }
    attempt.admitted = true;
    return true;
  };
  let evaluation: LiveEvaluation | undefined;
  let profileCaptureId: string | undefined;
  let profileCaptureWorldIdentity: string | undefined;
  let revokeLeaseForRequest: (() => void) | undefined;
  /** Release only this request's evaluation; a replaced World keeps the same owner. */
  const releaseEvaluation = (owned: LiveEvaluation | undefined): boolean => {
    if (owned === undefined || state.evaluation !== owned) return false;
    state.evaluation = undefined;
    state.status = { ...state.status, unfinishedEval: false };
    return true;
  };
  const clearEvalState = async (): Promise<void> => {
    const owned = evaluation;
    evaluation = undefined;
    if (!releaseEvaluation(owned)) return;
    state.status = { ...state.status, unfinishedEval: false };
    await writeSessionFile(state);
  };
  async function captureRhi(): Promise<void> {
    if (state.evaluation !== undefined) {
      reply(409, {
        ok: false,
        error: commandError(
          'live-eval-running',
          'RHI capture is blocked until the current evaluation completes.',
        ),
      });
      return;
    }
    const args = input;
    if (!(await requireCurrentBridge(state, reply))) return;
    const before = state.status;
    const identityError = assertLiveIdentity(state, args);
    if (identityError !== undefined) {
      reply(409, { ok: false, error: identityError });
      return;
    }
    if (state.session === undefined || before.phase !== 'ready') {
      reply(409, {
        ok: false,
        error: commandError(
          'live-not-ready',
          'Wait for the live instance to reach a submitted frame.',
        ),
      });
      return;
    }
    const runId = `live-rhi-${randomUUID()}`;
    if (!admit()) return;
    evaluation = { continuing: false };
    state.evaluation = evaluation;
    state.status = { ...state.status, unfinishedEval: true };
    await writeSessionFile(state);
    try {
      const captured = await bridgeEval(state, rhiCaptureScript(runId), 120_000);
      if (
        captured === null ||
        typeof captured !== 'object' ||
        Reflect.get(captured, 'ok') !== true
      ) {
        const error = captureResponseError(
          captured,
          'capture-unavailable',
          'The live App did not return an RHI tape.',
        );
        reply(409, { ok: false, error });
        return;
      }
      if (!(await requireCurrentBridge(state, reply))) return;
      const after = state.status;
      if (
        before.revision !== after.revision ||
        before.loadId !== after.loadId ||
        before.worldIdentity !== after.worldIdentity
      ) {
        reply(409, {
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
        reply(500, {
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
      reply(200, {
        ok: true,
        value: { revision: after.revision, frameId: after.frameId, ...artifact },
      });
      return;
    } finally {
      await clearEvalState();
    }
  }

  async function captureImage(): Promise<void> {
    const verifying = url.pathname === '/verify';
    if (state.captureRunning) {
      reply(409, {
        ok: false,
        error: commandError('run-capture-busy', 'Wait for the current capture.'),
      });
      return;
    }
    state.captureRunning = true;
    await state.observationInFlight;
    try {
      if (state.evaluation !== undefined) {
        reply(409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'Capture is blocked until the current evaluation completes.',
          ),
        });
        return;
      }
      const args = input as {
        readonly output?: unknown;
        readonly checkpoint?: unknown;
        readonly requireUi?: boolean;
        readonly revision?: unknown;
        readonly timeoutMs?: number;
      };
      function validCaptureArgs(): boolean {
        // Without a revision, verify checks whichever execution is current; the
        // before/after identity check below still rejects a change during capture.
        if (
          verifying &&
          args.timeoutMs !== undefined &&
          (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1)
        ) {
          reply(400, {
            ok: false,
            error: commandError(
              'live-invalid-timeout',
              'Verification timeoutMs must be a positive integer.',
            ),
          });
          return false;
        }
        return true;
      }
      if (!validCaptureArgs()) return;
      if (!(await requireCurrentBridge(state, reply))) return;
      await refreshFrameStatus(state);
      const before = state.status;
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        reply(409, { ok: false, error: identityError });
        return;
      }
      if (state.session === undefined || before.phase !== 'ready') {
        reply(409, {
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
        reply(409, { ok: false, error: healthError });
        return;
      }
      // Fail before entering the 120s compositor wait when the project has no
      // renderable camera. Capture is an observation of the live World, so the
      // realm's structured camera error is the honest terminal result.
      async function captureCameraReady(): Promise<boolean> {
        try {
          await bridgeCall(state, 'return simulation.observation?.camera.get();', 5_000).promise;
        } catch (error) {
          reply(409, {
            ok: false,
            error: operationError(
              error,
              'live-camera-unavailable',
              error instanceof Error ? error.message : 'The live World has no active camera.',
            ),
          });
          return false;
        }
        return true;
      }
      if (!(await captureCameraReady())) return;
      if (!admit()) return;
      function imageOptions() {
        return {
          purpose: verifying ? ('validate' as const) : ('observe' as const),
          ...(verifying && before.frameId !== undefined ? { afterFrameId: before.frameId } : {}),
          ...(verifying && args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
          ...(args.requireUi === undefined ? {} : { requireUi: args.requireUi }),
          ...(typeof args.output === 'string' ? { output: args.output } : {}),
        };
      }
      const record = await state.session.capture(
        typeof args.checkpoint === 'string' ? args.checkpoint : undefined,
        imageOptions(),
      );
      if (!(await requireCurrentBridge(state, reply))) return;
      await refreshFrameStatus(state);
      const after = state.status;
      if (
        before.revision !== after.revision ||
        before.loadId !== after.loadId ||
        before.worldIdentity !== after.worldIdentity
      ) {
        reply(409, {
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
        reply(409, { ok: false, error: finalHealthError });
        return;
      }
      const session = state.session;
      await publishImageResult();
      async function publishImageResult(): Promise<void> {
        const report = session.report();
        const renderFailure = captureRenderFailure(record);
        const reportPath = `${record.output}.json`;
        const reportBytes = `${JSON.stringify({ revision: after.revision, ...(verifying ? { execution: after.execution } : {}), record, consoleErrors: report.consoleErrors, pageErrors: report.pageErrors }, null, 2)}\n`;
        await writeFile(reportPath, reportBytes, 'utf8');
        if (
          verifying &&
          (!record.ok || report.consoleErrors.length > 0 || report.pageErrors.length > 0)
        ) {
          reply(409, {
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
        reply(200, {
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
              rendered: renderFailure === undefined,
              ...(renderFailure === undefined ? {} : { reason: renderFailure.reason }),
            },
            ...(renderFailure === undefined ? {} : { hint: renderFailure.hint }),
            ...(record.runtime.rendererError === null
              ? {}
              : { rendererError: record.runtime.rendererError }),
            errors: { console: report.consoleErrors.length, page: report.pageErrors.length },
          },
        });
        return;
      }
    } finally {
      state.captureRunning = false;
    }
  }

  /** `dev look`: views of the current revision with an automatic visual report. */
  async function captureLook(): Promise<void> {
    if (state.captureRunning) {
      reply(409, {
        ok: false,
        error: commandError('run-capture-busy', 'Wait for the current capture.'),
      });
      return;
    }
    state.captureRunning = true;
    await state.observationInFlight;
    try {
      const startedAt = Date.now();
      if (state.evaluation !== undefined) {
        reply(409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'Look is blocked until the current evaluation completes.',
          ),
        });
        return;
      }
      const request = parseLookRequest(input);
      if (!(await requireCurrentBridge(state, reply))) return;
      await refreshFrameStatus(state);
      const before = state.status;
      const identityError = assertLiveIdentity(state, input);
      if (identityError !== undefined) {
        reply(409, { ok: false, error: identityError });
        return;
      }
      const session = state.session;
      if (session === undefined || before.phase !== 'ready') {
        reply(409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      if (!admit()) return;
      const outputDir =
        typeof input.output === 'string'
          ? resolve(state.root, input.output)
          : resolve(liveArtifactDirectory(before.revision), `look-${Date.now()}`);
      const look = await lookAtLive(
        lookDriver(state, session, outputDir),
        request,
        undefined,
        attempt.startupWaitMs,
      );
      if (!(await requireCurrentBridge(state, reply))) return;
      await refreshFrameStatus(state);
      if (!sameLiveInstance(before, state.status)) {
        reply(409, {
          ok: false,
          error: commandError(
            'live-instance-changed',
            'The live instance changed while looking; look again at the new revision.',
          ),
        });
        return;
      }
      reply(200, lookResponse(state.status, look, session, Date.now() - startedAt));
    } catch (error) {
      if (!(error instanceof LookRequestError)) throw error;
      reply(400, { ok: false, error: commandError(error.code, error.hint) });
    } finally {
      state.captureRunning = false;
    }
  }

  async function applyObservation(): Promise<void> {
    if (state.evaluation !== undefined) {
      reply(409, {
        ok: false,
        error: commandError(
          'live-eval-running',
          'Observation mutation is blocked until the current evaluation completes.',
        ),
      });
      return;
    }
    if (state.session === undefined) {
      reply(409, {
        ok: false,
        error: commandError(
          'live-not-ready',
          'Wait for the live instance to reach a submitted frame.',
        ),
      });
      return;
    }
    const args = input;
    if (!(await requireCurrentBridge(state, reply))) return;
    if (state.status.phase !== 'ready') {
      reply(409, {
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
      reply(409, { ok: false, error: identityError });
      return;
    }
    if (
      url.pathname === '/focus' &&
      (typeof args.name === 'string') === (typeof args.ref === 'string')
    ) {
      reply(400, {
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
    if (!admit()) return;
    const result = await bridgeEval(state, script);
    if (operation !== 'camera/get' && operation !== 'find')
      await waitForFrameAfter(state.session, before.frameId);
    if (!(await requireCurrentBridge(state, reply))) return;
    await refreshFrameStatus(state);
    if (
      before.revision !== state.status.revision ||
      before.loadId !== state.status.loadId ||
      before.worldIdentity !== state.status.worldIdentity
    ) {
      reply(409, {
        ok: false,
        error: commandError(
          'live-instance-changed',
          'The live instance or World changed while applying the camera operation; retry against the new status.',
        ),
      });
      return;
    }
    reply(200, {
      ok: true,
      value: {
        revision: state.status.revision,
        frameId: state.status.frameId,
        ...observationValue(result, state.status.revision),
      },
    });
    return;
  }

  async function captureProfile(): Promise<void> {
    if (state.evaluation !== undefined) {
      reply(409, {
        ok: false,
        error: commandError('live-eval-running', 'Profile capture is already running.'),
      });
      return;
    }
    const args = input;
    if (!(await requireCurrentBridge(state, reply))) return;
    const before = state.status;
    const identityError = assertLiveIdentity(state, args);
    if (identityError !== undefined) {
      reply(409, { ok: false, error: identityError });
      return;
    }
    if (state.session === undefined || before.phase !== 'ready') {
      reply(409, {
        ok: false,
        error: commandError(
          'live-not-ready',
          'Wait for the live instance to reach a submitted frame.',
        ),
      });
      return;
    }
    const frameLimit = boundedCaptureLimit(args.frameLimit, 1, 120, 30);
    const eventLimit = boundedCaptureLimit(args.eventLimit, 64, 20_000, 4_096);
    if (!admit()) return;
    evaluation = { continuing: false };
    state.evaluation = evaluation;
    profileCaptureWorldIdentity = before.worldIdentity;
    state.status = { ...state.status, unfinishedEval: true };
    await writeSessionFile(state);
    const clearProfileState = async (): Promise<void> => {
      const owned = evaluation;
      evaluation = undefined;
      if (releaseEvaluation(owned)) await writeSessionFile(state);
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
      const error = captureResponseError(
        started,
        'profile-capture-unavailable',
        'The live App did not start profiling.',
      );
      reply(409, { ok: false, error });
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
    if (!(await requireCurrentBridge(state, reply))) {
      await clearProfileState();
      return;
    }
    const after = state.status;
    if (
      before.revision !== after.revision ||
      before.loadId !== after.loadId ||
      before.worldIdentity !== after.worldIdentity
    ) {
      reply(409, {
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
    reply(200, {
      ok: true,
      value: {
        revision: after.revision,
        captureId: Reflect.get(capture, 'captureId'),
        artifact: { kind: 'profile-capture', uri: output, path: output, digest },
      },
    });
    return;
  }

  async function evaluate(): Promise<void> {
    const args = input as {
      readonly code?: unknown;
      readonly timeoutMs?: unknown;
      readonly revision?: unknown;
      readonly lease?: unknown;
    };
    if (typeof args.revision !== 'string') {
      reply(400, {
        ok: false,
        error: commandError(
          'live-revision-required',
          'Pass --revision from dev status before evaluating code.',
        ),
      });
      return;
    }
    if (typeof args.code !== 'string' || args.code.trim().length === 0) {
      reply(400, {
        ok: false,
        error: commandError(
          'live-invalid-eval',
          'Provide a non-empty JavaScript expression in code.',
        ),
      });
      return;
    }
    if (state.evaluation !== undefined) {
      reply(409, {
        ok: false,
        error: commandError(
          'live-eval-running',
          'Only status, reload, and stop are available while eval is running.',
        ),
      });
      return;
    }
    if (state.session === undefined) {
      reply(409, {
        ok: false,
        error: commandError(
          'live-not-ready',
          'Wait for the live instance to reach a submitted frame.',
        ),
      });
      return;
    }
    if (!(await requireCurrentBridge(state, reply))) return;
    if (state.status.phase !== 'ready') {
      reply(409, {
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
      reply(409, { ok: false, error: identityError });
      return;
    }
    if (!admit()) return;
    evaluation = { continuing: false };
    state.evaluation = evaluation;
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
    const evaluationResult = evaluationCall.promise;
    const timed = await Promise.race([
      evaluationResult.then((value) => ({ state: 'completed' as const, value })),
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
        void evaluationResult.catch(() => {});
        if (!admitted) {
          finishLease();
          releaseEvaluation(evaluation);
          evaluation = undefined;
          await writeSessionFile(state);
          reply(409, {
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
      reply(408, {
        ok: false,
        error: commandError(
          'live-eval-continuing',
          'The caller wait ended; the owner still tracks the evaluation.',
          { continuing: true, revision: before.revision },
        ),
      });
      const continuing = evaluation;
      if (continuing !== undefined) continuing.continuing = true;
      // This request no longer releases it on exit; the realm's return does.
      evaluation = undefined;
      const release = () => {
        finishLease();
        if (releaseEvaluation(continuing)) void writeSessionFile(state);
      };
      void evaluationResult.then(release, release);
      return;
    }
    finishLease();
    releaseEvaluation(evaluation);
    evaluation = undefined;
    if (!(await requireCurrentBridge(state, reply))) return;
    await writeSessionFile(state);
    reply(200, {
      ok: true,
      value: { revision: before.revision, result: timed.value },
    });
    return;
  }

  function replyOperationFailure(error: unknown): void {
    reply(500, {
      ok: false,
      error: operationError(
        error,
        'live-operation-failed',
        error instanceof Error ? error.message : String(error),
      ),
    });
  }

  try {
    if (url.pathname === '/reload') {
      await reloadSession(state);
      reply(
        state.status.phase === 'ready' ? 200 : 409,
        readyResult({ ok: true, value: publicStatus(state.status) }),
      );
      return;
    }
    if (url.pathname === '/stop') {
      await stopLiveDaemon(state);
      reply(200, { ok: true, value: publicStatus(state.status) });
      return;
    }
    if (url.pathname === '/rhi/capture') {
      await captureRhi();
      return;
    }
    if (url.pathname === '/capture' || url.pathname === '/verify') {
      await captureImage();
      return;
    }
    if (url.pathname === '/look') {
      await captureLook();
      return;
    }
    if (
      url.pathname === '/camera/get' ||
      url.pathname === '/camera/set' ||
      url.pathname === '/camera/release' ||
      url.pathname === '/find' ||
      url.pathname === '/focus'
    ) {
      await applyObservation();
      return;
    }
    if (url.pathname === '/profile/capture') {
      await captureProfile();
      return;
    }
    if (url.pathname === '/eval') {
      await evaluate();
      return;
    }
    reply(404, {
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
    if (releaseEvaluation(evaluation)) void writeSessionFile(state);
    evaluation = undefined;
    replyOperationFailure(error);
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
        state.evaluation === undefined &&
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
    state.evaluation = undefined;
    state.status = { ...state.status, unfinishedEval: false };
    const failures: unknown[] = [];
    const release = async (cleanup: () => unknown | Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    };
    // Let queued record writes finish first; the owner check below removes the record.
    await release(() => state.sessionWrite);
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
    evaluation: undefined,
    server: undefined,
    bridgeServer: undefined,
    bridge: undefined,
    bridgeToken: randomUUID(),
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
  timeoutMs?: number,
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
    const readyTimeoutMs =
      value !== null &&
      typeof value === 'object' &&
      typeof Reflect.get(value, 'readyTimeoutMs') === 'number'
        ? (Reflect.get(value, 'readyTimeoutMs') as number)
        : LIVE_READY_WAIT_MS;
    request.setTimeout(timeoutMs ?? (path === '/status' ? 5_000 : 330_000 + readyTimeoutMs), () =>
      request.destroy(new Error(LIVE_DEV_REQUEST_TIMEOUT)),
    );
    request.on('error', rejectResponse);
    if (value !== undefined) request.write(JSON.stringify(value));
    request.end();
  });
}

type SessionRecord =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'record'; readonly session: LiveDevSessionFile };

function validSessionRecord(value: unknown): value is LiveDevSessionFile {
  const record = value as Partial<LiveDevSessionFile> | null;
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.endpoint === 'string' &&
    Number.isSafeInteger(record.pid)
  );
}

/** Records are written atomically; an unreadable one is debris from a crash or an older writer. */
async function readSessionRecord(root: string, snapshot = false): Promise<SessionRecord> {
  let error = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    let raw: string;
    try {
      raw = await readFile(sessionPath(root, snapshot), 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
      throw cause;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      if (validSessionRecord(value)) return { kind: 'record', session: value };
      error = 'live-session-invalid: the owner record has no endpoint';
    } catch (cause) {
      error = `live-session-invalid: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }
  return { kind: 'invalid', error };
}

/** Remove a record only while it still names the given owner (or any unreadable record). */
async function removeSessionRecord(
  root: string,
  snapshot: boolean,
  expected: LiveDevSessionFile | undefined,
): Promise<void> {
  const current = await readSessionRecord(root, snapshot);
  if (current.kind === 'none') return;
  if (
    current.kind === 'record' &&
    (expected === undefined ||
      current.session.pid !== expected.pid ||
      current.session.endpoint !== expected.endpoint)
  )
    return;
  await removeLiveDevSession(root, { snapshot });
}

function stoppedResult(root: string) {
  return { ok: true, value: { root, phase: 'stopped' } };
}

function refused(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED';
}

export async function liveDevStatus(
  rootInput: string,
  options: { readonly snapshot?: boolean } = {},
): Promise<unknown> {
  const root = resolve(rootInput);
  const record = await readSessionRecord(root, options.snapshot);
  if (record.kind === 'none') return stoppedResult(root);
  if (record.kind === 'invalid')
    return { ok: true, value: { root, phase: 'unreachable', error: record.error } };
  const { session } = record;
  try {
    return await requestJson(session, '/status', 'GET');
  } catch (error) {
    // Nothing listens and the recorded process is gone: a crash or reboot leftover.
    if (refused(error) && !processAlive(session.pid)) {
      await removeSessionRecord(root, options.snapshot === true, session);
      return stoppedResult(root);
    }
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

async function projectRootSpellings(root: string): Promise<readonly string[]> {
  const canonicalRoot = await realpath(root).catch(() => root);
  return canonicalRoot === root ? [root] : [root, canonicalRoot];
}

/** Owners whose record was lost keep a browser and project child alive; release them. */
async function terminateOrphanOwners(root: string, snapshot: boolean): Promise<void> {
  const orphans = await liveDaemonOrphans(
    await projectRootSpellings(root),
    snapshot ? 'snapshot' : 'live',
  );
  await Promise.all(orphans.map((pid) => terminateLiveDaemon(pid).catch(() => false)));
}

const LIVE_STOP_REQUEST_TIMEOUT_MS = 30_000;
const LIVE_UNRESPONSIVE_MS = 10_000;

async function gracefulStop(session: LiveDevSessionFile): Promise<boolean> {
  try {
    const response = await requestJson(
      session,
      '/stop',
      'POST',
      undefined,
      LIVE_STOP_REQUEST_TIMEOUT_MS,
    );
    return (response as { ok?: unknown } | null)?.ok === true;
  } catch {
    return false;
  }
}

/**
 * End the recorded owner process: graceful stop first, then a signal to a
 * verified owner. A pid that belongs to another program (reused after a crash
 * or reboot, or an embedding host) is never signalled.
 */
async function endOwnerProcess(
  root: string,
  session: LiveDevSessionFile,
  graceful: boolean,
): Promise<CommandError | undefined> {
  const stopped = graceful && (await gracefulStop(session));
  if (!processAlive(session.pid)) return undefined;
  const kind = await liveDaemonProcess(session.pid, await projectRootSpellings(root));
  if (kind === 'daemon') {
    if (stopped && (await exited(session.pid, 10_000))) return undefined;
    if (await terminateLiveDaemon(session.pid)) return undefined;
  } else if (kind === 'other' || stopped) return undefined;
  return commandError(
    'live-unreachable',
    'The recorded owner does not respond and could not be stopped.',
    { pid: session.pid, endpoint: session.endpoint },
  );
}

/** Retire the recorded owner and its leftovers so a new owner can start. */
async function retireOwner(
  root: string,
  snapshot: boolean,
  session: LiveDevSessionFile | undefined,
  graceful: boolean,
): Promise<CommandError | undefined> {
  if (session !== undefined) {
    const failure = await endOwnerProcess(root, session, graceful);
    if (failure !== undefined) return failure;
  }
  await removeSessionRecord(root, snapshot, session);
  await terminateOrphanOwners(root, snapshot);
  if (snapshot) await clearDeadRunClaim(root).catch(() => {});
  return undefined;
}

/** Status of a recorded owner, tolerating a briefly busy owner. */
async function recordedOwnerStatus(session: LiveDevSessionFile): Promise<unknown> {
  const deadline = Date.now() + LIVE_UNRESPONSIVE_MS;
  for (;;) {
    try {
      return await requestJson(session, '/status', 'GET');
    } catch (error) {
      if (refused(error) || !processAlive(session.pid) || Date.now() >= deadline) return undefined;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
}

type RequestedLiveOptions = RequestedOwnerOptions;

type OwnerDecision =
  | { readonly action: 'none' }
  | { readonly action: 'reuse'; readonly status: unknown }
  | {
      readonly action: 'replace';
      readonly reason: string;
      readonly session: LiveDevSessionFile | undefined;
      readonly reachable: boolean;
    };

/** Whether `dev start` can reuse the recorded owner, or must replace it. */
async function inspectOwner(
  root: string,
  snapshot: boolean,
  requested: RequestedLiveOptions,
): Promise<OwnerDecision> {
  const record = await readSessionRecord(root, snapshot);
  if (record.kind === 'none') return { action: 'none' };
  if (record.kind === 'invalid')
    return { action: 'replace', reason: record.error, session: undefined, reachable: false };
  const { session } = record;
  const status = await recordedOwnerStatus(session);
  const phase = ownerPhase(status);
  const replace = (reason: string, reachable = true): OwnerDecision => ({
    action: 'replace',
    reason,
    session,
    reachable,
  });
  if (status === undefined) return replace('unresponsive', false);
  // A failed owner retries from scratch; start means a running owner afterwards.
  if (phase === 'stopped' || phase === 'failed' || phase === undefined) return replace(`${phase}`);
  if (session.build !== (await currentLiveDevBuild())) return replace('build');
  const changed = changedLiveOptions(session.options, requested);
  if (changed.length > 0) return replace(`options: ${changed.join(', ')}`);
  return { action: 'reuse', status };
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

/** `dev stop` is idempotent: any recorded, dead, unresponsive or unreadable owner ends stopped. */
async function stopRecordedOwner(root: string, snapshot: boolean): Promise<unknown> {
  const record = await readSessionRecord(root, snapshot);
  if (record.kind === 'record') {
    try {
      const response = await requestJson(
        record.session,
        '/stop',
        'POST',
        undefined,
        LIVE_STOP_REQUEST_TIMEOUT_MS,
      );
      if ((response as { ok?: unknown } | null)?.ok === true) {
        if (snapshot) await clearDeadRunClaim(root).catch(() => {});
        return response;
      }
    } catch {
      // Retired below; a dead or unresponsive owner is still a stopped owner afterwards.
    }
  }
  const session = record.kind === 'record' ? record.session : undefined;
  const failure = await retireOwner(root, snapshot, session, false);
  return failure === undefined ? stoppedResult(root) : { ok: false, error: failure };
}

export async function liveDevControl(
  rootInput: string,
  operation: Exclude<LiveOperation, 'status'>,
  value?: unknown,
  options: { readonly snapshot?: boolean } = {},
): Promise<unknown> {
  const root = resolve(rootInput);
  if (operation === 'stop') return stopRecordedOwner(root, options.snapshot === true);
  const onDemand = options.snapshot !== true && ON_DEMAND_OPERATIONS.has(operation);
  const first = await sendToRecordedOwner(root, operation, value, options.snapshot);
  if (first.kind === 'response') return first.value;
  if (!onDemand || first.kind === 'unreachable') return first.result;
  // Nothing received the request, so starting an owner and sending it once is
  // the same operation the agent would get after `dev start`.
  const started = (await startLiveDev(root)) as { readonly ok?: unknown };
  if (started.ok !== true) return started;
  const second = await sendToRecordedOwner(root, operation, value, options.snapshot);
  return second.kind === 'response' ? second.value : second.result;
}

/** Observations whose result does not depend on who started the owner. */
const ON_DEMAND_OPERATIONS: ReadonlySet<LiveOperation> = new Set([
  'capture',
  'look',
  'verify',
  'eval',
]);

type OwnerDelivery =
  | { readonly kind: 'response'; readonly value: unknown }
  /** No owner received the request; `result` is what a caller without on-demand start sees. */
  | { readonly kind: 'absent'; readonly result: unknown }
  /** The owner may have received the request; it must not be sent again. */
  | { readonly kind: 'unreachable'; readonly result: unknown };

async function sendToRecordedOwner(
  root: string,
  operation: Exclude<LiveOperation, 'status'>,
  value: unknown,
  snapshot: boolean | undefined,
): Promise<OwnerDelivery> {
  const record = await readSessionRecord(root, snapshot);
  if (record.kind !== 'record') {
    const result =
      operation === 'observe'
        ? { ok: true, value: { status: { root, phase: 'stopped' }, image: null, logs: [] } }
        : {
            ok: false,
            error: commandError(
              'live-not-running',
              'Start the live execution owner for this project; static project preview serves sealed files and cannot accept live commands.',
              {
                root,
                operation,
                executionOwner: snapshot ? 'run' : 'dev',
                start: ['forgeax', snapshot ? 'run' : 'dev', 'start', '--root', root],
              },
            ),
          };
    return { kind: 'absent', result };
  }
  try {
    return {
      kind: 'response',
      value: await requestJson(record.session, `/${operation}`, 'POST', value),
    };
  } catch (error) {
    const result = {
      ok: false,
      error: commandError(
        'live-unreachable',
        'The recorded owner did not respond; inspect dev status.',
        { cause: error instanceof Error ? error.message : String(error) },
      ),
    };
    // A refused connection never reached an owner; a dead recorded pid cannot answer.
    return refused(error) && !processAlive(record.session.pid)
      ? { kind: 'absent', result }
      : { kind: 'unreachable', result };
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

function ownerPhase(status: unknown): unknown {
  const value = (status as { readonly value?: { readonly phase?: unknown } } | null)?.value;
  return value?.phase;
}

/**
 * An existing owner that is still starting, waiting for its App bridge or
 * replacing its runtime (for example after an edit) resolves on its own; wait for it within the project
 * startup budget instead of reporting a transient phase as a failed start.
 */
async function awaitExistingOwner(
  root: string,
  options: { readonly snapshot?: boolean },
  existing: unknown,
): Promise<unknown> {
  // The same non-terminal phases a newly spawned owner is polled through.
  const replacing = (status: unknown) =>
    ownerPhase(status) === 'starting' ||
    ownerPhase(status) === 'waiting' ||
    ownerPhase(status) === 'reloading';
  if (!replacing(existing)) return existing;
  const { readProjectStartupTimeoutMs } = await import('./project.js');
  const policy = await readProjectStartupTimeoutMs(root);
  if (!policy.ok) return policy;
  const budget = policy.value === undefined ? DEV_PREPARATION_TIMEOUT_MS : policy.value;
  const deadline = budget === null ? Infinity : Date.now() + budget;
  let status = existing;
  while (replacing(status) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LIVE_DEV_POLL_INTERVAL_MS));
    status = await liveDevStatus(root, options);
  }
  return status;
}

interface LiveStartOptions {
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
}

function requestedOptions(options: LiveStartOptions): RequestedLiveOptions {
  return {
    headless: options.headless,
    backend: options.backend,
    rhiCapture: options.rhiCapture,
    workers: options.workers,
    animation: options.animation === undefined ? undefined : animationPlayback(options.animation),
  };
}

function startLockPath(root: string, snapshot: boolean): string {
  return snapshot
    ? resolve(runStateDirectory(root), 'start.lock')
    : resolve(root, '.forgeax', 'dev-start.lock');
}

function startTimeout(): CommandResult<never> {
  return {
    ok: false,
    error: commandError(
      'live-start-timeout',
      'Startup did not finish before the deadline; dev status reports whether the owner is still running.',
    ),
  };
}

/**
 * `dev start` is idempotent: it reuses a healthy owner of this build with the
 * requested options and replaces any other recorded owner (dead, unresponsive,
 * failed, from another DevKit build or with different explicit options).
 */
export async function startLiveDev(
  rootInput: string,
  options: LiveStartOptions = {},
): Promise<unknown> {
  const root = resolve(rootInput);
  if (options.snapshot && options.inProcess)
    return {
      ok: false,
      error: commandError('run-owner-invalid', 'Independent runs require a detached Engine owner.'),
    };
  const { readProjectStartupTimeoutMs } = await import('./project.js');
  const startupPolicy = await readProjectStartupTimeoutMs(root);
  if (!startupPolicy.ok) return startupPolicy;
  const startupTimeout =
    startupPolicy.value === undefined ? DEV_PREPARATION_TIMEOUT_MS : startupPolicy.value;
  const deadline = startupTimeout === null ? Infinity : Date.now() + startupTimeout;
  // Parallel starts for one project converge on one owner.
  const release = await acquireStartLock(startLockPath(root, options.snapshot === true), deadline);
  if (release === undefined) return startTimeout();
  try {
    return await startLocked(root, options, deadline);
  } finally {
    await release();
  }
}

async function startLocked(
  root: string,
  options: LiveStartOptions,
  deadline: number,
): Promise<unknown> {
  const snapshot = options.snapshot === true;
  let decision: OwnerDecision;
  try {
    decision = await inspectOwner(root, snapshot, requestedOptions(options));
    if (decision.action === 'reuse')
      return readyResult(await awaitExistingOwner(root, options, decision.status));
    if (decision.action === 'none') await terminateOrphanOwners(root, snapshot);
    else {
      const failure = await retireOwner(root, snapshot, decision.session, decision.reachable);
      if (failure !== undefined) return { ok: false, error: failure };
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
  if (snapshot) {
    await clearDeadRunClaim(root).catch(() => {});
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
  const portProbe = createServer();
  await once(portProbe.listen(0, '127.0.0.1'), 'listening');
  const address = portProbe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolveClose) => portProbe.close(() => resolveClose()));
  if (options.inProcess !== undefined) return startInProcess(root, options, port);
  return startDetached(root, options, port, deadline);
}

function startInProcess(root: string, options: LiveStartOptions, port: number): Promise<unknown> {
  const { inProcess, ...configuration } = options;
  if (inProcess === undefined) throw new Error('Missing in-process owner composition.');
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

function daemonEnvironment(options: LiveStartOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.headless === undefined ? {} : { FORGEAX_DEV_HEADLESS: String(options.headless) }),
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
  };
}

function settledPhase(status: unknown): boolean {
  const phase = ownerPhase(status);
  return (
    phase !== undefined && phase !== 'starting' && phase !== 'waiting' && phase !== 'reloading'
  );
}

/** A short status timeout cannot decide the longer startup of our own still-live child. */
async function ownStartupTimeout(
  root: string,
  options: LiveStartOptions,
  status: unknown,
  childPid: number | undefined,
  port: number,
): Promise<boolean> {
  const value = (status as { value?: { phase?: unknown; error?: unknown } }).value;
  if (value?.phase !== 'unreachable' || value.error !== LIVE_DEV_REQUEST_TIMEOUT) return false;
  if (childPid === undefined) return false;
  const recorded = await readSession(root, options.snapshot).catch(() => undefined);
  return (
    recorded?.pid === childPid &&
    recorded.endpoint === `http://127.0.0.1:${port}` &&
    processAlive(childPid)
  );
}

async function startDetached(
  root: string,
  options: LiveStartOptions,
  port: number,
  deadline: number,
): Promise<unknown> {
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      '--__forgeax-live-daemon',
      root,
      String(port),
      options.snapshot ? 'snapshot' : 'live',
    ],
    { detached: true, stdio: 'ignore', env: daemonEnvironment(options) },
  );
  child.unref();
  const file = sessionPath(root, options.snapshot);
  // Building the project child and opening the controlled Page are bounded by
  // the same startup path as an ordinary `project preview`; a cold SDK tree
  // can take longer than a short CLI polling window. Keep the daemon detached
  // while the caller waits for its terminal starting state.
  while (Date.now() < deadline) {
    try {
      await access(file);
      const status = await liveDevStatus(root, options);
      if (
        settledPhase(status) &&
        !(await ownStartupTimeout(root, options, status, child.pid, port))
      )
        return readyResult(status);
    } catch {
      // The daemon may not have published its session file yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LIVE_DEV_POLL_INTERVAL_MS));
  }
  return startTimeout();
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
