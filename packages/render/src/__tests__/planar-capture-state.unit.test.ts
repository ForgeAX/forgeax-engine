import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlanarCaptureState } from '../capture/planar-state';
import type { CameraSnapshot } from '../render-contract';
import {
  createRenderTargetPhysical,
  destroyRenderTargetPhysical,
  type RenderTargetPhysical,
} from '../targets/physical';

let device: RhiDevice;
let physical: RenderTargetPhysical;
const states: PlanarCaptureState[] = [];
const makeState = () => {
  const value = new PlanarCaptureState();
  states.push(value);
  return value;
};
beforeEach(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const created = await adapter.value.requestDevice();
  if (!created.ok) throw created.error;
  device = created.value;
  const allocated = createRenderTargetPhysical(
    device,
    {
      shape: '2d',
      width: 16,
      height: 16,
      format: 'rgba16float',
      sampleCount: 1,
      mipLevels: 1,
      sampled: true,
      readback: false,
    },
    1,
  );
  if (!allocated.ok) throw allocated.error;
  physical = allocated.value;
});
afterEach(async () => {
  for (const item of states.splice(0)) item.dispose();
  await device.queue.onSubmittedWorkDone();
  destroyRenderTargetPhysical(physical);
});
const camera = {
  target: {},
  planarReflection: { updateIntervalFrames: 4, requestVersion: 0 },
} as CameraSnapshot;

describe('planar capture receipt and cadence', () => {
  it('pairs the retained camera with its texture until the next completed capture', async () => {
    const state = makeState();
    const first = state.prepare(camera, physical, 10);
    let done!: () => void;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });
    state.stage(true, completion);
    state.settle(true);
    expect(state.prepare(camera, physical, 11)).toBeUndefined();
    expect(state.current()).toBe(first);
    done();
    await completion;
    expect(state.prepare({ ...camera }, physical, 12)).toBeUndefined();
    expect(state.current()).toBe(first);
    expect(state.prepare(camera, physical, 14)).toBeDefined();
  });
  it('rolls back a selection the recording never staged, even in an accepted frame', () => {
    const state = makeState();
    // `render-capture-schedule` selected it; the recording threw before submit.
    expect(state.prepare(camera, physical, 0)).toBeDefined();
    state.settle(true);
    expect(state.current()).toBeUndefined();
    expect(state.prepare(camera, physical, 1)).toBeDefined();
  });
  it('rolls back a submitted selection the RenderSubmission did not accept', async () => {
    const state = makeState();
    expect(state.prepare(camera, physical, 0)).toBeDefined();
    state.stage(true, Promise.resolve());
    state.settle(false);
    await Promise.resolve();
    expect(state.current()).toBeUndefined();
    // The next frame selects it again instead of waiting for its cadence.
    expect(state.prepare(camera, physical, 1)).toBeDefined();
  });
  it('retries failure and refreshes after resize, explicit invalidation or re-enable', async () => {
    const state = makeState();
    state.prepare(camera, physical, 0);
    state.stage(false, undefined);
    state.settle(true);
    expect(state.prepare(camera, physical, 1)).toBeDefined();
    state.stage(true, Promise.resolve());
    state.settle(true);
    await Promise.resolve();
    expect(
      state.prepare(
        {
          ...camera,
          planarReflection: {
            normal: new Float32Array([0, 1, 0]),
            distance: 0,
            clipBias: 0,
            distortion: 0,
            resolutionScale: 1,
            generateMipmaps: false,
            updateIntervalFrames: 4,
            requestVersion: 1,
          },
        },
        physical,
        2,
      ),
    ).toBeDefined();
    expect(state.prepare(camera, { ...physical, generation: 2 }, 2)).toBeDefined();
    state.prepare(undefined, undefined, 3);
    expect(state.current()).toBeUndefined();
    expect(state.prepare(camera, physical, 4)).toBeDefined();
  });
  it('restores the completed image and matrix when a resize capture does not submit', async () => {
    const state = makeState();
    const first = state.prepare(camera, physical, 0);
    state.stage(true, Promise.resolve());
    state.settle(true);
    await Promise.resolve();
    const replacement = { ...physical, generation: 2 };
    expect(state.prepare(camera, replacement, 1)?.physical).toBe(replacement);
    state.stage(false, undefined);
    state.settle(true);
    expect(state.current()).toBe(first);
    expect(state.prepare(camera, physical, 2)).toBeUndefined();
    expect(state.current()).toBe(first);
  });

  it('does not revive a removed target from a late completion', async () => {
    const state = makeState();
    let done!: () => void;
    const completion = new Promise<void>((resolve) => {
      done = resolve;
    });
    state.prepare(camera, physical, 0);
    state.stage(true, completion);
    state.settle(true);
    state.prepare(undefined, undefined, 1);
    done();
    await completion;
    expect(state.current()).toBeUndefined();
  });
  it('keeps two display views physically isolated while the low-frequency view holds', async () => {
    const a = makeState();
    const b = makeState();
    const firstA = a.prepare(camera, physical, 0);
    const allocated = createRenderTargetPhysical(device, physical.descriptor, 1);
    if (!allocated.ok) throw allocated.error;
    const second = allocated.value;
    const otherCamera = {
      ...camera,
      target: {} as NonNullable<CameraSnapshot['target']>,
      entityKey: 2,
    };
    const firstB = b.prepare(otherCamera, second, 0);
    if (firstA === undefined || firstB === undefined)
      throw new Error('Expected both planar captures');
    expect(firstA.physical.texture).not.toBe(firstB.physical.texture);
    expect(firstA.physical.texture).toBe(physical.texture);
    expect(firstB.physical.texture).toBe(second.texture);
    a.stage(true, Promise.resolve());
    a.settle(true);
    b.stage(true, Promise.resolve());
    b.settle(true);
    await Promise.resolve();
    expect(a.prepare(camera, physical, 1)).toBeUndefined();
    const nextB = b.prepare(otherCamera, second, 4);
    if (nextB === undefined) throw new Error('Expected updated planar capture');
    b.stage(true, Promise.resolve());
    b.settle(true);
    await Promise.resolve();
    expect(a.current()).toBe(firstA);
    expect(b.current()).toBe(nextB);
    expect(a.current()?.physical.texture).not.toBe(b.current()?.physical.texture);
    destroyRenderTargetPhysical(second);
  });
});
