import { err, ok, type Result } from '@forgeax/engine-types';
import { APP_ERROR_HINTS, APP_EXPECTED, AppError, type AppError as AppErrorType } from '../errors';
import { validateExecutionBootstrapData } from './bootstrap-entry';
import { forwardGpuStub } from './gpu-stub';
import type {
  EngineToHostMessage,
  ExecutionFaultMessage,
  ExecutionHostControlMessage,
  ExecutionInitMessage,
  ExecutionReadyMessage,
  ExecutionRenderErrorMessage,
  HostToEngineMessage,
} from './protocol';
import { shutdownWorker } from './worker-shutdown';

export interface EngineWorkerSession {
  readonly worker: Worker;
  readonly ready: ExecutionReadyMessage;
  post(message: HostToEngineMessage, transfer?: Transferable[]): void;
  listen(listener: (message: EngineToHostMessage) => void): () => void;
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
  const kernelCleanups = new Map<number, () => void>();
  let retired = false;
  const retireKernels = (): void => {
    retired = true;
    for (const cleanup of kernelCleanups.values()) cleanup();
  };
  // Render notices arrive on a per-session port; a replacement session closes the old one.
  let renderHostPort: MessagePort | undefined;
  const closeRenderHostPort = (): void => {
    if (renderHostPort === undefined) return;
    renderHostPort.onmessage = null;
    renderHostPort.close();
    renderHostPort = undefined;
  };
  const terminate = (): void => {
    retireKernels();
    closeRenderHostPort();
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
  const adoptKernelWorker = (message: EngineMessage<'kernel-worker'>): void => {
    const port = message.port;
    if (retired || !options.workers.kernels.enabled || kernelCleanups.has(message.workerId)) {
      port.close();
      return;
    }
    let kernel: Worker | undefined;
    let portOwnedByHost = true;
    const cleanup = (): void => {
      if (!kernelCleanups.delete(message.workerId)) return;
      if (portOwnedByHost) port.close();
      if (kernel !== undefined) {
        kernel.onerror = null;
        kernel.terminate();
      }
    };
    kernelCleanups.set(message.workerId, cleanup);
    try {
      kernel = new Worker(new URL('./kernel-worker-runtime.mjs', import.meta.url), {
        type: 'module',
        name: 'forgeax-kernel',
      });
      kernel.onerror = (event): void => {
        cleanup();
        worker.onerror?.(event);
      };
      kernel.postMessage({ kind: 'kernel-connect', port }, [port]);
      portOwnedByHost = false;
    } catch (cause) {
      cleanup();
      worker.onerror?.({ message: String(cause) } as ErrorEvent);
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
  worker.onmessage = (event: MessageEvent<EngineToHostMessage>) => {
    const message = event.data;
    if (message.kind === 'kernel-worker') {
      adoptKernelWorker(message);
      return;
    }
    if (message.kind === 'kernel-retire') {
      kernelCleanups.get(message.workerId)?.();
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
    retireKernels();
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
    canvas: offscreen,
    bootstrapUrl: options.bootstrapUrl,
    ...(options.bootstrapData === undefined ? {} : { bootstrapData: options.bootstrapData }),
    ...(options.bootstrapPort === undefined ? {} : { bootstrapPort: options.bootstrapPort }),
    ...(options.assetCatalog === undefined ? {} : { assetCatalog: options.assetCatalog }),
    ...(options.shaderManifestUrl !== undefined
      ? { shaderManifestUrl: options.shaderManifestUrl }
      : {}),
    ...(options.build !== undefined ? { build: options.build } : {}),
    ...(options.time !== undefined ? { time: options.time } : {}),
    ...(options.animation === undefined ? {} : { animation: options.animation }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...forwardGpuStub(options),
    ...(options.pipelineLibrary === undefined ? {} : { pipelineLibrary: options.pipelineLibrary }),
    ...(options.outputColorSpace === undefined
      ? {}
      : { outputColorSpace: options.outputColorSpace }),
    ...(options.dynamicGeometryMeshBudgetBytes === undefined
      ? {}
      : { dynamicGeometryMeshBudgetBytes: options.dynamicGeometryMeshBudgetBytes }),
    ...(options.assetBudgetBytes === undefined
      ? {}
      : { assetBudgetBytes: options.assetBudgetBytes }),
    workers: options.workers,
  };
  worker.postMessage(init, [
    offscreen,
    ...(options.bootstrapPort === undefined ? [] : [options.bootstrapPort]),
  ]);
  const ready = await readyPromise;
  if (!ready.ok) return ready;
  let disposal: Promise<Result<void, AppErrorType>> | undefined;
  return ok({
    worker,
    ready: ready.value,
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
      disposal ??= shutdownWorker(worker, 10_000).finally(retireKernels);
      return disposal;
    },
  });
}
