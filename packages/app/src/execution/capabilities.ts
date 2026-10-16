import {
  EXECUTION_CAPABILITY_NAMES,
  type ExecutionCapabilities,
  type ExecutionCapabilityName,
} from './types';

export function unavailableExecutionCapabilities(reason: string): ExecutionCapabilities {
  return Object.fromEntries(
    EXECUTION_CAPABILITY_NAMES.map((name) => [name, { available: false, reason }]),
  ) as unknown as ExecutionCapabilities;
}

export function missingExecutionCapabilities(
  capabilities: ExecutionCapabilities,
  required: readonly ExecutionCapabilityName[],
): readonly ExecutionCapabilityName[] {
  return required.filter((name) => !capabilities[name].available);
}

interface WorkerProbeResult {
  readonly workerAnimationFrame: boolean;
  readonly workerWebGpu: boolean;
  readonly atomicsWait: boolean;
}

function probeWorker(timeoutMs: number | null): Promise<WorkerProbeResult> {
  return new Promise((resolve) => {
    const source = `postMessage({workerAnimationFrame:typeof requestAnimationFrame==='function',workerWebGpu:typeof navigator==='object'&&navigator.gpu!==undefined,atomicsWait:typeof Atomics==='object'&&typeof Atomics.wait==='function'})`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: WorkerProbeResult): void => {
      if (timeout !== undefined) clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    if (timeoutMs !== null) {
      timeout = setTimeout(
        () => finish({ workerAnimationFrame: false, workerWebGpu: false, atomicsWait: false }),
        timeoutMs,
      );
    }
    worker.onmessage = (event: MessageEvent<WorkerProbeResult>) => {
      finish(event.data);
    };
    worker.onerror = () => {
      finish({ workerAnimationFrame: false, workerWebGpu: false, atomicsWait: false });
    };
  });
}

export async function probeExecutionCapabilities(
  canvas: HTMLCanvasElement,
  timeoutMs: number | null = 2_000,
): Promise<ExecutionCapabilities> {
  const workerAvailable = typeof Worker === 'function';
  const offscreenAvailable = typeof canvas.transferControlToOffscreen === 'function';
  const isolated = globalThis.crossOriginIsolated === true;
  const sabAvailable = typeof SharedArrayBuffer === 'function';
  const worker = workerAvailable
    ? await probeWorker(timeoutMs)
    : { workerAnimationFrame: false, workerWebGpu: false, atomicsWait: false };
  return {
    worker: {
      available: workerAvailable,
      reason: workerAvailable ? 'Worker constructor observed' : 'Worker constructor unavailable',
    },
    offscreenCanvas: {
      available: offscreenAvailable,
      reason: offscreenAvailable
        ? 'canvas transferControlToOffscreen observed'
        : 'canvas cannot transfer to OffscreenCanvas',
    },
    workerAnimationFrame: {
      available: worker.workerAnimationFrame,
      reason: worker.workerAnimationFrame
        ? 'requestAnimationFrame observed in DedicatedWorker'
        : 'requestAnimationFrame unavailable in DedicatedWorker',
    },
    workerWebGpu: {
      available: worker.workerWebGpu,
      reason: worker.workerWebGpu
        ? 'navigator.gpu observed in DedicatedWorker'
        : 'navigator.gpu unavailable in DedicatedWorker',
    },
    crossOriginIsolated: {
      available: isolated,
      reason: isolated ? 'crossOriginIsolated is true' : 'crossOriginIsolated is false',
    },
    sharedArrayBuffer: {
      available: sabAvailable,
      reason: sabAvailable
        ? 'SharedArrayBuffer constructor observed'
        : 'SharedArrayBuffer constructor unavailable',
    },
    atomicsWait: {
      available: worker.atomicsWait,
      reason: worker.atomicsWait
        ? 'Atomics.wait observed in DedicatedWorker'
        : 'Atomics.wait unavailable in DedicatedWorker',
    },
  };
}
