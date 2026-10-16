// Sponza direct-light probe: renders the GI-off raster direct image under shadow
// configuration variants and compares each with the path-traced direct reference
// (scripts/reference.mjs --reference-cache output). Pixels lit in raster but in
// shadow in the reference ("leak") and the reverse ("over-shadow") are counted
// separately from the lit-lit ratio, so a units/tone error and a shadow error do not mix.
//
//   node scripts/gi-direct-probe.mjs --reference <cache>/sponza-512px-256spp-b1-diffuse
//     [--size 512] [--out <dir>] [--sponza-dist <dist>]

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import * as gi from './gi-dawn.mjs';
import { luminance, readPfm, toDisplay, writePng } from './gi-metrics.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const SIZE = Number(option('size', '512'));
const OUT = resolve(option('out', resolve(gi.monorepoRoot, 'artifacts/gi-direct-probe')));
const SPONZA_DIST = resolve(option('sponza-dist', resolve(gi.appRoot, 'dist')));
const reference = readPfm(resolve(option('reference'), 'direct.pfm')).rgb;
mkdirSync(OUT, { recursive: true });

await gi.installDawn();
const { SPONZA } = await import('../src/scenes.ts');
const { spawnCamera } = await import('../src/build-scene.ts');
const { DirectionalLight, DirectionalShadowFilterValue } = await import('@forgeax/engine-render');

const VARIANTS = [
  { name: 'as-authored', light: {} },
  { name: 'hard', light: { shadowFilter: DirectionalShadowFilterValue.pcf1 } },
  { name: 'map4096', light: { mapSize: 4096 } },
  { name: 'map4096-1cascade-80m', light: { mapSize: 4096, cascadeCount: 1, shadowDistance: 80 } },
  { name: 'nobias', light: { normalBias: 0, depthBias: 0.000001 } },
  { name: 'map4096-nobias-hard', light: { mapSize: 4096, normalBias: 0, depthBias: 0.000001, shadowFilter: DirectionalShadowFilterValue.pcf1 } },
  { name: 'no-shadow', light: { castShadow: false } },
];

const results = [];
for (const variant of VARIANTS) {
  const { renderer, assets, errors } = await gi.createGiRenderer({ width: SIZE, height: SIZE });
  const world = new World();
  const { createWorldContext } = await import('@forgeax/engine-ecs');
  const { renderComponentsPlugin } = await import('@forgeax/engine-render');
  const { scenePlugin } = await import('@forgeax/engine-scene');
  await createWorldContext(world, [renderComponentsPlugin(), scenePlugin()]);
  const restore = gi.installDistCatalog(assets, SPONZA_DIST);
  try {
    const asset = (await assets.loadByGuid(assets.parseGuid(SPONZA.sceneGuid))).unwrap();
    assets.instantiate(world.allocSharedRef('SceneAsset', asset), world).unwrap();
  } finally {
    restore();
  }
  world
    .spawn({
      component: DirectionalLight,
      data: {
        direction: [...SPONZA.light.direction],
        color: [...SPONZA.light.color],
        intensity: SPONZA.light.intensity,
        castShadow: true,
        mapSize: 1024,
        cascadeCount: 4,
        shadowDistance: 40,
        ...variant.light,
      },
    })
    .unwrap();
  spawnCamera(world, SPONZA.camera, 1);
  const lease = renderer.attach(world).unwrap();
  const driver = await gi.createFrameDriver({ renderer, world, lease });
  renderer.setProfile(gi.directProfile(renderer.inspect().profile)).unwrap();
  for (let i = 0; i < 16; i++) await driver.draw();
  const { observed } = await driver.observe(['linear-hdr']);
  const rgb = gi.hdrToRgb(observed.observations.find((o) => o.domain === 'linear-hdr'), SIZE, SIZE);
  const L = Array.from({ length: SIZE * SIZE }, (_, p) => luminance(rgb, p));
  const R = Array.from({ length: SIZE * SIZE }, (_, p) => luminance(reference, p));
  const covered = L.map((v, p) => v > 0 || R[p] > 0);
  const medianOf = (values) => values.sort((a, b) => a - b)[values.length >> 1] ?? 0;
  const litL = 0.05 * medianOf(L.filter((v, p) => covered[p] && v > 1e-4));
  const litR = 0.05 * medianOf(R.filter((v, p) => covered[p] && v > 1e-4));
  const bucket = { bothLit: [0, 0, 0], leak: [0, 0, 0], overShadow: [0, 0, 0] };
  let sumL = 0;
  let sumR = 0;
  for (let p = 0; p < L.length; p++) {
    if (!covered[p]) continue;
    sumL += L[p];
    sumR += R[p];
    const key = L[p] > litL ? (R[p] > litR ? 'bothLit' : 'leak') : R[p] > litR ? 'overShadow' : undefined;
    if (key === undefined) continue;
    bucket[key][0] += 1;
    bucket[key][1] += L[p];
    bucket[key][2] += R[p];
  }
  const result = {
    variant: variant.name,
    light: variant.light,
    ratio: sumL / sumR,
    bothLitRatio: bucket.bothLit[1] / bucket.bothLit[2],
    leakPixels: bucket.leak[0],
    leakEnergyShare: (bucket.leak[1] - bucket.leak[2]) / sumR,
    overShadowPixels: bucket.overShadow[0],
    overShadowEnergyShare: (bucket.overShadow[2] - bucket.overShadow[1]) / sumR,
    errors: errors.map((e) => (typeof e === 'string' ? e : e.code)),
  };
  results.push(result);
  const exposure = 0.5 / Math.max(1e-4, sumR / covered.filter(Boolean).length);
  const overlay = toDisplay(rgb, SIZE, SIZE, exposure);
  for (let p = 0; p < L.length; p++)
    if (covered[p] && L[p] > litL && R[p] <= litR) overlay.set([255, 0, 255, 255], p * 4);
    else if (covered[p] && L[p] <= litL && R[p] > litR) overlay.set([0, 255, 255, 255], p * 4);
  writePng(resolve(OUT, `direct-${variant.name}.png`), toDisplay(rgb, SIZE, SIZE, exposure), SIZE, SIZE);
  writePng(resolve(OUT, `direct-${variant.name}-mask.png`), overlay, SIZE, SIZE);
  console.log(`[direct] ${JSON.stringify(result)}`);
  renderer.dispose?.();
}
writePng(
  resolve(OUT, 'direct-reference.png'),
  toDisplay(reference, SIZE, SIZE, 0.5 / Math.max(1e-4, reference.reduce((a, b) => a + b, 0) / reference.length)),
  SIZE,
  SIZE,
);
writeFileSync(resolve(OUT, 'direct-probe.json'), `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
