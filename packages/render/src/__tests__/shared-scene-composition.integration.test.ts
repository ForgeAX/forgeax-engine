import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { createRenderPublisher } from '../publication/publisher';
import { renderPublicationTransfers } from '../publication/record';
import { RenderPublicationTargetOwner } from '../publication/targets';
import * as extraction from '../render-system-extract-tail';
import { MaterialDispatch } from '../scene/material-dispatch';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it.each(
  [1, 2, 4].flatMap((views) =>
    [false, true].flatMap((capture) =>
      [false, true].map((published) => ({ views, capture, published })),
    ),
  ),
)('prepares shared facts once for $views views (capture=$capture, published=$published)', async ({
  views,
  capture,
  published,
}) => {
  const source = { source: 'shared-scene-composition', epoch: 1 };
  const host = await createRenderer(
    { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement,
    { rhi, ...(published ? { publicationSource: source } : {}) },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const initialized = await host.initialization;
  if (!initialized.ok) throw initialized.error;
  const renderer = exposeRenderer(host);
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const targetOwner = published ? new RenderPublicationTargetOwner() : undefined;
  const targetAuthoring = targetOwner?.authoring ?? renderer;
  const created = capture
    ? targetAuthoring.createRenderTarget({
        shape: '2d',
        width: 16,
        height: 16,
        format: 'rgba16float',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: false,
      })
    : undefined;
  if (created !== undefined && !created.ok) throw created.error;
  const target = created?.ok ? created.value : undefined;
  if (target !== undefined)
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        {
          component: Camera,
          data: {
            aspect: 1,
            antialias: ANTIALIAS_NONE,
            bloom: BLOOM_DISABLED,
            target: world.allocSharedRef('RenderTarget', target),
          },
        },
      )
      .unwrap();
  for (let index = 0; index < views; index++) {
    const camera = world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 8] } },
        {
          component: Camera,
          data: { aspect: 1, antialias: ANTIALIAS_NONE, bloom: BLOOM_DISABLED },
        },
      )
      .unwrap();
    world.addComponent(camera, { component: CameraView, data: {} }).unwrap();
  }
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
    )
    .unwrap();
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  const attached = published ? undefined : renderer.attach(world);
  if (attached !== undefined && !attached.ok) throw attached.error;
  const lease = attached?.ok ? attached.value : undefined;
  const publisher = published
    ? createRenderPublisher(world, assets, source, undefined, [], targetOwner)
    : undefined;
  const extract = vi.spyOn(extraction, 'extractFrames');
  const query = vi.spyOn(MaterialDispatch.prototype, 'query');
  const draw = async () => {
    const candidate = publisher?.prepare(0).unwrap();
    const publication =
      candidate === undefined
        ? undefined
        : structuredClone(candidate.message, {
            transfer: renderPublicationTransfers(candidate.message),
          });
    candidate?.accept();
    extract.mockClear();
    query.mockClear();
    let request: Parameters<typeof renderer.draw>[0];
    if (publication !== undefined) request = { publication };
    else {
      if (lease === undefined) throw new Error('local scene needs an attached World lease');
      request = { leases: [lease], camera: { lease }, environment: { lease } };
    }
    const frame = renderer.draw(request);
    if (!frame.ok) throw frame.error;
    expect((await frame.value.completed).ok).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    return extract.mock.calls.filter((call) => call[4]?.renderables !== 'none').length;
  };
  try {
    expect(await draw()).toBe(published ? 0 : 1);
    world.set(entity, Transform, { pos: [1, 0, 0] }).unwrap();
    world.update(1 / 60).unwrap();
    propagateTransforms(world).unwrap();
    expect(await draw()).toBeLessThanOrEqual(1);
  } finally {
    extract.mockRestore();
    query.mockRestore();
    lease?.dispose();
    expect((await renderer.dispose()).ok).toBe(true);
    publisher?.dispose();
    targetOwner?.dispose();
  }
});
