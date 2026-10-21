import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { RhiNullQueue, rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import type { RenderFeature } from '../features/types';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

async function fixture() {
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
  world
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
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const meshHandle = assets.create(mesh).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: meshHandle } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
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
