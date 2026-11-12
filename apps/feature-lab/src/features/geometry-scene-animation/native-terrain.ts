import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { Materials } from '@forgeax/engine/render';
import { Transform } from '@forgeax/engine/scene';
import { Terrain } from '@forgeax/engine/terrain';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnSun } from '../../lab/stage';

const SIDE = 8;
function layerWeights(painted: boolean): Float32Array {
  const weights = new Float32Array(SIDE * SIDE * 2);
  for (let i = 0; i < SIDE * SIDE; i++) {
    const green = painted && i % SIDE >= SIDE / 2 ? 1 : 0;
    weights[i * 2] = 1 - green;
    weights[i * 2 + 1] = green;
  }
  return weights;
}

export default defineFeature({
  title: 'Native Terrain',
  catalog: 'Native Terrain',
  kind: 'visual',
  summary:
    'One managed Terrain heightfield retains its section and material closure. Layer preparation uses compute on capable devices and four raster attachments on WebGL2.',
  expect:
    'ON: the hill has red and green painted halves. OFF: the same hill is entirely red. The Terrain entity keeps the same managed asset handle.',
  setup({ world }) {
    const assets = world.assets;
    if (!(assets instanceof AssetRegistry))
      throw new Error('Terrain requires its runtime asset owner');
    world.components.register(Terrain).unwrap();
    spawnCamera(world, { eye: [4, 5, 6], target: [0, 0.2, 0], data: { antialias: 0, bloom: 0 } });
    spawnSun(world);
    const heights = Float32Array.from(
      { length: SIDE * SIDE },
      (_, i) =>
        0.6 *
        Math.sin((Math.PI * (i % SIDE)) / (SIDE - 1)) *
        Math.sin((Math.PI * Math.floor(i / SIDE)) / (SIDE - 1)),
    );
    const layers = [
      [0.8, 0.1, 0.05],
      [0.05, 0.6, 0.1],
    ].map((color) => ({
      material: assets
        .create(
          Materials.standard({
            baseColor: [color[0] ?? 0, color[1] ?? 0, color[2] ?? 0, 1],
            roughness: 0.9,
          }),
        )
        .unwrap(),
      blend: 'weight' as const,
    }));
    const asset = assets
      .create({
        kind: 'terrain',
        columns: SIDE,
        rows: SIDE,
        subsectionVertices: SIDE,
        spacing: 0.5,
        heights,
        weights: layerWeights(true),
        layers,
        materialEncoding: { kind: 'weights' },
      })
      .unwrap();
    const entity = world
      .spawn(
        { component: Transform, data: { pos: [-1.75, 0, -1.75] } },
        { component: Terrain, data: { asset, forcedLod: 0 } },
      )
      .unwrap();
    return {
      toggle(on) {
        assets.update(asset, { weights: layerWeights(on) }).unwrap();
      },
      checks() {
        return [
          {
            name: 'managed Terrain identity survives painting',
            ok: world.get(entity, Terrain).unwrap().asset === asset,
          },
        ];
      },
    };
  },
});
