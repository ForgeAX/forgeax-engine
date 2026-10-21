import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { Materials } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { material, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { materialToggle } from './lib/swap';

export default defineFeature({
  title: 'Material render state (x-ray)',
  catalog: 'Material render state',
  kind: 'visual',
  summary:
    'MaterialPass.renderState drives depth compare/write, blend, cull and queue. depthCompare "always" + depthWriteEnabled false + a late queue draws a sphere through the wall in front of it.',
  expect:
    'ON: a red sphere is visible through the grey wall (x-ray). OFF: the default less-equal depth test hides the sphere behind the wall.',
  setup({ world }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    const stageSphere = primitiveAssets.create(createPrimitiveMesh('sphere').unwrap()).unwrap();

    spawnStage(world);
    spawnMesh(
      world,
      stageCube,
      standard(world, { baseColor: [0.6, 0.6, 0.65, 1], roughness: 0.8 }),
      {
        pos: [0, 0.9, 1.2],
        scale: [2.4, 1.8, 0.2],
      },
    );
    const xray = material(
      world,
      Materials.unlit([1, 0.1, 0.1, 1], {
        queue: 3000,
        renderState: { depthCompare: 'always', depthWriteEnabled: false },
      }),
    );
    const normal = material(world, Materials.unlit([1, 0.1, 0.1, 1]));
    const sphere = spawnMesh(world, stageSphere, xray, {
      pos: [0, 0.9, -0.6],
      scale: [1.1, 1.1, 1.1],
    });
    return { toggle: materialToggle(world, sphere, xray, normal) };
  },
});
