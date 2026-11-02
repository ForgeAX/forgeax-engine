import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grid, type Scene, writeMesh } from '../lib.mts';

/** The ordinary Dawn roster exercises the same file carrier as externally generated cases. */
export function createRenderFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-tg-render-'));
  writeMesh(join(root, 'meshes'), 'panel', grid(1, 1, 1, 1, 1, 1, 'panel', -0.5, -0.5));
  const textures = join(root, 'textures');
  mkdirSync(textures);
  for (const [name, pixel] of [
    ['normal', [128, 128, 255, 255]],
    ['albedo', [220, 60, 20, 255]],
    ['orm', [255, 180, 0, 255]],
  ] as const) {
    writeFileSync(join(textures, `${name}.rgba`), Buffer.from(Array.from({ length: 4 }, () => pixel).flat()));
  }
  const scene: Scene = {
    W: 64, H: 48, fov: Math.PI / 3,
    meshes: ['panel'],
    textures: { panel: { w: 2, h: 2, dir: textures } },
    materials: {
      plain: { color: [0.8, 0.2, 0.1], metallic: 0, roughness: 0.6 },
      mapped: { color: [1, 1, 1], metallic: 0, roughness: 0.6, maps: 'panel' },
    },
    variants: {
      plain: [{ mesh: 'panel', materials: ['plain'] }],
      mapped: [{ mesh: 'panel', materials: ['mapped@mip'] }],
    },
    views: { front: { eye: [0, 0, 2], target: [0, 0, 0] } },
    jobs: [
      { view: 'front', variant: 'plain', out: 'plain' },
      { view: 'front', variant: 'mapped', out: 'mapped' },
      { view: 'front', variant: 'mapped', out: 'id', id: true },
    ],
  };
  writeFileSync(join(root, 'scene.json'), JSON.stringify(scene));
  return root;
}
