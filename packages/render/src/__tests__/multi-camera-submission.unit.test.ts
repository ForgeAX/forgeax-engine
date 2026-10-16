import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import {
  type FrameRecording,
  profileFrameRecording,
  recordFrameTransaction,
  submitFrameRecordings,
} from '../assembly/frame-recording';
import { Camera } from '../components/camera';
import { CameraView, cameraViewExtent } from '../components/camera-view';
import { PlanarReflection } from '../components/planar-reflection';
import { ProjectedDecalInvalidError } from '../decals/component';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';
import { renderComponentsPlugin } from '../plugin';
import {
  prepareExtractContext,
  projectAuxiliaryCamerasForView,
  selectCameraRoles,
} from '../render-system-extract';
import { extractFrame } from '../render-system-extract-tail';
import { createRenderTargetOwner } from '../targets/owner';

function fixture(fail: 'none' | 'finish' | 'submit' = 'none') {
  const finish = vi.fn(() =>
    fail === 'finish' ? { ok: false, error: { code: 'finish-failure' } } : { ok: true, value: {} },
  );
  const submit = vi.fn(() =>
    fail === 'submit'
      ? { ok: false, error: { code: 'submit-failure' } }
      : { ok: true, value: undefined },
  );
  const encoder = { finish } as unknown as RhiCommandEncoder;
  const device = { queue: { submit } } as unknown as RhiDevice;
  const committed: number[] = [],
    aborted: number[] = [],
    encoded: number[] = [];
  function* record(id: number, reject = false): FrameRecording {
    const result = yield* recordFrameTransaction(
      {
        build: () => ({ ok: true, value: id }),
        execute: () => {
          encoded.push(id);
          return reject ? { ok: false, stage: 'execute' } : { ok: true, value: undefined };
        },
        finish: () => ({ ok: true, value: undefined }),
        commit: () => committed.push(id),
        abort: () => aborted.push(id),
      },
      { encoder, device, reportError: () => undefined },
    );
    return result.ok;
  }
  return { finish, submit, committed, aborted, encoded, record };
}

describe('multi-camera submission barrier', () => {
  it('encodes all views before one finish/submit and commits each only afterwards', () => {
    const f = fixture();
    expect(
      submitFrameRecordings([f.record(1), f.record(2)], () => {
        expect(f.encoded).toEqual([1, 2]);
        expect(f.committed).toEqual([]);
        return true;
      }),
    ).toBe(true);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.committed).toEqual([1, 2]);
    expect(f.aborted).toEqual([]);
  });
  it.each([
    'finish',
    'submit',
  ] as const)('keeps every history unchanged after %s fails', (failure) => {
    const f = fixture(failure);
    if (failure === 'submit')
      expect(() => submitFrameRecordings([f.record(1), f.record(2)])).toThrowError(
        expect.objectContaining({
          code: 'frame-submit-rejected',
          detail: { operation: 'draw', stage: 'submit', accepted: false },
        }),
      );
    else expect(submitFrameRecordings([f.record(1), f.record(2)])).toBe(false);
    expect(f.committed).toEqual([]);
    expect(f.aborted).toEqual([1, 2]);
  });
  it('aborts a previously encoded camera if a later camera cannot encode', () => {
    const f = fixture();
    expect(submitFrameRecordings([f.record(1), f.record(2, true)])).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.committed).toEqual([]);
    expect(f.aborted.sort()).toEqual([1, 2]);
  });
  it('keeps profiling around active segments of the same recording', () => {
    const f = fixture(),
      run = vi.fn((action: () => unknown) => action());
    expect(submitFrameRecordings([profileFrameRecording(f.record(1), run as never)])).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(f.committed).toEqual([1]);
  });
});

describe('one feature host for the complete view roster', () => {
  const inputs = () =>
    ['left', 'right'].map((identity) => ({
      identity,
      render: true,
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: {} as never,
    }));
  function producer() {
    const extract = vi.fn(({ views }) =>
      ok(views.map((view: { identity: string }) => view.identity)),
    );
    const plan = vi.fn((identities: string[]) =>
      ok({
        work: [
          { scope: 'frame' as const, resources: [], passes: [] },
          ...identities.map((view) => ({ scope: { view }, resources: [], passes: [] })),
        ],
        sourceFeedback: { tick: 1 },
      }),
    );
    const submitted = vi.fn(),
      aborted = vi.fn(),
      acknowledged = vi.fn();
    const feature: RenderFeature<string[]> = {
      identity: 'shared.feature',
      extract,
      plan,
      onFrameSubmitted: submitted,
      onFrameAborted: aborted,
      onSourceFrameSubmitted: acknowledged,
    };
    return { feature, extract, plan, submitted, aborted, acknowledged };
  }
  it('extracts and plans once, then acknowledges only the outer accepted submission', () => {
    const f = producer(),
      host = createRenderFeatureHost([f.feature]).unwrap();
    try {
      const batch = runRenderFeatureFrame(host, inputs());
      expect(f.extract).toHaveBeenCalledTimes(1);
      expect(f.plan).toHaveBeenCalledWith(
        ['left', 'right'],
        expect.objectContaining({ views: expect.any(Array) }),
      );
      for (const view of batch.views.values()) view.onSubmitted();
      expect(f.submitted).not.toHaveBeenCalled();
      expect(f.acknowledged).not.toHaveBeenCalled();
      batch.frame.onSubmitted();
      batch.onSubmitted();
      batch.onSubmitted();
      expect(f.submitted).toHaveBeenCalledTimes(1);
      expect(
        f.submitted.mock.calls[0]?.[1].works.map((work: { scope: unknown }) => work.scope),
      ).toEqual(['frame', { view: 'left' }, { view: 'right' }]);
      expect(f.acknowledged).toHaveBeenCalledExactlyOnceWith(['left', 'right'], { tick: 1 });
    } finally {
      host.dispose();
    }
  });
  it('aborts all feature work once and retries without consuming source intents twice', () => {
    const f = producer(),
      host = createRenderFeatureHost([f.feature]).unwrap();
    try {
      const rejected = runRenderFeatureFrame(host, inputs());
      rejected.views.get('left')?.onSubmitted();
      rejected.onAborted();
      rejected.onSubmitted();
      expect(f.aborted).toHaveBeenCalledTimes(1);
      expect(f.acknowledged).not.toHaveBeenCalled();
      const retry = runRenderFeatureFrame(host, inputs().reverse());
      retry.frame.onSubmitted();
      for (const view of retry.views.values()) view.onSubmitted();
      retry.onSubmitted();
      expect(f.submitted).toHaveBeenCalledTimes(1);
      expect(f.acknowledged).toHaveBeenCalledExactlyOnceWith(['right', 'left'], { tick: 1 });
    } finally {
      host.dispose();
    }
  });
  it('plans one worker publication and returns one source acknowledgement', () => {
    const f = producer(),
      host = createRenderFeatureHost([f.feature]).unwrap();
    const acknowledge = vi.fn();
    try {
      const batch = runRenderFeatureFrame(
        host,
        inputs().map((input) => ({
          ...input,
          publishedFeatures: [{ identity: f.feature.identity, data: ['left', 'right'] }],
          onFeatureSourceSubmitted: acknowledge,
        })),
      );
      expect(f.extract).not.toHaveBeenCalled();
      expect(f.plan).toHaveBeenCalledTimes(1);
      batch.frame.onSubmitted();
      for (const view of batch.views.values()) view.onSubmitted();
      batch.onSubmitted();
      expect(acknowledge).toHaveBeenCalledExactlyOnceWith(f.feature.identity, { tick: 1 });
      expect(f.acknowledged).not.toHaveBeenCalled();
    } finally {
      host.dispose();
    }
  });
});

it('derives split and scaled extents before camera frustum extraction without changing World', () => {
  const world = new World();
  const camera = world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: { aspect: 4, near: 0.1, far: 100, fov: Math.PI / 3 } },
      { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], resolutionScale: 0.5 } },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  const extent = cameraViewExtent(world.get(camera, CameraView).unwrap(), 800, 400);
  expect(extent).toMatchObject({
    x: 400,
    width: 400,
    height: 400,
    renderWidth: 200,
    renderHeight: 200,
  });
  const frame = extractFrame(
    world,
    prepareExtractContext(world, {
      cameraEntityKey: Number(camera),
      renderables: 'none',
      viewExtent: { width: extent.renderWidth, height: extent.renderHeight },
    }),
  );
  expect(frame.cameras[0]?.aspect).toBe(1);
  expect(world.get(camera, Camera).unwrap().aspect).toBe(4);
});

it('retains planar auxiliary cameras when CameraView selects a display extent', () => {
  const world = new World();
  const target = createRenderTargetOwner({ rendererId: Symbol(), getGeneration: () => 1 }).create({
    shape: '2d',
    width: 64,
    height: 64,
    format: 'rgba16float',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: false,
  });
  if (!target.ok) throw target.error;
  const display = world
    .spawn(
      { component: Transform, data: { pos: [0, 3, 5] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
      { component: CameraView, data: {} },
    )
    .unwrap();
  world
    .addComponent(display, {
      component: PlanarReflection,
      data: { target: world.allocSharedRef('RenderTarget', target.value) },
    })
    .unwrap();
  propagateTransforms(world).unwrap();
  const roles = selectCameraRoles(world, Number(display), { width: 320, height: 180 });
  expect(roles.display).toHaveLength(1);
  expect(roles.auxiliary).toHaveLength(1);
  expect(roles.auxiliary[0]?.planarReflection).toBeDefined();
  const selectedDisplay = roles.display[0];
  if (selectedDisplay === undefined) throw new Error('Expected a selected display camera');
  const otherDisplay = { ...selectedDisplay, world: new Float32Array(selectedDisplay.world) };
  otherDisplay.world[12] = 7;
  const projected = projectAuxiliaryCamerasForView(otherDisplay, roles.auxiliary);
  expect(projected[0]?.world).not.toEqual(roles.auxiliary[0]?.world);
});

it('does not schedule a target CameraView again as an auxiliary capture', () => {
  const world = new World();
  const target = createRenderTargetOwner({ rendererId: Symbol(), getGeneration: () => 1 }).create({
    shape: '2d',
    width: 64,
    height: 64,
    format: 'rgba8unorm',
    mipLevels: 1,
    sampleCount: 1,
    sampled: true,
    readback: false,
  });
  if (!target.ok) throw target.error;
  const display = world
    .spawn(
      { component: Transform, data: {} },
      { component: Camera, data: { target: world.allocSharedRef('RenderTarget', target.value) } },
      { component: CameraView, data: {} },
    )
    .unwrap();
  propagateTransforms(world).unwrap();
  const roles = selectCameraRoles(world, Number(display), { width: 64, height: 64 });
  expect(roles.display.map((camera) => camera.entityKey)).toEqual([Number(display)]);
  expect(roles.auxiliary).toEqual([]);
});

it('preserves a structured view failure after finalizing the frame', () => {
  const f = fixture();
  const error = new ProjectedDecalInvalidError('renderPath', 'Standard Deferred');
  function* rejected(): FrameRecording {
    yield* f.record(1);
    throw error;
  }
  let failure: unknown;
  try {
    submitFrameRecordings([rejected(), f.record(2)]);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBe(error);
  expect(f.committed).toEqual([1, 2]);
});

it('aggregates multiple failures after draining every view continuation', () => {
  const f = fixture();
  const errors = [new Error('first view'), new Error('second view')];
  function* rejected(index: number): FrameRecording {
    yield* f.record(index + 1);
    throw errors[index];
  }
  let failure: unknown;
  try {
    submitFrameRecordings([rejected(0), rejected(1), f.record(3)]);
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error('Expected aggregate failure');
  expect(failure.errors).toEqual(errors);
  expect(f.committed).toEqual([1, 2, 3]);
});

it('drains the remaining view continuations even if one commit throws', () => {
  const f = fixture();
  function* throwing(): FrameRecording {
    yield* f.record(1);
    throw new Error('commit failed');
  }
  expect(() => submitFrameRecordings([throwing(), f.record(2)])).toThrow('commit failed');
  expect(f.committed).toEqual([1, 2]);
});

it('keeps a subpixel viewport inside the physical surface and rejects invalid fields', () => {
  const world = new World();
  const camera = world
    .spawn({ component: CameraView, data: { viewport: [0.9999, 0.9999, 0.0001, 0.0001] } })
    .unwrap();
  const config = world.get(camera, CameraView).unwrap();
  expect(cameraViewExtent(config, 100, 100)).toMatchObject({ x: 99, y: 99, width: 1, height: 1 });
  expect(() => cameraViewExtent({ ...config, resolutionScale: 0 }, 100, 100)).toThrow(
    'resolutionScale',
  );
  expect(() => cameraViewExtent({ ...config, updateInterval: 0 }, 100, 100)).toThrow(
    'updateInterval',
  );
});

it('publishes CameraView through the installed render component vocabulary', async () => {
  const world = new World();
  const context = await createWorldContext(world, [renderComponentsPlugin()]);
  expect([...world.components.entries()].map(([name]) => name)).toContain('CameraView');
  await context.fiber.dispose();
});
