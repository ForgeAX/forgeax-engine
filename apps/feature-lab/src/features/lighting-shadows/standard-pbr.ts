import type { EntityHandle } from '@forgeax/engine/ecs';
import { MeshRenderer } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard, unlit } from '../../lab/stage';

export default defineFeature({
  title: 'Standard PBR',
  catalog: 'Standard PBR',
  kind: 'visual',
  summary:
    'Materials.standard evaluates metallic/roughness PBR against the sun: five red spheres sweep roughness 0.1 -> 0.9, the top row is metallic.',
  expect:
    'ON: shaded red spheres with highlights that grow wider with roughness; metallic ones look darker and mirror-like. OFF: every sphere is a flat, unshaded red disc.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 1.6, 5.5], target: [0, 1, 0] });
    const pbr: ReturnType<typeof standard>[] = [];
    const entities: EntityHandle[] = [];
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 5; i++) {
        const mat = standard(world, {
          baseColor: [0.9, 0.15, 0.1, 1],
          metallic: row,
          roughness: 0.1 + i * 0.2,
        });
        pbr.push(mat);
        entities.push(
          spawnMesh(world, MESH.sphere, mat, {
            pos: [-2.4 + i * 1.2, 0.5 + row * 1.1, 0],
            scale: [0.5, 0.5, 0.5],
          }),
        );
      }
    }
    const flat = unlit(world, [0.9, 0.15, 0.1, 1]);
    return {
      toggle(on) {
        entities.forEach((entity, index) => {
          world.set(entity, MeshRenderer, { materials: [on ? pbr[index] : flat] } as never);
        });
      },
    };
  },
});
