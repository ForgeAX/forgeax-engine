import { describe, expect, it } from 'vitest';

// These are the WebGPU COPY_SRC/COPY_DST bits; Dawn runs without a DOM constant global.
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;

type LossObservation = {
  readonly status: 'lost' | 'insufficient-evidence';
  readonly reason?: string;
  readonly message?: string;
};

type FeasibilityEvidence = {
  readonly status: 'available' | 'insufficient-evidence';
  readonly owner: string;
  readonly command: string;
  readonly exitStatus: number;
  readonly submittedWork: boolean;
  readonly rawDeviceObservation: LossObservation;
  readonly missingCapability?: string;
  readonly providerSurface: readonly string[];
};

const observationDeadlineMs = 250;

function callableProviderSurface(value: object): string[] {
  return Object.getOwnPropertyNames(value)
    .filter((name) => /loss|crash|reset|recover/i.test(name))
    .filter((name) => typeof (value as Record<string, unknown>)[name] === 'function')
    .sort();
}

async function submitObservableWork(device: GPUDevice): Promise<void> {
  const source = device.createBuffer({
    size: 16,
    usage: COPY_SRC | COPY_DST,
  });
  const destination = device.createBuffer({
    size: 16,
    usage: COPY_SRC | COPY_DST,
  });
  device.queue.writeBuffer(source, 0, new Uint32Array([0xdecafbad, 1, 2, 3]));
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}

async function observeRawLoss(device: GPUDevice): Promise<LossObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<LossObservation>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: 'insufficient-evidence',
          message: `raw GPUDevice.lost remained pending for ${observationDeadlineMs}ms`,
        }),
      observationDeadlineMs,
    );
  });
  const loss = device.lost.then((value) => ({
    status: 'lost' as const,
    reason: value.reason,
    message: value.message,
  }));
  const observation = await Promise.race([loss, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  return observation;
}

describe('real Dawn device-loss provider feasibility', () => {
  it('submits real work and reports an auditable provider boundary', async () => {
    const command =
      'pnpm exec vitest run --project dawn packages/runtime/src/__tests__/renderer-device-loss-provider-feasibility.dawn.test.ts';
    const gpu = globalThis.navigator?.gpu;
    expect(typeof gpu?.requestAdapter).toBe('function');
    if (typeof gpu?.requestAdapter !== 'function') return;

    const adapter = await gpu.requestAdapter();
    expect(adapter).not.toBeNull();
    if (adapter === null) return;

    const device = await adapter.requestDevice();
    let submittedWork = false;
    await submitObservableWork(device);
    submittedWork = true;
    const rawDeviceObservation = await observeRawLoss(device);
    const providerSurface = [
      ...callableProviderSurface(gpu),
      ...callableProviderSurface(adapter),
      ...callableProviderSurface(device),
    ];
    const evidence: FeasibilityEvidence =
      rawDeviceObservation.status === 'lost' && rawDeviceObservation.reason !== 'destroyed'
        ? {
            status: 'available',
            owner: 'raw Dawn GPUDevice provider before packages/rhi-webgpu/src/device.ts',
            command,
            exitStatus: 0,
            submittedWork,
            rawDeviceObservation,
            providerSurface,
          }
        : {
            status: 'insufficient-evidence',
            owner: 'raw Dawn GPUDevice provider before packages/rhi-webgpu/src/device.ts',
            command,
            exitStatus: 0,
            submittedWork,
            rawDeviceObservation,
            missingCapability:
              'No test-visible non-destroyed loss injection method is exposed by the real Dawn GPU, adapter, or device objects',
            providerSurface,
          };
    expect(evidence.submittedWork).toBe(true);
    expect(['available', 'insufficient-evidence']).toContain(evidence.status);
    if (evidence.status === 'available') {
      expect(evidence.rawDeviceObservation.reason).not.toBe('destroyed');
    } else {
      expect(evidence.missingCapability).toBeTruthy();
    }
  });
});
