import { MeshRenderer } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnGround, spawnMesh, standard, unlit } from '../../lab/stage';

export default defineFeature({
  title: 'Unlit shading',
  catalog: 'Unlit shading',
  kind: 'visual',
  summary:
    'Materials.unlit outputs its color with no light or IBL. The scene has no light at all, so only unlit surfaces are visible.',
  expect:
    'ON: three bright flat magenta/cyan/yellow shapes on a black stage. OFF: the same shapes use Standard PBR and turn black (no light in the scene).',
  setup({ world }) {
    spawnGround(world);
    spawnCamera(world);
    const colors = [
      [1, 0.1, 0.8, 1],
      [0.1, 0.9, 1, 1],
      [1, 0.9, 0.1, 1],
    ] as const;
    const flat = colors.map((rgba) => unlit(world, rgba));
    const lit = colors.map((baseColor) => standard(world, { baseColor }));
    const meshes = [MESH.cube, MESH.sphere, MESH.cube] as const;
    const entities = meshes.map((mesh, index) =>
      spawnMesh(world, mesh, flat[index] as (typeof flat)[number], {
        pos: [-1.6 + index * 1.6, 0.6, 0],
        scale: [1, 1, 1],
      }),
    );
    return {
      toggle(on) {
        entities.forEach((entity, index) => {
          world.set(entity, MeshRenderer, { materials: [on ? flat[index] : lit[index]] } as never);
        });
      },
    };
  },
});
