import { AssetRegistry, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../../../shader-compiler/src/material/variant-context';
import { MeshFilter, MeshRenderer, SpriteInstances } from '../components';
import { interleaveSpriteInstanceBuffer } from '../record/sprite-instance-buffer';
import type { MaterialSnapshotCachesByWorld } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

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
      { name: 'baseColorTexture', type: 'texture' },
    ],
    values: {
      colorTint: [1, 1, 1, 1],
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
      slicesAndMode: [0, 0, 0, 0],
    },
  };
  const output = await createMaterialPackCooker().cook({
    guid: 'd81bc8b3-0d67-4f7e-97e5-ebbbf8615ade',
    source,
  });
  const record = validateCookedMaterialRecord(
    (output.payload as { cooked: unknown }).cooked,
  ).unwrap();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  assets.catalog(record.guid, source).unwrap();
  if (
    record.publicationGeneration === undefined ||
    !record.specializationKey ||
    !record.artifactDigest ||
    !record.sourceClosure ||
    !record.parameterContract
  )
    throw new Error('Missing cooked metadata');
  assets.recordMaterialReadiness(record.guid, {
    status: 'Ready',
    record: {
      ...record,
      materialGuid: record.guid,
      publicationGeneration: record.publicationGeneration,
      specializationKey: record.specializationKey,
      artifactDigest: record.artifactDigest,
      sourceClosure: record.sourceClosure,
      parameterContract: record.parameterContract,
      programs: record.programs,
    },
  });
  const world = new World();
  const material = world.internSharedRef('MaterialAsset', source);
  const transforms = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1,
  ]);
  const regions = new Float32Array([0, 0, 0.5, 1, 0.5, 0, 0.5, 1]);
  const spawn = (instanced: boolean) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [material] } },
        ...(instanced ? [{ component: SpriteInstances, data: { transforms, regions } }] : []),
      )
      .unwrap();
  spawn(instancesFirst);
  spawn(!instancesFirst);
  spawn(true);
  spawn(false);
  world.update(0).unwrap();
  const caches: MaterialSnapshotCachesByWorld = new WeakMap();
  for (let frame = 0; frame < 2; frame++) {
    const result = extractFrames([world], 0, assets, undefined, caches, {
      materialContext: DEFAULT_MATERIAL_VARIANT_CONTEXT,
      cull: 'none',
    });
    expect(result.renderables).toHaveLength(4);
    for (const entry of result.renderables) {
      const geometry = entry.spriteInstances ? 'sprite-instances' : 'mesh';
      const program = record.programs.find((program) =>
        program.selections.some((selection) => selection.context.geometry === geometry),
      );
      expect(entry.material.materialProgramKeys?.forward).toBe(program?.specializationKey);
      expect(entry.material.materialShaderId).toBe(program?.specializationKey);
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
        expect(interleaveSpriteInstanceBuffer(transforms, regions, false).byteLength).toBe(2 * 80);
      }
    }
  }
}, 30_000);
