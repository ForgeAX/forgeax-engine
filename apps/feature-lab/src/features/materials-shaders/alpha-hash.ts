import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { materialToggle } from './lib/swap';

export default defineFeature({
  title: 'Alpha Hash coverage',
  catalog: 'Alpha Hash coverage',
  kind: 'visual',
  summary:
    'alphaHash:true turns base-color alpha into stochastic per-pixel coverage while staying in the opaque queue with depth writes; no blending or sorting.',
  expect:
    'ON: the red sphere (alpha 0.35) is a noisy screen-door dither and the green cube behind shows through. OFF: alphaHash off, the same alpha is ignored by the opaque pass and the sphere is solid red.',
  setup({ world }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.1, 0.9, 0.2, 1] }), {
      pos: [0, 0.8, -1.2],
      scale: [2.4, 1.6, 0.3],
    });
    const hashed = standard(world, { baseColor: [1, 0.1, 0.1, 0.35], alphaHash: true });
    const opaque = standard(world, { baseColor: [1, 0.1, 0.1, 0.35] });
    const sphere = spawnMesh(world, MESH.sphere, hashed, {
      pos: [0, 0.8, 0.4],
      scale: [1.3, 1.3, 1.3],
    });
    return { toggle: materialToggle(world, sphere, hashed, opaque) };
  },
});
