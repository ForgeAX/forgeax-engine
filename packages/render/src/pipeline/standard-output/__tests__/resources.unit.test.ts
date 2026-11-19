import type { RhiDevice } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { RenderResourceScope } from '../../../publication/resource-scope';
import {
  makeZeroCameraFallbackSnapshot,
  type RenderFrameState,
} from '../../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../../record/render-context';
import { createStandardLutState } from '../lut-state';
import {
  commitStandardOutputSubmission,
  discardStandardOutputStates,
  disposeStandardOutput,
  prepareStandardOutputResources,
  stageStandardOutputStates,
} from '../resources';

describe('Standard output on devices without exposure metering', () => {
  it.each([
    { compute: false, storageBuffer: false },
    { compute: true, storageBuffer: false },
    { compute: false, storageBuffer: true },
  ])('keeps the authored fallback without GPU allocation for %j', (caps) => {
    const createBuffer = vi.fn();
    const device = { caps, createBuffer } as unknown as RhiDevice;
    const state = { compiledFrameGraphGeneration: 4 } as RenderFrameState;
    const camera = {
      ...makeZeroCameraFallbackSnapshot(),
      output: {
        exposure: {
          kind: 'auto' as const,
          fallback: 0.6,
          compensationEv: 1,
          rangeEv: [-2, 1] as const,
          rates: [2, 1] as const,
        },
        temperature: 6504,
        tint: 0,
        colorLut: 0,
        colorLutStrength: 0,
      },
    };
    const result = prepareStandardOutputResources(
      state,
      { device } as RenderSystemInternals,
      camera,
      {} as RenderResourceScope,
    );
    expect(result.ok).toBe(true);
    expect(createBuffer).not.toHaveBeenCalled();
    expect(state.pendingAutoExposureGpuResources).toBeUndefined();
    expect(camera.output.exposure.kind).toBe('auto');
    expect(camera.output.exposure.fallback).toBe(0.6);

    // Downlevel presentation is still transactional, and must never claim a
    // committed GPU metering result just because a fallback frame submitted.
    state.standardLutState = createStandardLutState();
    state.frameNumber = 42;
    const internals = { device, deviceScope: { generation: 2 } } as RenderSystemInternals;
    stageStandardOutputStates(state, internals, camera, 1 / 60);
    expect(state.autoExposureState).toBeUndefined();
    expect(state.pendingAutoExposureState?.state.fallback).toBe(0.6);
    discardStandardOutputStates(state);
    expect(state.autoExposureState).toBeUndefined();
    expect(state.pendingAutoExposureState).toBeUndefined();
    stageStandardOutputStates(state, internals, camera, 1 / 60);
    commitStandardOutputSubmission(state, {} as RhiDevice['queue']);
    expect(state.autoExposureState?.fallback).toBe(0.6);
    expect(state.autoExposureState?.acceptedEv).toBe(0);
    expect(state.autoExposureState?.receipt.committed).toBe(false);
  });

  it('keeps real allocation failures fatal on a capable device', () => {
    const device = {
      caps: { compute: true, storageBuffer: true },
      createBuffer: vi.fn(() => ({ ok: false, error: new Error('allocation failed') })),
    } as unknown as RhiDevice;
    const camera = {
      ...makeZeroCameraFallbackSnapshot(),
      output: {
        exposure: {
          kind: 'auto' as const,
          fallback: 1,
          compensationEv: 0,
          rangeEv: [-2, 1] as const,
          rates: [2, 1] as const,
        },
        temperature: 6504,
        tint: 0,
        colorLut: 0,
        colorLutStrength: 0,
      },
    };
    const result = prepareStandardOutputResources(
      { compiledFrameGraphGeneration: 4 } as RenderFrameState,
      { device } as RenderSystemInternals,
      camera,
      {} as RenderResourceScope,
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        detail: {
          error: {
            code: 'auto-exposure-prepare-failed',
            message: 'Error: allocation failed',
          },
        },
      },
    });
  });
});

it('retains metering history on a graph replacement and invalidates it on a camera cut', async () => {
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const state = {
    compiledFrameGraphGeneration: 4,
    frameNumber: 42,
    standardLutState: createStandardLutState(),
  } as RenderFrameState;
  const internals = {
    device,
    deviceScope: { generation: 2 },
    canvas: { width: 640, height: 360 },
  } as RenderSystemInternals;
  const camera = {
    ...makeZeroCameraFallbackSnapshot(),
    output: {
      exposure: {
        kind: 'auto' as const,
        fallback: 0.6,
        compensationEv: 1,
        rangeEv: [-2, 1] as const,
        rates: [2, 1] as const,
      },
      temperature: 6504,
      tint: 0,
      colorLut: 0,
      colorLutStrength: 0,
    },
  };
  try {
    prepareStandardOutputResources(state, internals, camera, {} as RenderResourceScope).unwrap();
    const parameters = state.pendingAutoExposureGpuResources?.parameters;
    expect(parameters).toBeDefined();
    const writes = vi.spyOn(device.queue, 'writeBuffer');
    const revision = () => {
      const upload = writes.mock.calls.findLast(([buffer]) => buffer === parameters)?.[2];
      expect(upload).toBeInstanceOf(Float32Array);
      return (upload as Float32Array)[7];
    };

    stageStandardOutputStates(state, internals, camera, 1 / 60);
    const firstRevision = revision();
    commitStandardOutputSubmission(state, device.queue);
    await device.queue.onSubmittedWorkDone();

    state.compiledFrameGraphGeneration++;
    state.frameNumber++;
    stageStandardOutputStates(state, internals, camera, 1 / 60);
    expect(revision()).toBe(firstRevision);
    commitStandardOutputSubmission(state, device.queue);
    await device.queue.onSubmittedWorkDone();

    state.frameNumber++;
    stageStandardOutputStates(
      state,
      internals,
      { ...camera, historyVersion: camera.historyVersion + 1 },
      1 / 60,
    );
    expect(revision()).toBeGreaterThan(firstRevision ?? 0);
    discardStandardOutputStates(state);
  } finally {
    disposeStandardOutput(state);
    await device.queue.onSubmittedWorkDone();
  }
});
