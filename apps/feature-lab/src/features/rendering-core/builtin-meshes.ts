import { HANDLE_CYLINDER } from '@forgeax/engine/assets-runtime';
import { MeshRenderer } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Built-in meshes + Standard PBR',
  catalog: 'Builtin mesh handles',
  kind: 'visual',
  summary:
    'HANDLE_CUBE / HANDLE_SPHERE / HANDLE_CYLINDER / HANDLE_QUAD render with no asset loading, lit by one DirectionalLight.',
  expect:
    'ON: red cube, green sphere, blue cylinder and yellow quad sit on a grey floor. OFF: the four shapes turn plain white.',
  setup({ world }) {
    spawnStage(world);
    const colors = [
      [0.9, 0.2, 0.2, 1],
      [0.2, 0.8, 0.3, 1],
      [0.2, 0.4, 0.95, 1],
      [0.95, 0.85, 0.2, 1],
    ] as const;
    const meshes = [MESH.cube, MESH.sphere, HANDLE_CYLINDER, MESH.quad] as const;
    const tinted = colors.map((baseColor) => standard(world, { baseColor, roughness: 0.5 }));
    const white = standard(world, { baseColor: [1, 1, 1, 1], roughness: 0.5 });
    const entities = meshes.map((mesh, index) =>
      spawnMesh(world, mesh, tinted[index] as (typeof tinted)[number], {
        pos: [-2.1 + index * 1.4, 0.5, 0],
        scale: [0.9, 0.9, 0.9],
      }),
    );
    return {
      toggle(on) {
        entities.forEach((entity, index) => {
          world.set(entity, MeshRenderer, { materials: [on ? tinted[index] : white] } as never);
        });
      },
    };
  },
});
