import { halfFloat } from '@forgeax/engine/math';
import { PointLight, RectAreaLight } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { toShared } from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard, unlit } from '../../lab/stage';

export default defineFeature({
  title: 'IES light profiles',
  catalog: 'IES light profiles',
  kind: 'visual',
  summary:
    'A warm point lamp and a cool rectangular lamp share a 270° IES distribution centered upward. Their pedestals sit below the emitters.',
  expect:
    'ON: light reaches above and diagonally below each lamp; only the downward 90° cone stays dark. OFF: light also reaches directly below the pedestals. Intensity stays unchanged.',
  setup({ world }) {
    spawnCamera(world, { eye: [0, 3.5, 10], target: [0, 1.5, 0] });
    spawnGround(world);
    const wall = standard(world, { baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.55 });
    spawnMesh(world, MESH.cube, wall, { pos: [0, 2, -1], scale: [9, 5, 0.15] });
    const values = new Float32Array(256 * 128);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 256; x++) {
        const up = Math.sin((y / 127) * Math.PI) * Math.sin((x / 256) * Math.PI * 2);
        // 135° either side of up: a 270° opening, with a soft inner edge.
        values[y * 256 + x] = Math.max(0, Math.min(1, (up + Math.SQRT1_2) / 0.04));
      }
    const profile = world.allocSharedRef('IesProfileAsset', {
      kind: 'ies-profile',
      data: halfFloat.f32ToF16Bytes(new Uint8Array(values.buffer)),
    });
    const lamps = (
      [
        [-2.2, PointLight, [1, 0.55, 0.2]],
        [2.2, RectAreaLight, [0.3, 0.6, 1]],
      ] as const
    ).map(([x, component, color]) => {
      spawnMesh(world, MESH.cube, unlit(world, [0.09, 0.1, 0.12, 1]), {
        pos: [x, 0.6, 0],
        scale: [0.65, 1.2, 0.65],
      });
      spawnMesh(world, MESH.sphere, unlit(world, [...color, 1]), {
        pos: [x, 1.45, 0],
        scale: [0.12, 0.12, 0.12],
      });
      const entity = world
        .spawn(
          { component: Transform, data: { pos: [x, 1.45, 0], quat: [0, 1, 0, 0] } },
          {
            component,
            data: {
              intensity: component === PointLight ? 20 : 8,
              color,
              range: 5,
              iesProfile: profile,
            },
          },
        )
        .unwrap();
      return { entity, component };
    });
    return {
      toggle(on) {
        for (const lamp of lamps)
          world
            .set(lamp.entity, lamp.component, {
              iesProfile: on ? profile : toShared<'IesProfileAsset'>(0),
            })
            .unwrap();
      },
    };
  },
});
