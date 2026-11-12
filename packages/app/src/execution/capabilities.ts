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
  readonly renderingBackend?: 'webgpu' | 'webgl2' | null;
  readonly atomicsWait: boolean;
}

function probeWorker(timeoutMs: number | null, webGpuStub: boolean): Promise<WorkerProbeResult> {
  return new Promise((resolve) => {
    // API presence is not adapter availability (for example, a denied/disabled GPU).
    // Probe before transferring the real canvas so auto can retain the Host fallback.
    const source = `(async()=>{
      let renderingBackend=${webGpuStub ? "'webgpu'" : 'null'};
      if(renderingBackend===null){
        try{
          const gpu=typeof navigator==='object'?navigator.gpu:undefined;
          const adapter=await gpu?.requestAdapter();
          if(adapter!==null&&adapter!==undefined)renderingBackend='webgpu';
        }catch{}
      }
      if(renderingBackend===null){
        try{
          const canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(1,1):undefined;
          const gl=canvas?.getContext('webgl2');
          if(gl){
            renderingBackend='webgl2';
            gl.getExtension('WEBGL_lose_context')?.loseContext();
          }
        }catch{}
      }
      postMessage({workerAnimationFrame:typeof requestAnimationFrame==='function',workerWebGpu:renderingBackend!==null,renderingBackend,atomicsWait:typeof Atomics==='object'&&typeof Atomics.wait==='function'});
    })()`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (result: WorkerProbeResult): void => {
      if (settled) return;
      settled = true;
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

/**
 * Execution Worker scripts are emitted beside this module. A document whose origin differs
 * from that script origin (an opaque `CSP: sandbox` page included) cannot construct them,
 * even when a Blob-URL probe Worker starts.
 */
export function executionWorkerScriptsReachable(
  documentOrigin: unknown = (globalThis as { readonly origin?: unknown }).origin,
  scriptUrl: string = import.meta.url,
): boolean {
  if (typeof documentOrigin !== 'string') return true;
  // An opaque document still reaches blob:null scripts (single-HTML players), never http(s) ones.
  return new URL(scriptUrl).origin === documentOrigin;
}

export async function probeExecutionCapabilities(
  canvas: HTMLCanvasElement,
  timeoutMs: number | null = 2_000,
  /** App installs the WebGPU stub in every execution Worker realm it creates. */
  webGpuStub = false,
): Promise<ExecutionCapabilities> {
  const workerConstructor = typeof Worker === 'function';
  const scriptsReachable = executionWorkerScriptsReachable();
  const workerAvailable = workerConstructor && scriptsReachable;
  const offscreenAvailable = typeof canvas.transferControlToOffscreen === 'function';
  const isolated = globalThis.crossOriginIsolated === true;
  const sabAvailable = typeof SharedArrayBuffer === 'function';
  const worker = workerAvailable
    ? await probeWorker(timeoutMs, webGpuStub)
    : { workerAnimationFrame: false, workerWebGpu: false, atomicsWait: false };
  return {
    worker: {
      available: workerAvailable,
      reason: !workerConstructor
        ? 'Worker constructor unavailable'
        : scriptsReachable
          ? 'Worker constructor observed'
          : 'Worker scripts are cross-origin to this document',
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
    workerWebGpu: webGpuStub
      ? { available: true, reason: 'WebGPU stub installed in each execution Worker' }
      : {
          available: worker.workerWebGpu,
          reason: worker.workerWebGpu
            ? worker.renderingBackend === 'webgl2'
              ? 'WebGL2 context available in DedicatedWorker'
              : 'WebGPU adapter acquired in DedicatedWorker'
            : 'WebGPU adapter and WebGL2 context unavailable in DedicatedWorker',
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
