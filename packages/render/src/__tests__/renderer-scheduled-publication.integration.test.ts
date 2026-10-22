import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { Skin } from '@forgeax/engine-skinning';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, CapsuleShadow, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { CameraView } from '../components/camera-view';
import type { RenderFeature } from '../features/types';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import { SkinTasks } from '../record/skin-tasks';
import { PersistentRenderScene } from '../scene/render-scene';
import { SkinSceneInputs } from '../scene/skin-scene-inputs';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

async function fixture(view = false, skin = false) {
  const identity = { source: 'scheduled-publication', epoch: 1 };
  const featureSubmitted = vi.fn();
  const sourceAcknowledged = vi.fn();
  const featureAborted = vi.fn();
  const feature: RenderFeature<null> = {
    identity: 'scheduled-publication-feature',
    extract: () => ok(null),
    plan: () =>
      ok({
        work: [{ scope: 'frame', resources: [], passes: [] }],
        sourceFeedback: 'submitted-feedback',
      }),
    onFrameSubmitted: () => {
      featureSubmitted();
    },
    onSourceFrameSubmitted: (_data, feedback) => {
      sourceAcknowledged(feedback);
    },
    onFrameAborted: () => {
      featureAborted();
    },
  };
  const host = await createRenderer(
    {
      width: 64,
      height: 64,
      getContext: () => null,
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement,
    {
      rhi,
      publicationSource: identity,
      features: [feature],
    },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const publisher = createRenderPublisher(world, assets, identity, undefined, [feature]);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8] } },
      {
        component: Camera,
        data: {
          fov: Math.PI / 3,
          aspect: 1,
          near: 0.1,
          far: 100,
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
        },
      },
    )
    .unwrap();
  if (view) world.addComponent(camera, { component: CameraView, data: {} }).unwrap();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const meshHandle = assets.create(mesh).unwrap();
  const renderable = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  if (skin) {
    const skeleton = assets
      .create({
        kind: 'skeleton',
        jointCount: 1,
        inverseBindMatrices: mat4.identity(mat4.create()),
      })
      .unwrap();
    const joint = world.spawn({ component: Transform, data: {} }).unwrap();
    world
      .addComponent(renderable, { component: Skin, data: { skeleton, joints: [joint] } })
      .unwrap();
    world.addComponent(renderable, { component: CapsuleShadow, data: {} }).unwrap();
  }
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  const nextRequest = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    return {
      publication: packet,
      onFeatureSourceSubmitted: (identity: string, feedback: unknown) => {
        publisher.acknowledgeFeatures(packet.revision, [{ identity, feedback }]).unwrap();
      },
    };
  };
  const submit = vi.spyOn(RhiNullQueue.prototype, 'submit');
  return {
    renderer,
    host,
    publisher,
    submit,
    featureSubmitted,
    sourceAcknowledged,
    featureAborted,
    request: nextRequest(),
    nextRequest,
    meshInput: {
      ...identity,
      meshHandle,
      mesh,
      revision: runtimeAssets(assets).version(meshHandle).unwrap(),
    },
  };
}

it.each([
  false,
  true,
])('cold recovers an existing published view through the actual Renderer entry (CameraView=%s)', async (view) => {
  const f = await fixture(view),
    scenes = new Set<PersistentRenderScene>();
  const actual = PersistentRenderScene.prototype.consumePublication;
  const consume = vi
    .spyOn(PersistentRenderScene.prototype, 'consumePublication')
    .mockImplementation(function (this: PersistentRenderScene, input) {
      scenes.add(this);
      return actual.call(this, input);
    });
  try {
    const firstResult = f.renderer.draw(f.request);
    if (!firstResult.ok) throw firstResult.error;
    const first = firstResult.value;
    expect((await first.completed).ok).toBe(true);
    expect(scenes.size).toBeGreaterThan(0);
    for (const scene of scenes) {
      expect(scene.compositionSlots().length).toBe(1);
      scene.invalidate();
    }
    scenes.clear();
    consume.mockClear();
    const delta = f.nextRequest();
    expect(delta.publication.baseline).toBe(false);
    expect(delta.publication.upserts.length).toBe(0);
    const nextResult = f.renderer.draw(delta);
    if (!nextResult.ok) throw nextResult.error;
    const next = nextResult.value;
    expect((await next.completed).ok).toBe(true);
    expect(scenes.size).toBeGreaterThan(0);
    for (const scene of scenes) expect(scene.compositionSlots().length).toBe(1);
    expect(consume.mock.calls.every(([input]) => input.packet.baseline)).toBe(true);
  } finally {
    consume.mockRestore();
    expect((await f.renderer.dispose()).ok).toBe(true);
    f.publisher.dispose();
    f.submit.mockRestore();
  }
});

it('resumes a real published Renderer frame through the shared Feature checkpoint exactly once', async () => {
  const f = await fixture();
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const checkpoint = vi.fn(() => paused);
  try {
    if (f.renderer.drawScheduled === undefined) throw new Error('Missing scheduled Renderer entry');
    const pending = f.renderer.drawScheduled(f.request, { checkpoint });
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.featureSubmitted).not.toHaveBeenCalled();
    expect(f.sourceAcknowledged).not.toHaveBeenCalled();
    resume();
    const result = await pending;
    if (!result.ok) throw result.error;
    expect(result.value.presentation).toBe('ready');
    expect((await result.value.completed).ok).toBe(true);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.featureSubmitted).toHaveBeenCalledOnce();
    expect(f.sourceAcknowledged).toHaveBeenCalledExactlyOnceWith('submitted-feedback');
    expect(f.featureAborted).not.toHaveBeenCalled();
  } finally {
    resume();
    const disposed = await f.renderer.dispose();
    expect(disposed.ok).toBe(true);
    f.publisher.dispose();
    f.submit.mockRestore();
  }
});

it('aborts a real published Renderer frame without resolving its checkpoint or submitting work', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const checkpoint = vi.fn(() => new Promise<void>(() => {}));
  try {
    if (f.renderer.drawScheduled === undefined) throw new Error('Missing scheduled Renderer entry');
    const pending = f.renderer.drawScheduled(f.request, { checkpoint, signal: controller.signal });
    await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.sourceAcknowledged).not.toHaveBeenCalled();
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.featureSubmitted).not.toHaveBeenCalled();
    expect(f.sourceAcknowledged).not.toHaveBeenCalled();
    expect(f.featureAborted).toHaveBeenCalledOnce();
    expect((await f.renderer.dispose()).ok).toBe(true);
    expect(f.renderer.state()).toBe('disposed');
  } finally {
    controller.abort();
    const disposed = await f.renderer.dispose();
    expect(disposed.ok).toBe(true);
    f.publisher.dispose();
    f.submit.mockRestore();
  }
});

it('rechecks the current preparation owner before preparing or releasing a real mesh lease', async () => {
  const f = await fixture();
  let resumeFirst!: () => void;
  let resumeSecond!: () => void;
  const firstTurn = new Promise<void>((resolve) => {
    resumeFirst = resolve;
  });
  const secondTurn = new Promise<void>((resolve) => {
    resumeSecond = resolve;
  });
  const firstCheckpoint = vi.fn(() => firstTurn);
  const secondCheckpoint = vi.fn(() => secondTurn);
  const lease = (await f.renderer.preparePublishedMeshResidency(f.meshInput)).unwrap();
  const prepare = vi.spyOn(f.host, 'preparePublishedMeshResidency');
  let second: ReturnType<NonNullable<typeof f.renderer.drawScheduled>> | undefined;
  try {
    const scheduled = f.renderer.drawScheduled;
    if (scheduled === undefined) throw new Error('Missing scheduled Renderer entry');
    const first = scheduled(f.request, { checkpoint: firstCheckpoint });
    await vi.waitFor(() => expect(firstCheckpoint).toHaveBeenCalledOnce());
    const next = f.nextRequest();
    // This callback is intentionally ahead of the two resource waiters.
    const startSecond = first.then(() => {
      second = scheduled(next, { checkpoint: secondCheckpoint });
    });
    const preparedAgain = f.renderer.preparePublishedMeshResidency(f.meshInput);
    const released = lease.release();
    expect(lease.isCurrent()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    resumeFirst();
    expect((await first).ok).toBe(true);
    await startSecond;
    await vi.waitFor(() => expect(secondCheckpoint).toHaveBeenCalledOnce());
    expect(lease.isCurrent()).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
    resumeSecond();
    expect((await second)?.ok).toBe(true);
    await released;
    expect(lease.isCurrent()).toBe(false);
    const prepared = await preparedAgain;
    expect(prepared.ok).toBe(true);
    expect(prepare).toHaveBeenCalledOnce();
    if (prepared.ok) await prepared.value.release();
  } finally {
    resumeFirst();
    resumeSecond();
    if (second !== undefined) await second;
    expect((await f.renderer.dispose()).ok).toBe(true);
    f.publisher.dispose();
    f.submit.mockRestore();
    prepare.mockRestore();
  }
});

it('retires the actual submitted Skin roots even when task completion throws synchronously', async () => {
  const f = await fixture(false, true),
    cause = new Error('injected synchronous task cleanup failure');
  const actualComplete = SkinTasks.prototype.complete,
    actualSubmit = SkinSceneInputs.prototype.submitFrame;
  let owner: SkinSceneInputs | undefined, retired: Promise<void> | undefined;
  const complete = vi.spyOn(SkinTasks.prototype, 'complete').mockImplementationOnce(function (
    this: SkinTasks,
  ) {
    const completion = actualComplete.call(this);
    if (completion !== undefined) void completion.catch(() => {});
    throw cause;
  });
  const submit = vi.spyOn(SkinSceneInputs.prototype, 'submitFrame').mockImplementation(function (
    this: SkinSceneInputs,
    ...args
  ) {
    owner = this;
    retired = actualSubmit.apply(this, args);
    return retired;
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = f.renderer.draw(f.request);
    if (result.ok) await result.value.completed;
    expect(complete).toHaveBeenCalledOnce();
    expect(f.submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(retired).toBeDefined();
    await retired;
    expect(owner?.recordingFrame()).toBeUndefined();
  } finally {
    complete.mockRestore();
    submit.mockRestore();
    errors.mockRestore();
    expect((await f.renderer.dispose()).ok).toBe(true);
    f.publisher.dispose();
    f.submit.mockRestore();
  }
});
