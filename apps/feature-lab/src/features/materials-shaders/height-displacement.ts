import { createPlaneGeometry } from '@forgeax/engine/geometry';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnMesh, spawnSun, standard } from '../../lab/stage';
import { materialToggle } from './lib/swap';
import { heightMap } from './lib/textures';

export default defineFeature({
  title: 'Standard height vertex displacement',
  catalog: 'Standard height vertex displacement',
  kind: 'visual',
  summary:
    'displacementTexture moves vertices along the normal by height * displacementScale + displacementBias in one shared vertex kernel (color, depth, shadow); shading derives normals from the displaced triangles. Needs a dense mesh.',
  expect:
    'ON: the dense orange plane rises into a grid of lit, shadowed hills. OFF: the same mesh and height map without displacement is a flat sheet.',
  setup({ world }) {
    spawnCamera(world, { eye: [0, 3.2, 4.2], target: [0, 0, 0] });
    spawnSun(world, { direction: [-0.8, -0.6, -0.3] });
    const plane = world.allocSharedRef('MeshAsset', createPlaneGeometry(4, 4, 128, 128).unwrap());
    const hills = heightMap(
      world,
      (u, v) => 0.5 + 0.5 * Math.sin(u * Math.PI * 6) * Math.sin(v * Math.PI * 6),
      128,
    );
    const base = { baseColor: [1, 0.55, 0.15, 1] as const, roughness: 0.7 };
    const displaced = standard(world, {
      ...base,
      displacementTexture: hills as never,
      displacementScale: 0.6,
    });
    const flat = standard(world, base);
    const sheet = spawnMesh(world, plane as never, displaced, {
      rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    return { toggle: materialToggle(world, sheet, displaced, flat) };
  },
});
