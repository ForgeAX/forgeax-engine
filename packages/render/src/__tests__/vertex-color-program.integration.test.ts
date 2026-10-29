import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createRenderReadLease } from '@forgeax/engine-ecs/projection';
import { createBoxGeometry, createMeshBuilder } from '@forgeax/engine-geometry';
import {
  materialProgramContextKey,
  validateCookedMaterialRecord,
} from '@forgeax/engine-pack/material-cook';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT } from '../../../shader-compiler/src/material/variant-context';
import { MeshFilter, MeshRenderer } from '../components';
import type { MaterialResource } from '../material-resource';
import { Materials } from '../materials';
import { extractFrames } from '../render-system-extract-tail';
import { PersistentRenderScene } from '../scene/render-scene';

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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  publishRuntimeAssets(assets, [{ guid: record.guid, asset: output.payload as MaterialAsset }]);
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const material = (await assets.load(record.guid, 'material')).unwrap();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const positions = mesh.attributes.position;
  if (!(positions instanceof Float32Array)) throw new Error('Expected float box positions');
  const plain = assets.create(mesh).unwrap();
  const colored = assets
    .create(
      createMeshBuilder({
        ...mesh,
        attributes: {
          ...mesh.attributes,
          color: new Float32Array((positions.length / 3) * 4).fill(1),
        },
      })
        .build()
        .unwrap(),
    )
    .unwrap();
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
  const scene = new PersistentRenderScene({ assets });
  const caches = scene.materialSnapshotCacheStore(DEFAULT_MATERIAL_VARIANT_CONTEXT);
  const lease = createRenderReadLease(world);
  const resources = new Map<number, MaterialResource>();
  let extractedEntities = 0;
  try {
    for (let frame = -2; frame < 3; frame++) {
      if (frame === 1) assets.update(material, { values: { roughness: 0.25 } }).unwrap();
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
        expect(entry.material.snapshot.roughness).toBe(frame === 0 ? 0.5 : 0.25);
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
        expect(entry.material.snapshot.materialProgramKeys?.forward).toBe(
          program?.specializationKey,
        );
        expect(entry.materials[0]?.snapshot.materialProgramKeys?.forward).toBe(
          program?.specializationKey,
        );
        expect(entry.material.snapshot.materialShaderId).toBe(program?.specializationKey);
      }
    }
  } finally {
    scene.dispose();
    lease.dispose();
    assets.dispose();
  }
}, 30_000);
