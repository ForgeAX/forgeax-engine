import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  Outline,
} from '@forgeax/engine-render';
import type { PipelineLibraryInspection } from '@forgeax/engine-rhi';
import { propagateTransforms, Transform } from '@forgeax/engine-scene';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import { derive } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { drawReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { createBarrelRendererFixture } from './barrel-distortion-gpu-fixture';
import { testAssets } from './helpers/runtime-assets';

const stockUserRegion = derive(STANDARD_PIPELINE_PARAM_SCHEMA);

function opaqueSurfaceSlots(library: PipelineLibraryInspection) {
  const material = library.runtimeRequests?.requests.findLast(
    ({ pipeline }) =>
      pipeline?.kind === 'render' &&
      'fragment' in pipeline.recipe &&
      pipeline.recipe.fragment?.entryPoint === 'fs_opaque',
  )?.pipeline?.bindGroupLayouts;
  if (material === undefined || material === 'auto')
    throw new Error('Missing explicit Forward layout');
  return material[1]?.entries
    .filter(
      ({ binding, texture }) =>
        texture !== undefined && binding < stockUserRegion.userRegionBindingEnd,
    )
    .map(({ binding }) => binding);
}

it('reports ordinary boot and first-use recipes for real Standard draws', {
  timeout: 120_000,
}, async () => {
  const { renderer, renderTarget } = await createBarrelRendererFixture({ width: 64, height: 64 });
  const world = new World();
  const output = process.env.FORGEAX_PIPELINE_AUDIT_DIR;
  const inspect = async (phase: string) => {
    const value = renderer.inspect({
      fields: [
        'frame',
        'profile',
        'capabilities',
        'pipelineLibrary',
        'shaderTemplates',
        'rasterPassRequests',
      ],
      runtimeRequests: true,
    });
    if (output !== undefined) {
      await writeFile(join(output, `${phase}.json`), JSON.stringify(value, null, 2));
    }
    if (value.shaderTemplates === undefined || value.pipelineLibrary?.runtimeRequests === undefined)
      throw new Error('Expected template selections and native demand from the actual Renderer');
    return {
      shader: value.shaderTemplates,
      library: value.pipelineLibrary,
      passes: value.rasterPassRequests,
    };
  };

  try {
    const startup = await inspect('renderer-ready');
    const scenes = startup.shader.programs?.filter(
      (program) =>
        program.identifier.includes('standard-pbr') &&
        program.definesKey.includes('GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true'),
    );
    expect(scenes?.length).toBeGreaterThanOrEqual(2);
    for (const { definesKey } of scenes ?? []) {
      expect(definesKey).not.toMatch(
        /(?:^|\+)(?:WATER_WAVES_AVAILABLE|WATER_INFO_RGBA16|LOD_DITHER|CLIPPING_PLANES)=true(?:\+|$)/,
      );
    }
    expect(startup.passes).toBeUndefined();
    renderer.inspect({ fields: ['pipelineLibraryCollecting'], pipelineLibraryCollection: true });
    renderer
      .setProfile({
        ...renderer.inspect().profile,
        renderPath: 'forward',
        ambientOcclusion: { enabled: false },
      })
      .unwrap();
    const source = renderer.attach(world).unwrap();
    try {
      const assets = testAssets(world);
      const camera = world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4] } },
          {
            component: Camera,
            data: {
              projection: 1,
              left: -2,
              right: 2,
              top: 2,
              bottom: -2,
              near: 0.1,
              far: 10,
              antialias: 0,
              bloom: 0,
              tonemap: 1,
            },
          },
        )
        .unwrap();
      world
        .spawn({
          component: DirectionalLight,
          data: { direction: [0, 0, -1], intensity: 2, castShadow: false },
        })
        .unwrap();
      const mesh = assets.create(createPlaneGeometry(2, 2).unwrap()).unwrap();
      const object = world
        .spawn(
          { component: Transform, data: {} },
          { component: MeshFilter, data: { assetHandle: mesh } },
          { component: MeshRenderer, data: { materials: [] } },
        )
        .unwrap();
      const makeTexture = (data: readonly number[]) =>
        assets
          .create({
            kind: 'texture',
            shape: { viewDimension: '2d', extent: { width: 1, height: 1 } },
            format: 'rgba8unorm',
            colorSpace: 'linear',
            mips: { kind: 'none' },
            data: new Uint8Array(data),
          })
          .unwrap();
      let texture = makeTexture([255, 255, 255, 255]);
      const setMaterial = (
        roughness: number,
        textured = false,
        alphaCutoff = 0,
        texturedRoughness = false,
        orm = false,
      ) => {
        const asset = Materials.standard({
          baseColor: [1, 0.4, 0.1, 1],
          roughness,
          alphaCutoff,
          ...(textured ? { baseColorTexture: { texture } } : {}),
          ...(texturedRoughness ? { roughnessTexture: { texture } } : {}),
          ...(orm ? { metallicRoughnessTexture: { texture }, occlusionTexture: { texture } } : {}),
        });
        world.set(object, MeshRenderer, { materials: [assets.create(asset).unwrap()] }).unwrap();
      };
      const draw = async (phase: string, geometryLane: 'direct' | 'automatic' = 'direct') => {
        for (let frame = 0; frame < 4; frame++) {
          world.update(1 / 60).unwrap();
          propagateTransforms(world).unwrap();
          await drawReadyFrame(renderer, { source, geometryLane });
        }
        return inspect(phase);
      };

      setMaterial(0.5);
      const opaque = await draw('first-opaque');
      expect(opaqueSurfaceSlots(opaque.library)).toEqual([]);
      expect(opaque.passes?.requests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            material: 'forgeax::default-standard-pbr',
            selection: 'registered',
            viewTextures: expect.arrayContaining([{ binding: 3, visibility: 2 }]),
            nativeRecipe: expect.objectContaining({ localIdentity: expect.any(Number) }),
          }),
        ]),
      );
      setMaterial(0.75);
      const scalar = await draw('roughness-only');
      expect(scalar.shader.selections).toBe(opaque.shader.selections);
      expect(scalar.library.renderPipelines).toBe(opaque.library.renderPipelines);

      setMaterial(0.75, true);
      const textured = await draw('add-base-color-map');
      expect(textured.shader.selections - scalar.shader.selections).toBe(2);
      expect(textured.library.renderPipelines - scalar.library.renderPipelines).toBe(2);
      expect(opaqueSurfaceSlots(textured.library)).toEqual([
        stockUserRegion.resourceBindings.find(({ name }) => name === 'baseColorTexture')?.binding,
      ]);

      setMaterial(0.75, false, 0, false, true);
      const orm = await draw('orm-only');
      const ormSlot = stockUserRegion.resourceBindings.find(
        ({ name }) => name === 'metallicRoughnessTexture',
      )?.binding;
      expect(opaqueSurfaceSlots(orm.library)).toEqual([ormSlot]);
      texture = makeTexture([80, 144, 208, 255]);
      setMaterial(0.5, false, 0, false, true);
      const warmOrm = await draw('repeat-orm');
      expect(warmOrm.shader.selections).toBe(orm.shader.selections);
      expect(warmOrm.library.renderPipelines).toBe(orm.library.renderPipelines);

      setMaterial(0.75, true, 0.5);
      await draw('enable-cutout');
      world
        .addComponent(camera, {
          component: Outline,
          data: { entities: [object], visibleColor: [1, 0, 0], width: 2 },
        })
        .unwrap();
      const outlined = await draw('enable-outline');
      expect(
        outlined.passes?.requests.some(({ shader }) => shader.fragmentEntry === 'fs_coverage'),
      ).toBe(true);
      const repeated = await draw('repeat-outline');
      expect(repeated.shader.selections).toBe(outlined.shader.selections);
      expect(repeated.library.renderPipelines).toBe(outlined.library.renderPipelines);

      setMaterial(0.75, true, 0.5, true);
      const roughnessMap = await draw('add-roughness-map');
      const sequence = repeated.library.runtimeRequests?.latestSequence ?? 0;
      const newPasses = roughnessMap.library.runtimeRequests?.requests.filter(
        (request) => request.sequence > sequence,
      );
      expect(newPasses?.length).toBeGreaterThan(0);
      for (const { pipeline } of newPasses ?? []) {
        if (pipeline === null) throw new Error('Missing native recipe for the measured request');
        expect(pipeline.recipe).not.toMatchObject({
          fragment: { entryPoint: 'fs_coverage' },
        });
        expect(pipeline.recipe).not.toMatchObject({
          fragment: { entryPoint: 'fs_depth_masked' },
        });
      }

      setMaterial(0.75, false, 0, false, true);
      const scene = await draw('scene-orm', 'automatic');
      expect(opaqueSurfaceSlots(scene.library)).toEqual([ormSlot]);
      expect(
        scene.passes?.requests.some(
          ({ shader, nativeRecipe }) =>
            shader.fragmentEntry === 'fs_opaque' &&
            nativeRecipe !== undefined &&
            shader.variantSet?.includes('GPU_DRIVEN_SCENE_INDEX_AVAILABLE=true'),
        ),
      ).toBe(true);
    } finally {
      source.dispose();
    }
  } finally {
    await renderer.dispose();
    renderTarget.destroy();
  }
});
