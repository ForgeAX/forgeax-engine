import type { QuerySpan } from '@forgeax/engine-ecs';
import type { SharedSpanBinding } from '@forgeax/engine-ecs/shared';
import type { HostToKernelMessage, KernelWorkerConnectMessage } from './protocol';

interface LoadedKernel {
  readonly run: (spans: readonly QuerySpan[]) => unknown;
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<KernelWorkerConnectMessage>) => void) | null;
};

const loadedKernels = new Map<string, LoadedKernel>();

async function loadKernel(moduleUrl: string): Promise<LoadedKernel> {
  const module = await import(/* @vite-ignore */ moduleUrl);
  const candidate = (module.default ?? module) as { run?: unknown };
  if (typeof candidate.run !== 'function') {
    throw new TypeError('SharedKernel module default export has no run function.');
  }
  return candidate as LoadedKernel;
}

function spanFromBinding(binding: SharedSpanBinding): QuerySpan {
  return {
    entities: binding.entities,
    length: binding.length,
    get(component) {
      const fields = binding.read[component.name];
      if (fields === undefined)
        throw new Error(`Kernel read access is not declared for ${component.name}.`);
      return fields as never;
    },
    mut(component) {
      const fields = binding.write[component.name];
      if (fields === undefined)
        throw new Error(`Kernel write access is not declared for ${component.name}.`);
      return fields as never;
    },
  };
}

function receiveKernelMessage(job: HostToKernelMessage): void {
  if (job.kind === 'kernel-init') {
    Atomics.add(job.ready, 0, 1);
    Atomics.notify(job.ready, 0);
    return;
  }
  if (job.kind === 'kernel-preload') {
    void loadKernel(job.moduleUrl)
      .then((kernel) => {
        loadedKernels.set(job.moduleUrl, kernel);
        Atomics.store(job.status, job.jobIndex, 1);
      })
      .catch(() => {
        Atomics.store(job.status, job.jobIndex, -1);
      })
      .finally(() => {
        Atomics.add(job.control, 0, 1);
        Atomics.notify(job.control, 0);
      });
    return;
  }
  if (job.kind !== 'kernel-job') return;
  try {
    const kernel = loadedKernels.get(job.moduleUrl);
    if (kernel === undefined) {
      throw new Error(`SharedKernel module was not preloaded: ${job.moduleUrl}`);
    }
    const returned = kernel.run([spanFromBinding(job.binding)]);
    if (returned instanceof Promise) throw new TypeError('SharedKernel run must be synchronous.');
    Atomics.store(job.status, job.jobIndex, 1);
  } catch {
    Atomics.store(job.status, job.jobIndex, -1);
  } finally {
    Atomics.add(job.control, 0, 1);
    Atomics.notify(job.control, 0);
  }
}

scope.onmessage = (event): void => {
  const port = event.data.port;
  port.onmessage = (message: MessageEvent<HostToKernelMessage>): void => {
    receiveKernelMessage(message.data);
  };
  port.start();
};
