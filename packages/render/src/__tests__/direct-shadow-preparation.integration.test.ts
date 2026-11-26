import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { err, RhiError } from '@forgeax/engine-rhi';
import { RhiNullQueue, RhiNullRenderPassEncoder, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { prepareRuntimeMaterialTemplates } from '../../../assets-runtime/src/__tests__/fixtures/runtime-material';
import { prepareShaderProgramCompiler } from '../../../shader-compiler/src/program';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer, SpotLight } from '../components';
import { ShadowMeshReads } from '../device/mesh-changes';
import { GpuDrivenProduction, type PreparedGpuDrivenFrame } from '../gpu-driven/production-raster';
import { MaterialAbiRasterAdapter } from '../gpu-driven/production-raster-material';
import { BatchRowAssembly } from '../gpu-driven/production-raster-rows';
import { sealSourceDraws } from '../gpu-driven/source-draw-indices';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { Materials } from '../materials';
import * as shadowReads from '../record/frame-gpu-driven';
import * as frameGpuInput from '../record/frame-gpu-driven-input';
import { ReadonlyDynamicInputPage } from '../surface/dynamic-input';
import { receiptRow } from './gpu-draw-selection-fixture';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

const BUILTIN_CUBE = createPrimitiveMesh('cube').unwrap();

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
  const publications = authored.map((source, index) => ({
    guid: `019f0000-0000-7000-8000-0000000008b${index}`,
    source,
  }));
  const installMaterials = await prepareRuntimeMaterialTemplates(publications);
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    undefined,
    { shaderManifestUrl: renderLifecycleManifestUrl(), prepareShaderProgramCompiler },
    {
      rhi,
      createShaderModule: rhi.createShaderModule,
      createShaderModuleImmediate: rhi.createShaderModuleImmediate,
    },
  );
  const world = new World({ assets: renderer.assetRegistry });
  const frameInputs = vi.spyOn(frameGpuInput, 'buildFrameGpuDrivenInput');
  const captureAtlas = vi.spyOn(shadowReads, 'directionalAtlasMaterialReads');
  const prepare = vi.spyOn(GpuDrivenProduction.prototype, 'prepare');
  const shadowPrepare = vi.spyOn(GpuDrivenProduction.prototype, 'updateShadowViews');
  const indirectRows = vi.spyOn(BatchRowAssembly.prototype, 'assemble');
  const directSurface = vi.spyOn(MaterialAbiRasterAdapter.prototype, 'directSurfaceInstances');
  const viewUpdate = vi.spyOn(GpuDrivenView.prototype, 'update');
  const draws = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'drawIndexed');
  const endedPasses = vi.spyOn(RhiNullRenderPassEncoder.prototype, 'end');
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
    const sun = world
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
    installMaterials(renderer.assetRegistry);
    const entities = [];
    for (const [index, publication] of publications.entries()) {
      const material = await renderer.assetRegistry.load(
        renderer.assetRegistry.parseGuid(publication.guid),
        'material',
      );
      if (!material.ok) throw material.error;
      entities.push(
        world
          .spawn(
            { component: Transform, data: { pos: [index - 0.5, 0, 0] } },
            {
              component: MeshFilter,
              data: { assetHandle: renderer.assetRegistry.create(BUILTIN_CUBE).unwrap() },
            },
            {
              component: MeshRenderer,
              data: { materials: [material.value] },
            },
          )
          .unwrap(),
      );
    }
    const solidEntity = entities[0];
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
      renderer.draw({ source: lease, geometryLane });
    const preparedFrame = (): PreparedGpuDrivenFrame => {
      const result = prepare.mock.results.at(-1)?.value;
      if (!result?.ok || result.value === undefined)
        throw new Error(`missing GPU preparation: ${JSON.stringify(errors)}`);
      return result.value;
    };
    const encodedIndirectDraws = () => {
      const production = prepare.mock.contexts.at(-1);
      if (!(production instanceof GpuDrivenProduction)) throw new Error('missing production owner');
      // Witness actual encoding, independent of how the accepted table is indexed.
      return production.inspect().encodedIndirectDraws;
    };
    world.update(1 / 60).unwrap();
    publishInput(0.25, 1);
    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(shadowPrepare).toHaveBeenCalled();
    expect(preparedFrame().shadowViewPool?.inspect().length).toBeGreaterThan(0);
    expect(typeof preparedFrame().standardPbrFrameResources.prepareMaterialBinding).toBe(
      'function',
    );
    expect(encodedIndirectDraws()).toBeGreaterThan(0);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);

    // Removing Surface leaves the direct scene on CPU resources. Adding it
    // again must restore the same page/time/instance owner and consume new input.
    world.removeComponent(surfaceEntity, MeshFilter).unwrap();
    renderer.setSurfaceDynamicInput(undefined);
    world.update(1 / 60).unwrap();
    viewUpdate.mockClear();
    directSurface.mockClear();
    indirectRows.mockClear();
    consume.mockClear();
    const meshRead = vi.spyOn(ShadowMeshReads.prototype, 'add');
    captureAtlas.mockClear();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    // The first direct atlas holds its issued meshes. GPU preparation has no
    // physical shadow views in this lane and must not also retain each batch.
    const directRows = captureAtlas.mock.calls.at(-1)?.[2];
    assert(directRows !== undefined && directRows.length > 0);
    expect(meshRead.mock.calls.map(([token]) => token)).toEqual(
      Array.from(directRows, (row) => row.mesh.changeToken),
    );
    meshRead.mockRestore();
    expect(viewUpdate).not.toHaveBeenCalled();
    expect(indirectRows).not.toHaveBeenCalled();
    expect(
      captureAtlas.mock.calls.some(
        ([, , rows, , , projection]) =>
          rows !== undefined && rows.length > 0 && projection !== undefined,
      ),
    ).toBe(true);
    expect(directSurface).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(preparedFrame().standardPbrFrameResources.surfaceDynamicInput).toBeUndefined();
    world
      .addComponent(surfaceEntity, {
        component: MeshFilter,
        data: { assetHandle: renderer.assetRegistry.create(BUILTIN_CUBE).unwrap() },
      })
      .unwrap();
    world.update(1 / 60).unwrap();
    publishInput(0.5, 4);
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    // First direct use completes the ordinary asynchronous material pipeline.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    expect(viewUpdate).toHaveBeenCalled();
    expect(directSurface).toHaveBeenCalled();
    expect(indirectRows).toHaveBeenCalled();
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
    expect(preparedFrame().shadowViewPool?.inspect()).toEqual([]);
    expect(preparedFrame().standardPbrFrameResources.surfaceDynamicInput).toBeDefined();
    expect(preparedFrame().standardPbrFrameResources.prepareMaterialBinding(0)).toBeUndefined();
    expect(preparedFrame().standardPbrFrameResources.materialSlotIndicesByBinding.size).toBe(0);
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
    endedPasses.mockClear();
    directSurface.mockClear();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    expect(shadowPrepare).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledTimes(1);
    expect(directSurface).toHaveBeenCalled();
    expect(preparedFrame().standardPbrFrameResources.prepareMaterialBinding(0)).toBeUndefined();
    expect(preparedFrame().standardPbrFrameResources.materialSlotIndicesByBinding.size).toBe(0);
    expect(
      (endedPasses.mock.contexts as RhiNullRenderPassEncoder[]).some(
        (pass) => pass.passName.startsWith('shadowCascade') && pass.drawCount > 0,
      ),
    ).toBe(true);
    const passes = (draws.mock.contexts as RhiNullRenderPassEncoder[]).map((pass) => pass.passName);
    expect(passes).toContain('single-layer-medium-nearest-layer');
    expect(passes).toContain('single-layer-medium-color');
    expect(errors).toEqual([]);

    expect(draw('automatic').ok, JSON.stringify(errors)).toBe(true);
    expect(shadowPrepare).toHaveBeenCalled();
    expect(preparedFrame().shadowViewPool?.inspect().length).toBeGreaterThan(0);
    expect(typeof preparedFrame().standardPbrFrameResources.prepareMaterialBinding).toBe(
      'function',
    );
    expect(encodedIndirectDraws()).toBeGreaterThan(0);
    expect(consume).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([]);

    // Reuse the real frame, cooked Surface program and page at the admission boundary.
    const inputs = frameInputs.mock.calls.at(-1);
    assert(inputs);
    const [sources, input, frame, standard, pipeline] = inputs;
    const dynamic = frame?.surfaceDynamicInput;
    const range = dynamic?.ranges?.[0];
    const owner = sources.renderables.find((item) => item.entityKey === surfaceEntity);
    const solid = sources.renderables.find((item) => item.entityKey === solidEntity);
    const drawRow = receiptRow().source.gpuDrivenDraws?.[0];
    assert(frame && dynamic && range && owner && solid && drawRow);
    const section = 7;
    const owned = [
      { ...drawRow, drawItemIndex: section, materialSlot: 1 },
      { ...drawRow, drawItemIndex: 2, materialSlot: 0 },
    ];
    const ranges = [2, section, 8].map((drawItemIndex) => ({
      ...range,
      member: { ...range.member, drawItemIndex },
    }));
    const requests = (draws: typeof owner.gpuDrivenDraws) => {
      assert(draws);
      const source = {
        ...owner,
        gpuVertexSource: { feature: 'medium', resource: 'vertices' },
        materials: [solid.material, owner.material],
        gpuDrivenDraws: draws,
      };
      return frameGpuInput.buildFrameGpuDrivenInput(
        { ...sources, renderables: [source] },
        input,
        { ...frame, surfaceDynamicInput: { ...dynamic, ranges } },
        standard,
        pipeline,
      ).request?.directSurface;
    };
    expect(requests(sealSourceDraws(owned))?.ranges).toEqual([ranges[1]]);
    const duplicate = [
      { ...drawRow, drawItemIndex: section, materialSlot: 0 },
      { ...drawRow, drawItemIndex: section, materialSlot: 1 },
    ];
    expect(requests(duplicate)).toBeUndefined();
    duplicate.reverse();
    expect(requests(duplicate)?.ranges).toEqual([ranges[1]]);

    // A local light still renders its direct casters without a directional atlas consumer.
    captureAtlas.mockClear();
    frameInputs.mockClear();
    world.set(sun, DirectionalLight, { castShadow: false }).unwrap();
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 4] } },
        { component: SpotLight, data: { direction: [0, 0, -1], castShadow: true, mapSize: 64 } },
      )
      .unwrap();
    world.update(1 / 60).unwrap();
    endedPasses.mockClear();
    expect(draw('direct').ok, JSON.stringify(errors)).toBe(true);
    const shadowPasses = (endedPasses.mock.contexts as RhiNullRenderPassEncoder[])
      .filter((pass) => pass.drawCount > 0)
      .map((pass) => pass.passName);
    expect(
      shadowPasses.some((name) => /spot.*shadow|shadow.*spot/i.test(name)),
      JSON.stringify(shadowPasses),
    ).toBe(true);
    const spotInput = frameInputs.mock.results.at(-1)?.value;
    expect(spotInput?.request?.geometryLane).toBe('direct');
    expect(spotInput?.request?.shadowMaterials).toBeUndefined();
    const casters = [...(spotInput?.request?.batchExecutions.values() ?? [])];
    expect(casters.some(({ shadow }) => shadow.route === 'direct')).toBe(true);
    expect(casters.some(({ shadow }) => shadow.route === 'gpu')).toBe(false);
    expect(spotInput?.artifacts?.shadowMaterialArtifacts.size).toBe(0);
    expect(captureAtlas).not.toHaveBeenCalled();
  } finally {
    await renderer.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, 30_000);
