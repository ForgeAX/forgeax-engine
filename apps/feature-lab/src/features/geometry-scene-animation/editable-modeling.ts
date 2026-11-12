import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { sel } from '@forgeax/engine/modeling';
import { MeshFilter, MeshRenderer } from '@forgeax/engine/render';
import type { MeshAsset } from '@forgeax/engine/types';
// Case C-001 (Modeling Studio) is the acceptance asset; the Lab renders the same recipe.
import {
  buildCrate,
  CRATE_DEFAULTS,
  type CrateParameters,
} from '../../../../../packages/modeling/examples/crate/crate.ts';
import type { FeatureCheck } from '../../lab/feature';
import { defineFeature } from '../../lab/feature';
import { lookRotation, spawnCamera, spawnMesh, spawnSun, standard } from '../../lab/stage';

const SLOT_COLORS: Readonly<Record<string, readonly [number, number, number, number]>> = {
  metal: [0.32, 0.33, 0.36, 1],
  panel: [0.15, 0.45, 0.32, 1],
  trim: [0.95, 0.5, 0.1, 1],
};

const VARIANT: CrateParameters = { width: 1.1, height: 0.65, depth: 0.6 };

function crateMesh(
  parameters: CrateParameters,
): { mesh: MeshAsset; faces: number; recess: number; warnings: number } | string {
  const crate = buildCrate(parameters);
  const out = crate.toMesh({ normals: { mode: 'weighted' } });
  return out.ok
    ? {
        mesh: out.value.mesh,
        faces: crate.inspect().faces,
        recess: crate.count(sel.createdBy('recess', 'top')),
        warnings: crate.validate().issues.filter((issue) => issue.severity !== 'info').length,
      }
    : out.error.code;
}

export default defineFeature({
  title: 'Editable mesh modeling',
  catalog: 'Editable mesh modeling kernel',
  kind: 'visual',
  summary:
    'The C-001 hard-surface crate is built in code with model(): loop cuts, inset and recessed panels, a welded lid plate, mirrored handles, a bridged hinge and lifted rivets, then exported as an ordinary MeshAsset whose normals follow sharp-edge intent. The same build re-runs for other parameters.',
  expect:
    'ON: the default crate (0.8 x 0.5 x 0.5 m): gray body, a green recessed panel band around the sides, an orange lid plate with rivets, dark metal handles and hinge, crisp creases. OFF: the same build with width 1.1, height 0.65, depth 0.6: a visibly larger crate with the same band, lid plate and parts in the same places.',
  setup({ world, hud }) {
    const sceneAssets = world.assets;
    if (!(sceneAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');
    spawnCamera(world, {
      eye: [1.05, 0.8, 1.35],
      target: [0, 0.05, 0],
      data: { clearColor: [0.02, 0.02, 0.04, 1] },
    });
    spawnSun(world);
    const base = crateMesh(CRATE_DEFAULTS);
    const variant = crateMesh(VARIANT);
    if (typeof base === 'string' || typeof variant === 'string') {
      hud.status(`modeling failed: ${typeof base === 'string' ? base : variant}`);
      return {};
    }
    hud.status(
      `crate: ${base.faces} faces default, ${variant.faces} faces variant; recess tops ${base.recess}/${variant.recess}`,
    );
    const baseHandle = sceneAssets.create(base.mesh).unwrap();
    const variantHandle = sceneAssets.create(variant.mesh).unwrap();
    const entity = spawnMesh(
      world,
      baseHandle,
      standard(world, { baseColor: [0.62, 0.63, 0.66, 1], roughness: 0.5 }),
      { pos: [0, 0, 0], rotation: lookRotation([0, 0, 0], [0, 0, -1]) },
    );
    world.set(entity, MeshRenderer, {
      materials: base.mesh.materialSlots.map((slot) =>
        standard(world, {
          baseColor: [...(SLOT_COLORS[slot.slotName] ?? [0.62, 0.63, 0.66, 1])],
          metallic: slot.slotName === 'metal' ? 0.6 : 0,
          roughness: 0.5,
        }),
      ),
    } as never);
    return {
      toggle(on) {
        world.set(entity, MeshFilter, { assetHandle: on ? baseHandle : variantHandle } as never);
      },
      checks(): FeatureCheck[] {
        return [
          {
            name: 'crate validates without warnings at both parameter sets',
            ok: base.warnings === 0 && variant.warnings === 0,
            detail: `${base.warnings}/${variant.warnings}`,
          },
          {
            name: 'parameters change size, not topology or labeled regions',
            ok: base.faces === variant.faces && base.recess === variant.recess && base.recess > 0,
            detail: `faces ${base.faces}/${variant.faces}, recess tops ${base.recess}/${variant.recess}`,
          },
        ];
      },
    };
  },
});
