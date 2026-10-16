import type { EntityHandle } from '@forgeax/engine/ecs';
import { quat } from '@forgeax/engine/math';
import { ChildOf, Children, GlobalTransform, Transform } from '@forgeax/engine/scene';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const turn = (on: boolean): Float32Array =>
  quat.fromAxisAngle(quat.create(), [0, 0, 1], on ? Math.PI / 2 : 0) as Float32Array;

export default defineFeature({
  title: 'Scene hierarchy',
  catalog: 'Scene hierarchy',
  kind: 'visual',
  summary:
    'ChildOf { parent } links entities; scenePlugin maintains Children and resolves GlobalTransform.world, so rotating one parent moves its whole chain.',
  expect:
    'ON: the red hub is turned 90 degrees and the green arm plus blue tip swing up to point vertically. OFF: the hub is unrotated and the arm points right along +X.',
  setup({ world, hud }) {
    spawnStage(world, { eye: [0, 1.6, 6.5], target: [0, 1.2, 0] });
    const hub = spawnMesh(world, MESH.cube, standard(world, { baseColor: [1, 0.2, 0.2, 1] }), {
      pos: [-0.8, 0.5, 0],
      scale: [0.5, 0.5, 0.5],
      rotation: turn(true),
    });
    const arm = spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.2, 1, 0.3, 1] }),
      { pos: [2, 0, 0], scale: [2.4, 0.4, 0.4] },
      { component: ChildOf, data: { parent: hub } },
    );
    const tip: EntityHandle = spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [0.2, 0.4, 1, 1] }),
      { pos: [0.6, 0, 0], scale: [0.5, 3, 3] },
      { component: ChildOf, data: { parent: arm } },
    );
    const children = world.get(hub, Children);
    hud.status(
      `hub children: ${children.ok ? Array.from(children.value.entities).length : 'missing'}`,
    );
    return {
      toggle(on) {
        world.set(hub, Transform, { quat: turn(on) } as never);
        const global = world.get(tip, GlobalTransform);
        if (global.ok)
          hud.status(`tip world y before this toggle: ${(global.value.world[13] ?? 0).toFixed(2)}`);
      },
    };
  },
});
