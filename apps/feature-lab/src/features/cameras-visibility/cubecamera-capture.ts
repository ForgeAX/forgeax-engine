import type { World } from '@forgeax/engine/ecs';
import { CubeCamera } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, unlit, type Vec3 } from '../../lab/stage';
import { serial } from './support/serial';
import { meanColor, readTarget, sampledTarget } from './support/target';

const WALLS: readonly { pos: Vec3; scale: Vec3; rgb: Vec3 }[] = [
  { pos: [3, 0, 0], scale: [0.2, 6, 6], rgb: [1, 0, 0] },
  { pos: [-3, 0, 0], scale: [0.2, 6, 6], rgb: [0, 1, 0] },
  { pos: [0, 3, 0], scale: [6, 0.2, 6], rgb: [0, 0, 1] },
];

function spawnWalls(world: World): void {
  for (const wall of WALLS) {
    spawnMesh(world, MESH.cube, unlit(world, [wall.rgb[0], wall.rgb[1], wall.rgb[2], 1]), {
      pos: [wall.pos[0], wall.pos[1] + 40, wall.pos[2]],
      scale: wall.scale,
    });
  }
}

export default defineFeature({
  title: 'CubeCamera capture',
  catalog: 'CubeCamera capture',
  kind: 'probe',
  summary:
    'CubeCamera + Transform captures six faces (+X,-X,+Y,-Y,+Z,-Z) into a cube RenderTarget; faces are read back individually.',
  expect:
    'PASS when face 0 (+X) reads back red, face 1 (-X) green and face 2 (+Y) blue from colored walls around the capture point.',
  setup({ app, world, frames }) {
    spawnCamera(world, { eye: [0, 1, 5] });
    spawnWalls(world);
    const made = sampledTarget(
      app,
      {
        shape: 'cube',
        width: 64,
        height: 64,
        format: 'rgba8unorm',
        mipLevels: 1,
        sampleCount: 1,
        sampled: true,
        readback: true,
      },
      'cube',
    );
    if (made !== undefined) {
      world
        .spawn(
          { component: Transform, data: { pos: [0, 40, 0] } },
          {
            component: CubeCamera,
            data: {
              target: made.targetRef,
              near: 0.1,
              far: 20,
              updateIntent: 0,
              requestVersion: 0,
              faceBudget: 6,
            } as never,
          },
        )
        .unwrap();
    }
    return {
      checks: serial(async () => {
        const checks = new CheckList();
        checks.ok('cube target created', made !== undefined);
        if (made === undefined) return checks.items;
        await frames(6);
        for (const [face, wall] of WALLS.entries()) {
          const bytes = await readTarget(app, made.target, face);
          if (typeof bytes === 'string') {
            checks.ok(`face ${face} readback`, false, bytes);
            continue;
          }
          const mean = meanColor(bytes);
          const dominant = mean.indexOf(Math.max(...mean));
          checks.equal(`face ${face} dominant channel`, dominant, wall.rgb.indexOf(1));
        }
        return checks.items;
      }),
    };
  },
});
