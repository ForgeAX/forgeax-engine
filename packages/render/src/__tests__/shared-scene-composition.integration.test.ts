import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { definePackageId } from '@forgeax/engine-pack/source';
import { rhi } from '@forgeax/engine-rhi-null';
import { propagateTransforms, Transform, WaterBodyInstance } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  buildWaterPackOutputs,
  WATER_SYSTEM_RESOURCE,
  type WaterBodySourceAsset,
  WaterSystem,
} from '@forgeax/engine-water';
import { expect, it, vi } from 'vitest';
import { createRenderer, exposeRenderer } from '../assembly/factory';
import { Camera, MeshFilter, MeshRenderer } from '../components';
import { ANTIALIAS_NONE, BLOOM_DISABLED, perspective } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { createRenderPublisher } from '../publication/publisher';
import { renderPublicationTransfers } from '../publication/record';
import { RenderPublicationTargetOwner } from '../publication/targets';
import * as extraction from '../render-system-extract-tail';
import { MaterialDispatch } from '../scene/material-dispatch';
import { SceneComposition } from '../scene/scene-composition';
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
            ...perspective({ fov: Math.PI / 3, aspect: 1 }),
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
          data: {
            ...perspective({ fov: Math.PI / 3, aspect: 1 }),
            antialias: ANTIALIAS_NONE,
            bloom: BLOOM_DISABLED,
          },
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
  const extract = vi.spyOn(extraction, 'extractSource');
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
      request = { source: lease };
    }
    const frame = renderer.draw(request);
    if (!frame.ok) throw frame.error;
    expect((await frame.value.completed).ok).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    return extract.mock.calls.filter((call) => call[3]?.renderables !== 'none').length;
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

it.each([
  false,
  true,
])('refreshes retained ordinary Water owners without an ECS write (published=%s)', async (published) => {
  const source = { source: 'ordinary-water-generation', epoch: 1 };
  const host = await createRenderer(
    { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement,
    { rhi, ...(published ? { publicationSource: source } : {}) },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  (await host.initialization).unwrap();
  const renderer = exposeRenderer(host);
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: {} },
      { component: WaterBodyInstance, data: { body: 0 as never } },
    )
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 8] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 1 }),
          antialias: ANTIALIAS_NONE,
          bloom: BLOOM_DISABLED,
        },
      },
    )
    .unwrap();
  const bodySource: WaterBodySourceAsset = {
    kind: 'water-body',
    type: 'custom',
    baseHeightM: 0,
    maxWaveHeightM: 0,
    overlapPriority: 0,
    surfaceMaterialGuid: '00000000-0000-7000-8000-000000000001',
    spline: {
      closed: false,
      points: [0, 1].map((x) => ({
        inputKey: x,
        positionM: [x, 0, 0] as const,
        arriveTangentM: [1, 0, 0] as const,
        leaveTangentM: [1, 0, 0] as const,
        up: [0, 1, 0] as const,
        rollAngle: 0,
        angleUnit: 'degrees' as const,
        widthM: 1,
        depthM: 2,
        velocityMPerSec: 0,
        audioIntensity: 0,
      })),
    },
    flags: { affectsWaterInfo: false, affectsWaterMesh: false, affectsLandscape: false },
    collision: { type: 'none', enabled: false },
    queryFootprint: [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ],
  };
  const packed = (
    await buildWaterPackOutputs(
      { body: bodySource },
      { packageId: definePackageId('019a0000-0000-7000-8000-000000000987') },
    )
  ).unwrap();
  const body = packed.body;
  if (body?.kind !== 'water-body') throw new Error('Missing cooked Body');
  const water = new WaterSystem(
    () => undefined,
    () => [],
  );
  const guid = `scene-entity:${entity}`;
  water.mountBody(guid, '1', body).unwrap();
  world.insertResource(WATER_SYSTEM_RESOURCE, water);
  world.update(1 / 60).unwrap();
  propagateTransforms(world).unwrap();
  const lease = published ? undefined : renderer.attach(world).unwrap();
  const publisher = published ? createRenderPublisher(world, assets, source) : undefined;
  const slots = vi.spyOn(SceneComposition.prototype, 'compositionSlot');
  let composition: SceneComposition | undefined;
  const draw = async () => {
    const candidate = publisher?.prepare(0).unwrap();
    const publication =
      candidate === undefined
        ? undefined
        : structuredClone(candidate.message, {
            transfer: renderPublicationTransfers(candidate.message),
          });
    candidate?.accept();
    let request: Parameters<typeof renderer.draw>[0];
    if (publication !== undefined) request = { publication };
    else {
      if (lease === undefined) throw new Error('Missing local read lease');
      request = { source: lease };
    }
    const receipt = renderer.draw(request).unwrap();
    (await receipt.completed).unwrap();
    if (publication !== undefined)
      publisher?.recycle(publication.revision, renderPublicationTransfers(publication)).unwrap();
    composition ??= slots.mock.instances[0];
    if (composition === undefined) throw new Error('Missing retained composition');
    return composition.compositionSlot(0, entity)?.snapshot;
  };
  try {
    const held = await draw();
    expect(held?.waterOwner?.generation).toBe(water.snapshot(guid)?.sceneGeneration);
    water.hotReloadBody(guid, '2', body).unwrap();
    const discarded = publisher?.prepare(0).unwrap();
    discarded?.discard();
    const current = await draw();
    expect(current?.waterOwner?.generation).toBe(water.snapshot(guid)?.sceneGeneration);
    expect(current?.waterOwner?.generation).not.toBe(held?.waterOwner?.generation);
    expect(held?.waterOwner?.generation).toBe(1);
    expect(await draw()).toBe(current);
    water.unmountBody(guid);
    expect((await draw())?.waterOwner).toBeUndefined();
    water.mountBody(guid, '3', body).unwrap();
    expect((await draw())?.waterOwner?.generation).toBe(water.snapshot(guid)?.sceneGeneration);
    expect(held?.waterOwner?.generation).toBe(1);
  } finally {
    slots.mockRestore();
    lease?.dispose();
    publisher?.dispose();
    (await renderer.dispose()).unwrap();
  }
});
