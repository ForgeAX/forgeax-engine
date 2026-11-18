import { createVideoFrameHost } from '@forgeax/engine-graphics-extras';
import { addLoadWork, err, loadProgressScope, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { validateExecutionBootstrapData } from './bootstrap-entry';
import { forwardGpuStub } from './gpu-stub';
import {
  type EngineToHostMessage,
  type ExecutionFaultMessage,
  type ExecutionHostControlMessage,
  type ExecutionInitMessage,
  type ExecutionReadyMessage,
  type ExecutionRenderErrorMessage,
  forwardPipelineLibraries,
  forwardResourceBudgets,
  type HostToEngineMessage,
} from './protocol';
import { forwardRenderBackend } from './render-backend';
import { type FrameNotice, WorkerFrameSource } from './worker-frame-source';
import { shutdownWorker } from './worker-shutdown';

/** Bind the Worker realm to this page's load progress, when the page has one. */
export function loadProgressInit(): { readonly loadProgressScope?: string } {
  const scope = loadProgressScope();
  return scope === undefined ? {} : { loadProgressScope: scope };
}

export interface EngineWorkerSession {
  readonly worker: Worker;
  readonly ready: ExecutionReadyMessage;
  post(message: HostToEngineMessage, transfer?: Transferable[]): void;
  listen(listener: (message: EngineToHostMessage) => void): () => void;
  requestFrame?(callback: () => void, unavailable: () => void): (() => void) | undefined;
  dispose(): Promise<Result<void, AppErrorType>>;
}

interface StartEngineWorkerOptions
  extends Omit<ExecutionInitMessage, 'kind' | 'startupTimeoutMs' | 'canvas'> {
  readonly canvas: HTMLCanvasElement;
  readonly timeoutMs: ExecutionInitMessage['startupTimeoutMs'];
  readonly workerFactory?: () => Worker;
}

function deadlineError(timeoutMs: number): AppErrorType {
  return new AppError({
    code: 'app-execution-deadline-exceeded',
    expected: APP_EXPECTED['app-execution-deadline-exceeded'],
    hint: APP_ERROR_HINTS['app-execution-deadline-exceeded'],
    detail: { phase: 'handshake', timeoutMs },
  });
}

function startupFault(message: ExecutionFaultMessage, moduleUrl: string): AppErrorType {
  return new AppError({
    code: 'app-execution-bootstrap-failed',
    expected: APP_EXPECTED['app-execution-bootstrap-failed'],
    hint: APP_ERROR_HINTS['app-execution-bootstrap-failed'],
    detail: { phase: 'bootstrap', moduleUrl, cause: message.detail },
  });
}

type EngineMessage<K extends EngineToHostMessage['kind']> = Extract<
  EngineToHostMessage,
  { readonly kind: K }
>;

/** A Render Worker failure before readiness is a bootstrap fault of the Engine session. */
function renderStartupFault(message: ExecutionRenderErrorMessage): ExecutionFaultMessage {
  return {
    kind: 'fault',
    worldIdentity: message.worldIdentity,
    source: 'bootstrap',
    ...message.error,
    detail: {
      ...message.error,
      renderIdentity: message.identity,
      worldIdentity: message.worldIdentity,
      ...(message.renderer === undefined ? {} : { renderer: message.renderer }),
    },
    partialWrite: false,
    retryable: false,
  };
}

interface VideoBridge {
  /** Spread into the init message. */
  readonly init: { readonly videoPort?: MessagePort };
  readonly transfer: readonly MessagePort[];
  dispose(): void;
}

/**
 * The page owns `<video>` elements; the DOM-less Engine Worker receives their
 * frames on a dedicated port. Inert without a document or MessageChannel
 * (e.g. Node hosts), where the Worker provider is simply not installed.
 */
function openVideoBridge(): VideoBridge {
  if (typeof document === 'undefined' || typeof MessageChannel === 'undefined')
    return { init: {}, transfer: [], dispose: () => {} };
  const channel = new MessageChannel();
  const host = createVideoFrameHost(channel.port1);
  return {
    init: { videoPort: channel.port2 },
    transfer: [channel.port2],
    dispose: () => host.dispose(),
  };
}

export async function startEngineWorker(
  options: StartEngineWorkerOptions,
): Promise<Result<EngineWorkerSession, AppErrorType>> {
  const validData = validateExecutionBootstrapData(options.bootstrapData, options.bootstrapUrl);
  if (!validData.ok) return validData;
  const worker =
    options.workerFactory?.() ??
    new Worker(new URL('./engine-worker-runtime.mjs', import.meta.url), {
      type: 'module',
      name: 'forgeax-engine',
    });
  const taskCleanups = new Map<number, () => void>();
  let retired = false;
  const retirePoolWorkers = (): void => {
    retired = true;
    frameSource.connect(undefined);
    for (const cleanup of taskCleanups.values()) cleanup();
  };
  // Render notices arrive on a per-session port; a replacement session closes the old one.
  const frameSource = new WorkerFrameSource();
  frameSource.connect(worker);
  let renderHostPort: MessagePort | undefined;
  const closeRenderHostPort = (): void => {
    if (renderHostPort === undefined) return;
    renderHostPort.onmessage = null;
    renderHostPort.close();
    renderHostPort = undefined;
  };
  const video = openVideoBridge();
  const terminate = (): void => {
    retirePoolWorkers();
    closeRenderHostPort();
    video.dispose();
    worker.terminate();
  };
  const listeners = new Set<(message: EngineToHostMessage) => void>();
  type PendingNotice = {
    readonly sequence: number;
    readonly message:
      | Extract<EngineToHostMessage, { readonly kind: 'render-ready' }>
      | ExecutionRenderErrorMessage
      | ExecutionHostControlMessage;
  };
  let pendingRenderReady: PendingNotice | undefined;
  let settled = false;
  let firstListenerInstalled = false;
  let pendingRenderError: PendingNotice | undefined;
  // Realm plugins may command pointer lock before the ready ACK. Retain the latest
  // command until the first Host listener owns delivery.
  let pendingHostControl: PendingNotice | undefined;
  let omittedRenderErrors = 0;
  let nextNoticeSequence = 0;
  let resolveReady: (result: Result<ExecutionReadyMessage, AppErrorType>) => void = () => {};
  const readyPromise = new Promise<Result<ExecutionReadyMessage, AppErrorType>>((resolve) => {
    resolveReady = resolve;
  });
  const timeout =
    options.timeoutMs === null
      ? undefined
      : setTimeout(() => {
          if (settled) return;
          settled = true;
          terminate();
          resolveReady(err(deadlineError(options.timeoutMs as number)));
        }, options.timeoutMs);
  // Pool Workers are page-owned; the Engine Worker dispatches
  // to them. A pool Worker failure is not an Engine fault: the dispatcher
  // rejects its running task and replaces it.
  const adoptTaskWorker = (message: EngineMessage<'task-worker'>): void => {
    const port = message.port;
    if (retired || taskCleanups.has(message.workerId)) {
      port.close();
      return;
    }
    let task: Worker | undefined;
    let portOwnedByHost = true;
    const cleanup = (): void => {
      if (!taskCleanups.delete(message.workerId)) return;
      if (portOwnedByHost) port.close();
      if (task !== undefined) {
        task.onerror = null;
        task.terminate();
      }
    };
    const report = (cause: string): void => {
      cleanup();
      if (retired) return;
      try {
        worker.postMessage({
          kind: 'task-worker-error',
          workerId: message.workerId,
          message: cause,
        });
      } catch {
        // The Engine Worker is gone; it no longer dispatches.
      }
    };
    taskCleanups.set(message.workerId, cleanup);
    try {
      task = new Worker(new URL('./task-worker-runtime.mjs', import.meta.url), {
        type: 'module',
        name: 'forgeax-task',
      });
      task.onerror = (event): void => {
        event.preventDefault?.();
        report(event.message ?? 'task worker error');
      };
      task.postMessage({ kind: 'task-connect', port }, [port]);
      portOwnedByHost = false;
    } catch (cause) {
      report(String(cause));
    }
  };
  const adoptRenderHostPort = (message: EngineMessage<'render-host-port'>): void => {
    closeRenderHostPort();
    const port = message.port;
    if (retired) {
      port.close();
      return;
    }
    renderHostPort = port;
    port.onmessage = (event: MessageEvent<EngineToHostMessage>) => {
      const notice = event.data;
      if (notice.kind !== 'render-submitted' && notice.kind !== 'render-complete') return;
      for (const listener of listeners) listener(notice);
    };
  };
  const settleStartup = (result: Result<ExecutionReadyMessage, AppErrorType>): void => {
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    if (!result.ok) terminate();
    resolveReady(result);
  };
  /** The first ready, render-error or fault notice decides startup. */
  const observeStartup = (message: EngineToHostMessage): void => {
    if (message.kind === 'ready') settleStartup(ok(message));
    else if (message.kind === 'render-error')
      settleStartup(err(startupFault(renderStartupFault(message), options.bootstrapUrl)));
    else if (message.kind === 'fault')
      settleStartup(err(startupFault(message, options.bootstrapUrl)));
  };
  const retainEarlyNotice = (message: EngineToHostMessage): void => {
    if (listeners.size === 0 && message.kind === 'render-ready')
      pendingRenderReady = { sequence: nextNoticeSequence++, message };
    if (!firstListenerInstalled && message.kind === 'host-control')
      pendingHostControl = { sequence: nextNoticeSequence++, message };
  };
  worker.onmessage = (event: MessageEvent<EngineToHostMessage | FrameNotice>) => {
    const message = event.data;
    if (message.kind === 'native-frame-ready' || message.kind === 'native-frame') {
      frameSource.receive(worker, message);
      return;
    }
    if (message.kind === 'task-worker') {
      adoptTaskWorker(message);
      return;
    }
    if (message.kind === 'task-retire') {
      taskCleanups.get(message.workerId)?.();
      return;
    }
    if (message.kind === 'render-host-port') {
      adoptRenderHostPort(message);
      return;
    }
    retainEarlyNotice(message);
    if (!settled) observeStartup(message);
    if (message.kind === 'render-error' && !firstListenerInstalled) {
      if (pendingRenderError === undefined)
        pendingRenderError = { sequence: nextNoticeSequence++, message };
      else omittedRenderErrors++;
    }
    for (const listener of listeners) listener(message);
  };
  worker.onerror = (event) => {
    retirePoolWorkers();
    if (settled) {
      const crash: ExecutionFaultMessage = {
        kind: 'fault',
        worldIdentity: null,
        source: 'runtime',
        code: 'worker-crashed',
        expected: 'Engine Worker remains alive while the App is running',
        hint: 'inspect the Worker error and create a new App; transferred canvas ownership is terminal',
        detail: { message: event.message },
        partialWrite: false,
        retryable: false,
      };
      for (const listener of listeners) listener(crash);
      return;
    }
    settled = true;
    if (timeout !== undefined) clearTimeout(timeout);
    terminate();
    resolveReady(
      err(
        startupFault(
          {
            kind: 'fault',
            worldIdentity: null,
            source: 'bootstrap',
            code: 'worker-error',
            expected: 'Engine Worker module loads',
            hint: 'inspect the Worker module graph',
            detail: { message: event.message },
            partialWrite: false,
            retryable: false,
          },
          options.bootstrapUrl,
        ),
      ),
    );
  };

  const offscreen = options.canvas.transferControlToOffscreen();
  const init: ExecutionInitMessage = {
    kind: 'init',
    startupTimeoutMs: options.timeoutMs,
    ...(options.frameTimeoutMs === undefined ? {} : { frameTimeoutMs: options.frameTimeoutMs }),
    canvas: offscreen,
    bootstrapUrl: options.bootstrapUrl,
    ...(options.bootstrapData === undefined ? {} : { bootstrapData: options.bootstrapData }),
    ...(options.bootstrapPort === undefined ? {} : { bootstrapPort: options.bootstrapPort }),
    ...video.init,
    ...(options.assetCatalog === undefined ? {} : { assetCatalog: options.assetCatalog }),
    ...(options.shaderManifestUrl !== undefined
      ? { shaderManifestUrl: options.shaderManifestUrl }
      : {}),
    ...(options.build !== undefined ? { build: options.build } : {}),
    ...(options.time !== undefined ? { time: options.time } : {}),
    ...(options.animation === undefined ? {} : { animation: options.animation }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...forwardGpuStub(options),
    ...forwardPipelineLibraries(options),
    ...(options.outputColorSpace === undefined
      ? {}
      : { outputColorSpace: options.outputColorSpace }),
    ...forwardRenderBackend(options),
    ...forwardResourceBudgets(options),
    ...(options.startup === undefined ? {} : { startup: options.startup }),
    ...(options.featureTextureReadbackBudgetBytes === undefined
      ? {}
      : { featureTextureReadbackBudgetBytes: options.featureTextureReadbackBudgetBytes }),
    ...loadProgressInit(),
    workers: options.workers,
  };
  // One Engine Worker to start; its realm reports completion once it runs.
  addLoadWork('workers', { total: 1 });
  worker.postMessage(init, [
    offscreen,
    ...(options.bootstrapPort === undefined ? [] : [options.bootstrapPort]),
    ...video.transfer,
  ]);
  const ready = await readyPromise;
  if (!ready.ok) return ready;
  let disposal: Promise<Result<void, AppErrorType>> | undefined;
  return ok({
    worker,
    ready: ready.value,
    requestFrame: (callback, unavailable) => frameSource.request(callback, unavailable),
    post(message, transfer = []): void {
      worker.postMessage(message, transfer);
    },
    listen(listener): () => void {
      if (disposal === undefined) {
        listeners.add(listener);
        if (!firstListenerInstalled) firstListenerInstalled = true;
        const retained = [pendingRenderReady, pendingRenderError, pendingHostControl]
          .filter((notice): notice is PendingNotice => notice !== undefined)
          .sort((left, right) => left.sequence - right.sequence);
        pendingRenderReady = undefined;
        pendingRenderError = undefined;
        pendingHostControl = undefined;
        const omitted = omittedRenderErrors;
        omittedRenderErrors = 0;
        for (const notice of retained) {
          if (notice.message.kind === 'render-error')
            listener({ ...notice.message, omittedBeforeListenerCount: omitted });
          else listener(notice.message);
        }
      }
      return () => listeners.delete(listener);
    },
    dispose() {
      // Retire public delivery immediately; the shutdown helper owns its ACK listener.
      listeners.clear();
      pendingRenderReady = undefined;
      firstListenerInstalled = true;
      pendingRenderError = undefined;
      pendingHostControl = undefined;
      omittedRenderErrors = 0;
      disposal ??= shutdownWorker(worker, 10_000).finally(() => {
        retirePoolWorkers();
        closeRenderHostPort();
        video.dispose();
      });
      return disposal;
    },
  });
}
