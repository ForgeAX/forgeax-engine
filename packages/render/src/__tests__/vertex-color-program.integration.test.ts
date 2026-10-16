import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import {
  materialProgramContextKey,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../../../shader-compiler/src/material/variant-context';
import { MeshFilter, MeshRenderer } from '../components';
import { Materials } from '../materials';
import type { MaterialSnapshotCachesByWorld } from '../render-system-extract';
import { extractFrames } from '../render-system-extract-tail';

it.each([
  false,
  true,
])('selects plain and colored programs for a shared material across frames (color first: %s)', async (colorFirst) => {
  const source = Materials.standard({ baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.5 });
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
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array)) throw new Error('Expected float box positions');
  const plain = world.internSharedRef('MeshAsset', mesh);
  const colored = world.internSharedRef(
    'MeshAsset',
    createMeshBuilder({
      ...mesh,
      attributes: {
        ...mesh.attributes,
        color: new Float32Array((positions.length / 3) * 4).fill(1),
      },
    })
      .build()
      .unwrap(),
  );
  const expectedColors = new Map<number, boolean>();
  for (const color of [colorFirst, !colorFirst, true, false]) {
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: color ? colored : plain } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    expectedColors.set(entity, color);
  }
  world.update(0).unwrap();
  const caches: MaterialSnapshotCachesByWorld = new WeakMap();
  for (let frame = 0; frame < 2; frame++) {
    const result = extractFrames([world], 0, assets, undefined, caches, {
      materialContext: DEFAULT_MATERIAL_VARIANT_CONTEXT,
      cull: 'none',
    });
    expect(result.renderables).toHaveLength(4);
    for (const entry of result.renderables) {
      const color = expectedColors.get(entry.entityKey);
      const program = record.programs.find((program) =>
        program.selections.some(
          (selection) =>
            selection.pass === 'forward' &&
            materialProgramContextKey(selection.context) ===
              materialProgramContextKey(DEFAULT_MATERIAL_VARIANT_CONTEXT) &&
            selection.address === 'direct' &&
            selection.abi?.vertexInputs.some((input) => input.semantic === 'color') === color,
        ),
      );
      expect(program).toBeDefined();
      expect(entry.material.materialProgramKeys?.forward).toBe(program?.specializationKey);
      expect(entry.materials[0]?.materialProgramKeys?.forward).toBe(program?.specializationKey);
      expect(entry.material.materialShaderId).toBe(program?.specializationKey);
    }
  }
}, 30_000);
