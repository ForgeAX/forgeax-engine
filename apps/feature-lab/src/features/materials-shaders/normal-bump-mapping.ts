import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { materialToggle } from './lib/swap';
import { heightMap, pixels, texture } from './lib/textures';

export default defineFeature({
  title: 'Standard normal and bump mapping',
  catalog: 'Standard normal and bump mapping',
  kind: 'visual',
  summary:
    'normalTexture with a two-axis normalScale perturbs shading from a tangent-space map; bumpTexture supplies tangent-free gradients from a height map. Left cube: normal map. Right cube: bump map.',
  expect:
    'ON: the left cube shows strong vertical ridges from the normal map and the right cube shows round dimples from the bump map, both under grazing light. OFF: both cubes are flat and smooth.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 1.6, 4.5], target: [0, 0.8, 0] });
    const normals = texture(
      world,
      64,
      pixels(64, (u) => {
        const x = Math.sin(u * Math.PI * 16) * 0.8;
        const z = Math.sqrt(1 - x * x);
        return [Math.round((x * 0.5 + 0.5) * 255), 128, Math.round((z * 0.5 + 0.5) * 255), 255];
      }),
      'linear',
    );
    const bumps = heightMap(
      world,
      (u, v) => 0.5 + 0.5 * Math.sin(u * Math.PI * 12) * Math.sin(v * Math.PI * 12),
    );
    const base = { baseColor: [0.9, 0.85, 0.8, 1] as const, roughness: 0.35 };
    const normalMat = standard(world, {
      ...base,
      normalTexture: normals as never,
      normalScale: [1.5, 1.5],
    });
    const bumpMat = standard(world, { ...base, bumpTexture: bumps as never, bumpScale: 4 });
    const plain = standard(world, base);
    const left = spawnMesh(world, MESH.cube, normalMat, {
      pos: [-1, 0.8, 0],
      scale: [1.4, 1.4, 1.4],
    });
    const right = spawnMesh(world, MESH.cube, bumpMat, {
      pos: [1, 0.8, 0],
      scale: [1.4, 1.4, 1.4],
    });
    const a = materialToggle(world, left, normalMat, plain);
    const b = materialToggle(world, right, bumpMat, plain);
    return {
      toggle(on) {
        a(on);
        b(on);
      },
    };
  },
});
