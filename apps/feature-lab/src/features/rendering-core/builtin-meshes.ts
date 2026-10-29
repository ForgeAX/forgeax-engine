import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { MeshRenderer } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Built-in meshes + Standard PBR',
  catalog: 'Primitive mesh factories',
  kind: 'visual',
  summary:
    'Code-created cube, sphere, cylinder and quad assets share the ordinary runtime asset owner and render under one DirectionalLight.',
  expect:
    'ON: red cube, green sphere, blue cylinder and yellow quad sit on a grey floor. OFF: the four shapes turn plain white.',
  setup({ world }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const stageSphere = primitiveAssets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

    const stageQuad = primitiveAssets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

    spawnStage(world);
    const colors = [
      [0.9, 0.2, 0.2, 1],
      [0.2, 0.8, 0.3, 1],
      [0.2, 0.4, 0.95, 1],
      [0.95, 0.85, 0.2, 1],
    ] as const;
    const cylinder = primitiveAssets.create(createPrimitiveMesh('cylinder').unwrap()).unwrap();
    const meshes = [stageCube, stageSphere, cylinder, stageQuad] as const;
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
