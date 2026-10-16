import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  type CookedMaterialRecord,
  serializeCookedMaterialRecord,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack';
import { err, RhiError } from '@forgeax/engine-rhi';
import { RhiNullQueue, RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { Materials } from '../materials';
import { ReadonlyDynamicInputPage } from '../surface/dynamic-input';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('keeps direct Surface submission live without preparing unused GPU shadows across failure and lane changes', async () => {
  const schema = {
    name: 'shadowLaneEvents',
    fields: [{ name: 'strength', type: 'f32' as const }],
    maxRecords: 1,
    maxDomains: 1,
    maxPageBytes: 16,
    maxBindings: 1,
    maxEventsPerSample: 1,
  };
  const authored: readonly MaterialAsset[] = [
    Materials.standard({ baseColor: [0.8, 0.2, 0.1, 1] }),
    {
      kind: 'material',
      parameters: [],
      values: {},
      surface: {
        model: 'single-layer-medium',
        module: 'forgeax_material::default_single_layer_medium_surface',
        dynamicInput: schema,
      },
      passes: [
        {
          name: 'Forward',
          program: { module: 'forgeax::single-layer-medium' },
          renderState: { tags: { LightMode: 'Forward' } },
        },
      ],
    },
  ];
  const cooker = createMaterialPackCooker();
  const publications: { guid: string; source: MaterialAsset; record: CookedMaterialRecord }[] = [];
  for (const [index, source] of authored.entries()) {
    const guid = `019f0000-0000-7000-8000-0000000008b${index}`;
    const cooked = await cooker.cook({ guid, source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    publications.push({ guid, source, record });
  }
  const originalFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/direct-shadow-index.json'))
      return new Response(
        JSON.stringify(
          publications.map(({ guid }) => ({
            guid,
            kind: 'material',
            packageUrl: '/direct-shadow.pack.json',
          })),
        ),
      );
    if (url.endsWith('/direct-shadow.pack.json'))
      return new Response(
        JSON.stringify({
          schemaVersion: '2.0.0',
          kind: 'internal-text-package',
          assets: publications.map(({ guid, source, record }) => ({
            guid,
            kind: 'material',
            payload: { ...source, cooked: JSON.parse(serializeCookedMaterialRecord(record)) },
            refs: [],
            artifacts: {},
          })),
        }),
      );
    return originalFetch(input, init);
  });
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    undefined,
    { shaderManifestUrl: renderLifecycleManifestUrl() },
    {
      rhi,
      createShaderModule: rhi.createShaderModule,
      createShaderModuleImmediate: rhi.createShaderModuleImmediate,
    },
  );
  const world = new World();
  const prepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepare');
  const shadowPrepare = vi.spyOn(GpuDrivenProduction.prototype, 'updateShadowViews');
  const directSurface = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'directSurfaceInstances');
  const viewUpdate = vi.spyOn(GpuDrivenView.prototype, 'update');
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  const errors: unknown[] = [];
  renderer.onError((error) => errors.push(error));
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const attachment = renderer.attach(world);
    if (!attachment.ok) throw attachment.error;
    const lease = attachment.value;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 30, antialias: 0 } },
      )
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0.25, -1, -0.45],
          castShadow: true,
          cascadeCount: 1,
          mapSize: 64,
        },
      })
      .unwrap();
    renderer.assetRegistry.configurePackIndex('/direct-shadow-index.json');
    const entities = [];
    for (const [index, publication] of publications.entries()) {
      const material = await renderer.assetRegistry.loadByGuid<MaterialAsset>(
        renderer.assetRegistry.parseGuid(publication.guid),
      );
      if (!material.ok) throw material.error;
      entities.push(
        world
          .spawn(
            { component: Transform, data: { pos: [index - 0.5, 0, 0] } },
            { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
            {
              component: MeshRenderer,
              data: { materials: [world.allocSharedRef('MaterialAsset', material.value)] },
            },
          )
          .unwrap(),
      );
    }
    const surfaceEntity = entities[1];
    if (surfaceEntity === undefined) throw new Error('missing Surface entity');
    const page = ReadonlyDynamicInputPage.create({
      sourceId: 'direct-shadow',
      pageId: 1,
      schema,
    }).unwrap();
    page.reconfigureDevice(0).unwrap();
    const consume = vi.spyOn(page, 'consume');
    const publishInput = (strength: number, frameTime: number) => {
      page.writeRecord(0, { strength }).unwrap();
      const range = page
        .reserveRange({
          domain: 'medium',
          recordStart: 0,
          recordCount: 1,
          instanceIndex: 7,
          member: {
            worldIdentity: world.identity,
            entityKey: surfaceEntity,
            drawItemIndex: 0,
            instanceOrdinal: 0,
          },
        })
        .unwrap();
      renderer.setSurfaceDynamicInput({ page, ranges: [range], projectionRevision: 1, frameTime });
    };
    const draw = (geometryLane: 'automatic' | 'direct') =>
      renderer.draw({
        leases: [lease],
        camera: { lease },
        environment: { lease },
        geometryLane,
      });
    const preparedFrame = (): PreparedGpuDrivenFrame => {
      const result = prepare.mock.results.at(-1)?.value;
      if (!result?.ok || result.value === undefined)
        throw new Error(`missing GPU preparation: ${JSON.stringify(errors)}`);
      return result.value;
    };
    world.update(1 / 60).unwrap();
    publishInput(0.25, 1);
    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(shadowPrepare).toHaveBeenCalled();
    expect(preparedFrame().shadowViewPool?.inspect().length).toBeGreaterThan(0);
    expect(preparedFrame().standardPbrFrameResources.materialBindGroups.length).toBeGreaterThan(0);
    expect(
      preparedFrame().standardPbrFrameResources.materialSlotIndicesByEntity.size,
    ).toBeGreaterThan(0);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);

    // Removing Surface leaves the direct scene on CPU resources. Adding it
    // again must restore the same page/time/instance owner and consume new input.
    world.removeComponent(surfaceEntity, MeshFilter).unwrap();
    renderer.setSurfaceDynamicInput(undefined);
    world.update(1 / 60).unwrap();
    viewUpdate.mockClear();
    directSurface.mockClear();
    consume.mockClear();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    expect(viewUpdate).not.toHaveBeenCalled();
    expect(directSurface).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(preparedFrame().standardPbrFrameResources.surfaceDynamicInput).toBeUndefined();
    world
      .addComponent(surfaceEntity, { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } })
      .unwrap();
    world.update(1 / 60).unwrap();
    publishInput(0.5, 4);
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    // First direct use completes the ordinary asynchronous material pipeline.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    expect(viewUpdate).toHaveBeenCalled();
    expect(directSurface).toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(preparedFrame().standardPbrFrameResources.surfaceDynamicInput).toBeDefined();
    expect(errors).toEqual([]);

    publishInput(0.75, 2);
    consume.mockClear();
    shadowPrepare.mockClear();
    vi.spyOn(RhiNullQueue.prototype, 'submit').mockReturnValueOnce(
      err(
        new RhiError({
          code: 'queue-submit-failed',
          expected: 'controlled failed submission',
          hint: 'retry this frame',
        }),
      ),
    );
    expect(draw('direct').ok).toBe(false);
    expect(errors).toContainEqual(expect.objectContaining({ code: 'queue-submit-failed' }));
    expect(consume).not.toHaveBeenCalled();
    expect(shadowPrepare).not.toHaveBeenCalled();
    expect(preparedFrame().shadowDrawKeys?.size).toBe(0);
    expect(preparedFrame().shadowViewPool?.inspect()).toEqual([]);
    expect(preparedFrame().standardPbrFrameResources.surfaceDynamicInput).toBeDefined();
    expect(preparedFrame().standardPbrFrameResources.materialBindGroups).toEqual([]);
    expect(preparedFrame().standardPbrFrameResources.materialSlotIndicesByEntity.size).toBe(0);
    expect(preparedFrame().standardPbrFrameResources.selectedMaterialSlots).toBeUndefined();

    // The first direct touch starts the ordinary published-program pipeline work.
    await new Promise((resolve) => setTimeout(resolve, 0));
    errors.length = 0;
    // Cancel the failed frame's pending shadow retirement by resuming automatic.
    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(shadowPrepare).toHaveBeenCalled();
    expect(preparedFrame().shadowViewPool?.inspect().length).toBeGreaterThan(0);
    expect(consume).toHaveBeenCalledTimes(1);

    publishInput(1, 3);
    consume.mockClear();
    shadowPrepare.mockClear();
    draws.mockClear();
    directSurface.mockClear();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    expect(shadowPrepare).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(directSurface).toHaveBeenCalled();
    expect(preparedFrame().standardPbrFrameResources.materialBindGroups).toEqual([]);
    expect(preparedFrame().standardPbrFrameResources.materialSlotIndicesByEntity.size).toBe(0);
    const passes = (draws.mock.contexts as RhiNullRenderPassEncoder[]).map((pass) => pass.passName);
    expect(passes.some((name) => name.startsWith('shadowCascade'))).toBe(true);
    expect(passes).toContain('single-layer-medium-nearest-layer');
    expect(passes).toContain('single-layer-medium-color');
    expect(errors).toEqual([]);

    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(shadowPrepare).toHaveBeenCalled();
    expect(preparedFrame().shadowDrawKeys?.size).toBeGreaterThan(0);
    expect(preparedFrame().shadowViewPool?.inspect().length).toBeGreaterThan(0);
    expect(preparedFrame().standardPbrFrameResources.materialBindGroups.length).toBeGreaterThan(0);
    expect(
      preparedFrame().standardPbrFrameResources.materialSlotIndicesByEntity.size,
    ).toBeGreaterThan(0);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);
  } finally {
    await renderer.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, 30_000);
