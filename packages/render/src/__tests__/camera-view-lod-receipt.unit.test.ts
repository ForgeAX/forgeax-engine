import { World } from '@forgeax/engine-ecs';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import {
  type LodObservationCapture,
  observeLodOcclusionCapture,
} from '../assembly/lod-observation';
import { ANTIALIAS_NONE, Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import type { LodOcclusionInspectionCell } from '../render-system';
import * as timingModule from '../renderer';
import { inspectLodOcclusion } from '../scene/visibility/inspection';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

async function createTimingReceiptFixture() {
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await renderer.initialization;
  if (!initialized.ok) throw initialized.error;
  const world = new World();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  registerPropagateTransforms(world);
  for (const [historyVersion, order] of [
    [4, 0],
    [9, 1],
  ] as const) {
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            historyVersion,
          },
        },
        { component: CameraView, data: { order } },
      )
      .unwrap();
  }
  const updated = world.update();
  if (!updated.ok) throw updated.error;
  const input = {
    leases: [attached.value],
    camera: { lease: attached.value },
    environment: { lease: attached.value },
  };
  const draw = async () => {
    const result = renderer.draw(input);
    if (!result.ok) throw result.error;
    if (result.value === undefined) throw new Error('expected submitted receipt');
    const completed = await result.value.completed;
    if (!completed.ok) throw completed.error;
    return result.value;
  };
  return { renderer, world, input, draw };
}

type FinalTimingAwaitScenario = 'new-submit' | 'detach' | 'invalid-draw' | 'queue-throw';

async function expectFinalTimingAwait(scenario: FinalTimingAwaitScenario) {
  const original = timingModule.observeGpuPassTimingDisabled;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(timingModule, 'observeGpuPassTimingDisabled').mockImplementationOnce(async (...args) => {
    enter();
    await gate;
    return original(...args);
  });
  const f = await createTimingReceiptFixture();
  try {
    const first = await f.draw();
    const pending = f.renderer.observe(first, { include: ['lod-occlusion'] });
    await entered;
    let replacement: typeof first | undefined;
    if (scenario === 'new-submit') {
      replacement = await f.draw();
      expect(replacement.frameId).toBeGreaterThan(first.frameId);
    } else if (scenario === 'detach') {
      f.renderer.detachScene(f.world);
      const reattached = f.renderer.attach(f.world);
      expect(reattached.ok).toBe(true);
      if (!reattached.ok) throw reattached.error;
      expect(reattached.value).not.toBe(f.input.leases[0]);
    } else if (scenario === 'invalid-draw') {
      expect(f.renderer.draw({ ...f.input, leases: [] }).ok).toBe(false);
    } else {
      vi.spyOn(RhiNullQueue.prototype, 'submit').mockImplementationOnce(() => {
        throw new Error('controlled queue submit failure');
      });
      expect(f.renderer.draw(f.input).ok).toBe(false);
    }
    release();
    const previous = await pending;
    expect(previous.ok).toBe(true);
    if (!previous.ok) throw previous.error;
    const reason =
      scenario === 'new-submit'
        ? 'superseded'
        : scenario === 'detach'
          ? 'lease-detached'
          : 'lod-readback-unavailable';
    expect(previous.value.lodOcclusion).toMatchObject({ status: 'unavailable', reason });
    if (replacement !== undefined) {
      const latest = await f.renderer.observe(replacement, { include: ['lod-occlusion'] });
      expect(latest.ok).toBe(true);
      if (!latest.ok) throw latest.error;
      expect(latest.value.lodOcclusion?.views).toHaveLength(2);
      expect(
        latest.value.lodOcclusion?.views.every(
          (view) => view.lodOcclusion?.submit.frameId === replacement.frameId,
        ),
      ).toBe(true);
      const repeated = await f.renderer.observe(replacement, { include: ['lod-occlusion'] });
      expect(repeated.ok).toBe(true);
      if (repeated.ok) expect(repeated.value.lodOcclusion).toBe(latest.value.lodOcclusion);
    }
  } finally {
    release();
    await f.renderer.dispose();
    vi.restoreAllMocks();
  }
}
describe('camera-view LOD receipt observation', () => {
  it('reports an actual accepted empty direct plan without inventing nonempty lineage or GPU telemetry', async () => {
    const f = await createTimingReceiptFixture();
    try {
      const receipt = await f.draw();
      const observed = await f.renderer.observe(receipt, { include: ['draws', 'lod-occlusion'] });
      if (!observed.ok) throw observed.error;
      expect(observed.value.draws).toEqual({ status: 'complete', draws: [] });
      expect(Object.isFrozen(observed.value.draws?.draws)).toBe(true);
      expect(observed.value.lodOcclusion?.status).toBe('unavailable');
    } finally {
      await f.renderer.dispose();
    }
  });

  it('validates the captured lease independently of other leases for the same World', async () => {
    const f = await createTimingReceiptFixture();
    try {
      const attached = f.renderer.attach(f.world);
      if (!attached.ok) throw attached.error;
      const other = attached.value;
      const receipt = await f.draw();
      other.dispose();
      const observed = await f.renderer.observe(receipt, { include: ['draws'] });
      if (!observed.ok) throw observed.error;
      const valid = observed.value;
      expect(valid.draws).toEqual({ status: 'complete', draws: [] });

      // Another live lease cannot keep this receipt's retired lease valid.
      const reattached = f.renderer.attach(f.world);
      if (!reattached.ok) throw reattached.error;
      const lease = f.input.leases[0];
      if (lease === undefined) throw new Error('expected attached scene lease');
      lease.dispose();
      const retirement = await f.renderer.observe(receipt, { include: ['draws', 'lod-occlusion'] });
      if (!retirement.ok) throw retirement.error;
      const retired = retirement.value;
      expect(retired.draws).toMatchObject({ status: 'unavailable', reason: 'lease-detached' });
      expect(retired.lodOcclusion).toMatchObject({
        status: 'unavailable',
        reason: 'lease-detached',
      });
    } finally {
      await f.renderer.dispose();
    }
  });

  it('keeps each rendered Camera generation in the receipt roster without claiming Null-RHI telemetry', async () => {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);

    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const spawnCamera = (historyVersion: number, order: number) =>
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          {
            component: Camera,
            data: {
              fov: 1,
              aspect: 1,
              near: 0.1,
              far: 100,
              antialias: ANTIALIAS_NONE,
              historyVersion,
            },
          },
          { component: CameraView, data: { order } },
        )
        .unwrap();
    const first = spawnCamera(4, 0);
    const second = spawnCamera(9, 1);
    expect(world.update().ok).toBe(true);

    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    if (frame.value === undefined) return;

    const observation = await renderer.observe(frame.value, { include: ['lod-occlusion'] });
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    const lod = observation.value.lodOcclusion;
    expect(lod).toBeDefined();
    expect(lod?.status).toBe('unavailable');
    if (lod?.status === 'unavailable') expect(lod.reason).toBe('lod-readback-unavailable');
    expect(lod).toMatchObject({
      views: [
        { entityKey: Number(first), viewGeneration: 4, state: 'rendered' },
        { entityKey: Number(second), viewGeneration: 9, state: 'rendered' },
      ],
    });
    expect(lod?.views.map((view) => view.lodOcclusion?.submit.frameId)).toEqual([
      frame.value.frameId,
      frame.value.frameId,
    ]);
    expect(lod?.views.map((view) => view.lodOcclusion?.view.viewGeneration)).toEqual([4, 9]);
    expect(JSON.parse(JSON.stringify(lod))).toEqual(lod);
    expect(Object.isFrozen(lod)).toBe(true);
    expect(Object.isFrozen(lod?.views)).toBe(true);
    expect(Object.isFrozen(lod?.views[0]?.lodOcclusion?.worlds)).toBe(true);

    await renderer.dispose();
  });

  it('marks a captured view held when its CameraView update interval skips this submit', async () => {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            fov: 1,
            aspect: 1,
            near: 0.1,
            far: 100,
            antialias: ANTIALIAS_NONE,
            historyVersion: 7,
          },
        },
        { component: CameraView, data: { updateInterval: 3 } },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const input = {
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    };
    const first = renderer.draw(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    if (first.value === undefined) return;
    expect((await first.value.completed).ok).toBe(true);
    const second = renderer.draw(input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    if (second.value === undefined) return;

    const observation = await renderer.observe(second.value, { include: ['lod-occlusion'] });
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(observation.value.lodOcclusion).toMatchObject({
      status: 'unavailable',
      reason: 'held-view',
      views: [
        { viewKey: String(camera), entityKey: Number(camera), viewGeneration: 7, state: 'held' },
      ],
    });
    await renderer.dispose();
  });

  it('rejects an unobserved receipt after a newer successful submit replaces its capture', async () => {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE },
        },
        { component: CameraView, data: {} },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const input = {
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    };
    const first = renderer.draw(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    if (first.value === undefined) return;
    expect((await first.value.completed).ok).toBe(true);
    const second = renderer.draw(input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    if (second.value === undefined) return;

    const superseded = await renderer.observe(first.value, { include: ['lod-occlusion'] });
    expect(superseded.ok).toBe(true);
    if (!superseded.ok) return;
    expect(superseded.value.lodOcclusion).toEqual({
      status: 'unavailable',
      reason: 'superseded',
      views: [],
    });
    const latest = await renderer.observe(second.value, { include: ['lod-occlusion'] });
    expect(latest.ok).toBe(true);
    if (!latest.ok) return;
    const repeated = await renderer.observe(second.value, { include: ['lod-occlusion'] });
    expect(repeated.ok).toBe(true);
    if (repeated.ok) expect(repeated.value.lodOcclusion).toBe(latest.value.lodOcclusion);
    await renderer.dispose();
  });

  it('rejects detach and reattach of the same World by the original lease identity', async () => {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE },
        },
        { component: CameraView, data: {} },
      )
      .unwrap();
    expect(world.update().ok).toBe(true);
    const frame = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    if (frame.value === undefined) return;
    expect((await frame.value.completed).ok).toBe(true);

    renderer.detachScene(world);
    const reattached = renderer.attach(world);
    expect(reattached.ok).toBe(true);
    if (!reattached.ok) return;
    expect(reattached.value).not.toBe(attached.value);
    const observation = await renderer.observe(frame.value, { include: ['lod-occlusion'] });
    expect(observation.ok).toBe(true);
    if (!observation.ok) return;
    expect(observation.value.lodOcclusion).toMatchObject({
      status: 'unavailable',
      reason: 'lease-detached',
      views: [{ entityKey: expect.any(Number), state: 'rendered' }],
    });
    await renderer.dispose();
  });

  it('rechecks both captured Camera leases after a receipt observation is cached', async () => {
    const renderer = await createRenderer(
      { width: 64, height: 64, getContext: () => null },
      { rhi },
      { shaderManifestUrl: renderLifecycleManifestUrl() },
    );
    try {
      expect((await renderer.initialization).ok).toBe(true);
      const world = new World();
      const attached = renderer.attach(world);
      expect(attached.ok).toBe(true);
      if (!attached.ok) return;
      registerPropagateTransforms(world);
      for (const order of [0, 1]) {
        world
          .spawn(
            { component: Transform, data: { pos: [0, 0, 4] } },
            {
              component: Camera,
              data: {
                fov: 1,
                aspect: 1,
                near: 0.1,
                far: 100,
                antialias: ANTIALIAS_NONE,
                historyVersion: order === 0 ? 4 : 9,
              },
            },
            { component: CameraView, data: { order } },
          )
          .unwrap();
      }
      expect(world.update().ok).toBe(true);

      const frame = renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok) return;
      if (frame.value === undefined) return;
      expect((await renderer.observe(frame.value, { include: ['lod-occlusion'] })).ok).toBe(true);

      renderer.detachScene(world);
      const reattached = renderer.attach(world);
      expect(reattached.ok).toBe(true);
      if (!reattached.ok) return;
      expect(reattached.value).not.toBe(attached.value);

      const repeated = await renderer.observe(frame.value, { include: ['lod-occlusion'] });
      expect(repeated.ok).toBe(true);
      if (!repeated.ok) return;
      expect(repeated.value.lodOcclusion).toMatchObject({
        status: 'unavailable',
        reason: 'lease-detached',
        views: [
          { entityKey: expect.any(Number), viewGeneration: 4, state: 'rendered' },
          { entityKey: expect.any(Number), viewGeneration: 9, state: 'rendered' },
        ],
      });
    } finally {
      await renderer.dispose();
    }
  });

  it('accepts owner readback and rejects replaced inspections or graphs', async () => {
    const submit = { frameId: 5, build: 'test-build', deviceGeneration: 2 };
    const makeInspection = () => {
      const row = {
        root: { guid: 'lod-root', sourceKey: 'lod-root' },
        view: {
          attachmentId: 'world-a',
          cameraEntity: 7,
          viewRole: 'main' as const,
          viewGeneration: 4,
        },
        slot: { primitiveSlot: 0, slotGeneration: 1 },
        generation: 8,
        count: { candidates: 1, visible: 1, occluded: 0 },
        lodHistogram: [{ level: 0, count: 1 }],
        samples: [],
      };
      return inspectLodOcclusion({
        ...row,
        submit,
        worlds: [
          {
            attachmentId: 'world-a',
            rows: [row],
            attribution: { status: 'same-submit', submit },
          },
        ],
      });
    };
    const capturedInspection = makeInspection();
    const replacementInspection = makeInspection();
    let currentInspection = capturedInspection;
    const graphIncarnation = {};
    let currentGraphIncarnation: object = graphIncarnation;
    let readback: LodObservationCapture['views'][number]['system']['observeLodOcclusion'] =
      async () => {
        currentInspection = replacementInspection;
        return undefined;
      };
    const cells = new WeakMap<object, LodOcclusionInspectionCell>();
    const cellOf = (inspection: typeof capturedInspection): LodOcclusionInspectionCell => {
      let cell = cells.get(inspection);
      if (cell === undefined) {
        cell = { view: inspection.view, submit: inspection.submit, value: () => inspection };
        cells.set(inspection, cell);
      }
      return cell;
    };
    const system = {
      get lodOcclusion() {
        return cellOf(currentInspection);
      },
      perFrameGraphInfo: { generation: 11 },
      get perFrameGraphIncarnation() {
        return currentGraphIncarnation;
      },
      gpuDrivenInspection: { overflow: false, channels: [] },
      observeLodOcclusion: () => readback(),
    } as unknown as LodObservationCapture['views'][number]['system'];
    const lease = {} as LodObservationCapture['leases'][number]['lease'];
    const capture: LodObservationCapture = {
      frameId: submit.frameId,
      deviceGeneration: submit.deviceGeneration,
      views: [
        {
          viewKey: '7',
          entityKey: 7,
          eye: undefined,
          attachmentId: 'world-a',
          viewGeneration: 4,
          graphGeneration: 11,
          graphIncarnation,
          state: 'rendered',
          system,
          viewRef: {},
          primary: false,
          inspection: cellOf(capturedInspection),
        },
      ],
      leases: [{ lease, worldIdentity: 'world-a', generation: 3 }],
    };

    const ownerInspection = makeInspection();
    readback = async () => {
      currentInspection = ownerInspection;
      return ownerInspection;
    };
    const accepted = await observeLodOcclusionCapture(
      { frameId: submit.frameId, deviceGeneration: submit.deviceGeneration },
      capture,
      {
        isLatest: () => true,
        isViewCurrent: () => true,
        isLeaseAttached: () => true,
      },
    );
    expect(accepted.status).toBe('complete');
    if (accepted.status === 'complete')
      expect(accepted.views[0]?.lodOcclusion).toBe(ownerInspection);

    currentInspection = capturedInspection;
    readback = async () => {
      currentInspection = replacementInspection;
      return undefined;
    };
    const detachedReplacement = await observeLodOcclusionCapture(
      { frameId: submit.frameId, deviceGeneration: submit.deviceGeneration },
      capture,
      {
        isLatest: () => true,
        isViewCurrent: () => true,
        isLeaseAttached: () => true,
      },
    );
    expect(detachedReplacement).toMatchObject({
      status: 'unavailable',
      reason: 'lod-readback-unavailable',
      views: [{ viewKey: '7', state: 'rendered' }],
    });
    currentInspection = capturedInspection;
    currentGraphIncarnation = {};
    readback = async () => undefined;
    const replacedGraph = await observeLodOcclusionCapture(
      { frameId: submit.frameId, deviceGeneration: submit.deviceGeneration },
      capture,
      {
        isLatest: () => true,
        isViewCurrent: () => true,
        isLeaseAttached: () => true,
      },
    );
    expect(replacedGraph).toMatchObject({
      status: 'unavailable',
      reason: 'graph-generation-mismatch',
    });
  });
  it('rechecks a receipt superseded during the final timing await', async () => {
    await expectFinalTimingAwait('new-submit');
  });

  it('rechecks lease identity after detach during the final timing await', async () => {
    await expectFinalTimingAwait('detach');
  });

  it.each([
    'invalid-draw',
    'queue-throw',
  ] as const)('keeps the current receipt when %s fails during the final timing await', async (scenario) => {
    await expectFinalTimingAwait(scenario);
  });
});
