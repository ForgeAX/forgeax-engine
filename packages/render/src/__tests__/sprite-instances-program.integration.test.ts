import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../../../shader-compiler/src/material/variant-context';
import { MeshFilter, MeshRenderer, SpriteInstances } from '../components';
import type { MaterialResource } from '../material-resource';
import { interleaveSpriteInstanceBuffer } from '../record/sprite-instance-buffer';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

const BUILTIN_QUAD = createPrimitiveMesh('quad').unwrap();

it.each([
  false,
  true,
])('selects cooked instance programs with shared materials (instances first: %s)', async (instancesFirst) => {
  const source: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'forward', program: { module: 'forgeax::sprite' } }],
    parameters: [
      { name: 'colorTint', type: 'color' },
      { name: 'region', type: 'vec4' },
      { name: 'pivotAndSize', type: 'vec4' },
      { name: 'slicesAndMode', type: 'vec4' },
      { name: 'flipX', type: 'f32' },
      { name: 'flipY', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
    ],
    values: {
      colorTint: [1, 1, 1, 1],
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
      slicesAndMode: [0, 0, 0, 0],
      flipX: 0,
      flipY: 0,
    },
  };
  const output = await createMaterialPackCooker().cook({
    guid: 'd81bc8b3-0d67-4f7e-97e5-ebbbf8615ade',
    source,
  });
  const record = validateCookedMaterialRecord(
    (output.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  publishRuntimeAssets(assets, [{ guid: record.guid, asset: output.payload as MaterialAsset }]);
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const material = (await assets.load(record.guid, 'material')).unwrap();
  const mesh = assets.create(BUILTIN_QUAD).unwrap();
  const transforms = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1,
  ]);
  const regions = new Float32Array([0, 0, 0.5, 1, 0.5, 0, 0.5, 1]);
  const spawn = (instanced: boolean) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
        ...(instanced ? [{ component: SpriteInstances, data: { transforms, regions } }] : []),
      )
      .unwrap();
  spawn(instancesFirst);
  spawn(!instancesFirst);
  spawn(true);
  spawn(false);
  world.update(0).unwrap();
  const scene = new PersistentRenderScene({ assets });
  const caches = scene.materialSnapshotCacheStore(DEFAULT_MATERIAL_VARIANT_CONTEXT);
  const lease = createRenderReadLease(world);
  const resources = new Map<number, MaterialResource>();
  let extractedEntities = 0;
  try {
    for (let frame = -2; frame < 3; frame++) {
      if (frame === 1) assets.update(material, { values: { colorTint: [0, 1, 0, 1] } }).unwrap();
      const result = scene.extractComposition(
        [world],
        { cameraOwner: 0, resourceOwner: 0 },
        assets,
        (request) => {
          if (typeof request === 'object')
            for (const entities of request.entitiesByWorld)
              extractedEntities += entities?.size ?? 0;
          return extractFrames([world], 0, assets, caches, {
            materialContext: DEFAULT_MATERIAL_VARIANT_CONTEXT,
            cull: 'none',
            retainHidden: true,
            renderables: request,
          });
        },
        [lease],
      );
      if (frame < 0) {
        extractedEntities = 0;
        continue;
      }
      expect(extractedEntities, `frame ${frame}`).toBe(0);
      expect(result.renderables).toHaveLength(4);
      for (const entry of result.renderables) {
        if (frame === 0) resources.set(entry.entityKey, entry.material);
        else expect(entry.material).toBe(resources.get(entry.entityKey));
        expect(entry.material.snapshot.paramSnapshot?.colorTint).toEqual(
          frame === 0 ? [1, 1, 1, 1] : [0, 1, 0, 1],
        );
        const geometry = entry.spriteInstances ? 'sprite-instances' : 'mesh';
        const program = record.programs.find((program) =>
          program.selections.some((selection) => selection.context.geometry === geometry),
        );
        expect(entry.material.snapshot.materialProgramKeys?.forward).toBe(
          program?.specializationKey,
        );
        expect(entry.material.snapshot.materialShaderId).toBe(program?.specializationKey);
        if (entry.spriteInstances) {
          expect(entry.spriteInstances.instanceCount).toBe(2);
          const packed = interleaveSpriteInstanceBuffer(
            entry.spriteInstances.transforms,
            entry.spriteInstances.regions,
            true,
          );
          expect(packed.byteLength).toBe(2 * 144);
          expect(Array.from(packed.slice(32, 36))).toEqual(Array.from(regions.slice(0, 4)));
          expect(Array.from(packed.slice(68, 72))).toEqual(Array.from(regions.slice(4, 8)));
          expect(interleaveSpriteInstanceBuffer(transforms, regions, false).byteLength).toBe(
            2 * 80,
          );
        }
      }
    }
  } finally {
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
}, 30_000);
