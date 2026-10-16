import { setTimeout as sleep } from 'node:timers/promises';

// Keep the Dawn fixture independent from a browser-provided GPUBufferUsage global.
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;

export type DawnRawLoss = {
  readonly reason: 'destroyed' | 'unknown';
  readonly message: string;
};

export type DawnLossProvider = {
  readonly injectNonDestroyedLoss?: (device: GPUDevice) => Promise<void>;
};

export const dawnRecoveryCommand =
  'pnpm exec vitest run --project dawn packages/runtime/src/__tests__/renderer-device-loss-recovery.dawn.test.ts';

export async function submitRealFrame(device: GPUDevice): Promise<void> {
  const source = device.createBuffer({
    size: 16,
    usage: COPY_SRC | COPY_DST,
  });
  const target = device.createBuffer({
    size: 16,
    usage: COPY_SRC | COPY_DST,
  });
  device.queue.writeBuffer(source, 0, new Uint32Array([1, 2, 3, 4]));
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, target, 0, 16);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}

export async function observeRealLoss(device: GPUDevice): Promise<DawnRawLoss | undefined> {
  const loss = device.lost.then((value) => ({
    reason: value.reason,
    message: value.message,
  }));
  const observationDeadline = sleep(250).then(() => undefined);
  return Promise.race([loss, observationDeadline]);
}

export function testOnlyLossProvider(): DawnLossProvider | undefined {
  const candidate = (globalThis as typeof globalThis & { __forgeaxDawnLossProvider?: unknown })
    .__forgeaxDawnLossProvider;
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const provider = candidate as DawnLossProvider;
  return typeof provider.injectNonDestroyedLoss === 'function' ? provider : undefined;
}

export function insufficientDawnRecoveryEvidence(
  worlds: readonly string[],
  missingCapability = 'No test-visible real Dawn provider can inject non-destroyed loss before Renderer correlation',
) {
  return {
    status: 'insufficient-evidence' as const,
    provider: 'missing' as const,
    command: dawnRecoveryCommand,
    submittedWork: true,
    worlds,
    phases: {
      candidateRejectedNoPublish: false,
      recoveredWithNewGeneration: false,
      frameRuns: [] as readonly number[],
    },
    missingCapability,
  };
}
