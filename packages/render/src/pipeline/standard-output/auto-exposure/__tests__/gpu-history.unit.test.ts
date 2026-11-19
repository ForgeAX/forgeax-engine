import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { GPU_BUFFER_USAGE_STORAGE, GPU_BUFFER_USAGE_UNIFORM } from '../../../../gpu-usage';
import {
  abortAutoExposureGpuFrame,
  createAutoExposureGpuResources,
  retireAutoExposureGpuResources,
  submitAutoExposureGpuFrame,
  writeAutoExposureParameters,
} from '../gpu';

const parameters = {
  compensationEv: 0,
  rangeMinEv: -8,
  rangeMaxEv: 8,
  upRate: 3,
  downRate: 1,
  deltaTime: 1 / 60,
  fallback: 1,
  generation: 7,
  historyIdentity: 'view:1:640x360',
};

it.each([
  'compute',
  'fragment',
] as const)('lets native Grade read both %s exposure history slots without a copy', async (execution) => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const allocations = vi.spyOn(device, 'createBuffer');
  const resources = createAutoExposureGpuResources(device, 1, execution).unwrap();
  const original = device.queue.onSubmittedWorkDone;
  const completions: (() => void)[] = [];
  device.queue.onSubmittedWorkDone = () =>
    new Promise<undefined>((resolve) => completions.push(() => resolve(undefined)));
  try {
    const expectedSlots = [resources.state, resources.candidate];
    for (let frame = 0; frame < 4; frame++) {
      writeAutoExposureParameters(resources, parameters).unwrap();
      expect(resources.candidate).toBe(expectedSlots[(frame + 1) % 2]);
      submitAutoExposureGpuFrame(resources, () => {});
      expect(resources.state).toBe(expectedSlots[(frame + 1) % 2]);
    }
    const slots = allocations.mock.calls
      .map(([descriptor]) => descriptor)
      .filter(({ label }) => label?.includes('state') || label?.includes('candidate'));
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect((slot.usage ?? 0) & GPU_BUFFER_USAGE_UNIFORM).toBe(GPU_BUFFER_USAGE_UNIFORM);
      if (execution === 'compute')
        expect((slot.usage ?? 0) & GPU_BUFFER_USAGE_STORAGE).toBe(GPU_BUFFER_USAGE_STORAGE);
    }
    expect(completions).toHaveLength(4);
  } finally {
    for (const complete of completions) complete();
    device.queue.onSubmittedWorkDone = original;
    retireAutoExposureGpuResources(resources);
  }
});

async function createFixture() {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const resources = createAutoExposureGpuResources(device, 7).unwrap();
  const completions: (() => void)[] = [];
  device.queue.onSubmittedWorkDone = () =>
    new Promise<undefined>((resolve) => completions.push(() => resolve(undefined)));
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  const stage = (overrides: Partial<typeof parameters> = {}) => {
    writeAutoExposureParameters(resources, { ...parameters, ...overrides }).unwrap();
    const upload = writes.mock.lastCall?.[2] as Float32Array;
    return upload[7];
  };
  return {
    resources,
    stage,
    completions,
    cleanup() {
      retireAutoExposureGpuResources(resources);
      for (const complete of completions) complete();
    },
  };
}

it('uses the preceding submitted exposure throughout overlapping queue submissions', async () => {
  const { resources, stage, completions, cleanup } = await createFixture();
  const receipts: number[] = [];
  const initialState = resources.state;
  const initialCandidate = resources.candidate;

  try {
    for (let frame = 1; frame <= 4; frame++) {
      stage();
      expect(resources.state).toBe(frame % 2 === 1 ? initialState : initialCandidate);
      expect(resources.candidate).toBe(frame % 2 === 1 ? initialCandidate : initialState);
      submitAutoExposureGpuFrame(resources, () => receipts.push(frame));
    }
    expect(receipts).toEqual([]);

    completions[1]?.();
    await Promise.resolve();
    completions[0]?.();
    await Promise.resolve();
    completions[2]?.();
    await Promise.resolve();
    expect(receipts).toEqual([2, 3]);
    expect(resources.state).toBe(initialState);

    completions[3]?.();
    await Promise.resolve();
    expect(receipts).toEqual([2, 3, 4]);
  } finally {
    cleanup();
  }
});

it('keeps the submitted key, slot and completion after an aborted camera change', async () => {
  const { resources, stage, completions, cleanup } = await createFixture();
  const receipts: number[] = [];
  try {
    const firstRevision = stage();
    const firstCandidate = resources.candidate;
    submitAutoExposureGpuFrame(resources, () => receipts.push(1));

    expect(stage({ historyIdentity: 'view:2:800x600' })).toBeGreaterThan(firstRevision);
    abortAutoExposureGpuFrame(resources);
    expect(stage()).toBe(firstRevision);
    expect(resources.state).toBe(firstCandidate);

    completions[0]?.();
    await Promise.resolve();
    expect(receipts).toEqual([1]);
    abortAutoExposureGpuFrame(resources);
  } finally {
    cleanup();
  }
});

it('rejects a stale completion after a different camera or extent submits', async () => {
  const { resources, stage, completions, cleanup } = await createFixture();
  const receipts: number[] = [];
  try {
    const firstRevision = stage();
    submitAutoExposureGpuFrame(resources, () => receipts.push(1));

    expect(stage({ historyIdentity: 'view:2:800x600' })).toBeGreaterThan(firstRevision);
    const secondCandidate = resources.candidate;
    submitAutoExposureGpuFrame(resources, () => receipts.push(2));

    completions[0]?.();
    await Promise.resolve();
    expect(receipts).toEqual([]);
    expect(resources.state).toBe(secondCandidate);
    completions[1]?.();
    await Promise.resolve();
    expect(receipts).toEqual([2]);
  } finally {
    cleanup();
  }
});
