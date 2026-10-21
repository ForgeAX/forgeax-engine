import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import type { EntityHandle } from '@forgeax/engine/ecs';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { quat } from '@forgeax/engine/math';
import { ChildOf, Children, GlobalTransform, Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

const turn = (on: boolean): Float32Array =>
  quat.fromAxisAngle(quat.create(), [0, 0, 1], on ? Math.PI / 2 : 0) as Float32Array;

export default defineFeature({
  title: 'Scene hierarchy',
  catalog: 'Scene hierarchy',
  kind: 'visual',
  summary:
    'ChildOf { parent } links entities; scenePlugin maintains Children and resolves GlobalTransform.world, so rotating one parent moves its whole chain. A cyan cube demonstrates affine shear and mirrored scale without changing the hierarchy owner.',
  expect:
    'ON: the red hub is turned 90 degrees and the green arm plus blue tip swing up to point vertically. The cyan cube is sheared and mirrored. OFF: the hub is unrotated, the arm points right along +X and the cyan cube is an ordinary box.',
  setup({ world, hud }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const stageSphere = primitiveAssets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

    spawnStage(world, { eye: [0, 1.6, 6.5], target: [0, 1.2, 0] });
    const hub = spawnMesh(world, stageCube, standard(world, { baseColor: [1, 0.2, 0.2, 1] }), {
      pos: [-0.8, 0.5, 0],
      scale: [0.5, 0.5, 0.5],
      rotation: turn(true),
    });
    const arm = spawnMesh(
      world,
      stageCube,
      standard(world, { baseColor: [0.2, 1, 0.3, 1] }),
      { pos: [2, 0, 0], scale: [2.4, 0.4, 0.4] },
      { component: ChildOf, data: { parent: hub } },
    );
    const tip: EntityHandle = spawnMesh(
      world,
      stageSphere,
      standard(world, { baseColor: [0.2, 0.4, 1, 1] }),
      { pos: [0.6, 0, 0], scale: [0.5, 3, 3] },
      { component: ChildOf, data: { parent: arm } },
    );
    const affine = spawnMesh(world, stageCube, standard(world, { baseColor: [0.05, 0.8, 1, 1] }), {
      pos: [1.8, 0.9, 0],
      scale: [-0.7, 1.2, 0.6],
    });
    world.set(affine, Transform, { shear: [0.65, 0, 0] }).unwrap();
    let enabled = true;
    const children = world.get(hub, Children);
    hud.status(
      `hub children: ${children.ok ? Array.from(children.value.entities).length : 'missing'}`,
    );
    return {
      checks() {
        const checks = new CheckList();
        const matrix = world.get(affine, GlobalTransform).unwrap().world;
        checks.near(
          'affine shear reaches the world matrix',
          matrix[4] ?? NaN,
          enabled ? 0.65 * 1.2 : 0,
        );
        checks.near(
          'mirrored X scale survives propagation',
          matrix[0] ?? NaN,
          enabled ? -0.7 : 0.7,
        );
        return checks.items;
      },
      toggle(on) {
        enabled = on;
        world
          .set(affine, Transform, {
            shear: on ? [0.65, 0, 0] : [0, 0, 0],
            scale: [on ? -0.7 : 0.7, 1.2, 0.6],
          })
          .unwrap();
        world.set(hub, Transform, { quat: turn(on) } as never);
        const global = world.get(tip, GlobalTransform);
        if (global.ok)
          hud.status(`tip world y before this toggle: ${(global.value.world[13] ?? 0).toFixed(2)}`);
      },
    };
  },
});
