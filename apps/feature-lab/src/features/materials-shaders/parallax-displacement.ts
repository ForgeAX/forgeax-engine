import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPlaneGeometry } from '@forgeax/engine/geometry';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnMesh, spawnSun, standard } from '../../lab/stage';
import { materialToggle } from './lib/swap';
import { checker, heightMap, pixels, sampler, texture } from './lib/textures';

const tile = (u: number, v: number) => (u * 4) % 1 > 0.12 && (v * 4) % 1 > 0.12;
const SIZE = 128;
const heightAt = (x: number, y: number) =>
  tile((((x % SIZE) + SIZE) % SIZE) / SIZE, (((y % SIZE) + SIZE) % SIZE) / SIZE) ? 1 : 0;
// Tangent-space normal from the same height: central differences, encoded RG(B).
const normalTexel = (u: number, v: number) => {
  const x = Math.round(u * SIZE);
  const y = Math.round(v * SIZE);
  const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * 2;
  const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * 2;
  const length = Math.hypot(dx, dy, 1);
  return [
    Math.round(((-dx / length) * 0.5 + 0.5) * 255),
    Math.round(((-dy / length) * 0.5 + 0.5) * 255),
    Math.round(((1 / length) * 0.5 + 0.5) * 255),
    255,
  ] as const;
};

export default defineFeature({
  title: 'Standard parallax displacement',
  catalog: 'Standard parallax displacement',
  kind: 'visual',
  summary:
    "displacementMode: 'parallax' ray-marches the same displacementTexture height per pixel and shifts every slot on its UV set; geometry, depth, shadows and bounds stay at the four-vertex base plane.",
  expect:
    'ON: the checker tiles on the grazing plane read as raised blocks separated by recessed grout, with far tile walls visible. OFF: the same plane and maps with vertex mode on four vertices show a flat checker.',
  setup({ world }) {
    const sceneAssets = world.assets;
    if (!(sceneAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    spawnCamera(world, { eye: [0, 1.4, 4.2], target: [0, 0, 0] });
    spawnSun(world, { direction: [-0.4, -0.8, -0.3] });
    const plane = sceneAssets.create(createPlaneGeometry(4, 4).unwrap()).unwrap();
    const nearest = sampler(world);
    const height = heightMap(world, (u, v) => (tile(u, v) ? 1 : 0), SIZE);
    const normal = texture(world, SIZE, pixels(SIZE, normalTexel), 'linear');
    const base = {
      baseColor: [1, 1, 1, 1] as const,
      roughness: 0.7,
      baseColorTexture: {
        texture: checker(world, [235, 140, 60, 255], [80, 120, 200, 255], 4, SIZE),
        sampler: nearest,
      } as never,
      normalTexture: { texture: normal, sampler: nearest } as never,
      displacementTexture: { texture: height, sampler: nearest } as never,
      displacementScale: 0.16,
      displacementBias: -0.16,
    };
    const parallax = standard(world, { ...base, displacementMode: 'parallax' });
    const vertex = standard(world, { ...base, displacementMode: 'vertex' });
    const sheet = spawnMesh(world, plane as never, parallax, {
      rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    return { toggle: materialToggle(world, sheet, parallax, vertex) };
  },
});
