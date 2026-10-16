// hello-gi per-tier / per-lane budget probe under Dawn. For each requested
// configuration it settles the lane, then reports median GPU pass time, graph
// pass counts and wall time over the sampled frames as one JSON document.
//
//   node scripts/gi-budget.mjs [--scenes cornell,courtyard,sponza] [--size 256]
//     [--frames 16] [--tiers low,medium,high,epic] [--gathers exact]
//     [--capture-kib <Card byte ceiling>] [--sponza-dist <hello-gi dist>]
//     [--passes] [--warmup <frames>] [--out <file.json>]
//
// --capture-kib lowers the tier Card ceiling below the scene's needs so the
// Global SDF field streams Card residency; each row then reports its counters.
//
// `--warmup` draws extra frames after the lane is ready, before sampling: the
// irradiance field radiates every Card tile for four probe sweeps after its last
// capture slice, so its static-scene cost needs a warm-up of at least
// 4 * probes.count / probes.perFrame frames.
//
// `--passes` keeps the per-pass medians of the GI passes and the lane's
// `inspect().diffuseGi.cards` budget counters and probe counts in each result.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import * as gi from './gi-dawn.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? fallback : args[i + 1];
};
const list = (name, fallback) => option(name, fallback).split(',').filter(Boolean);
const SIZE = Number(option('size', '256'));
const FRAMES = Number(option('frames', '16'));
const SCENES = list('scenes', 'cornell,courtyard');
const TIERS = list('tiers', 'low,medium,high,epic');
const GATHERS = list('gathers', '');
const SPONZA_DIST = resolve(option('sponza-dist', resolve(gi.appRoot, 'dist')));
const OUT = option('out');
const CAPTURE_KIB = option('capture-kib');
const PASSES = args.includes('--passes');
const WARMUP = Number(option('warmup', '0'));

await gi.installDawn();
const { PROCEDURAL_SCENES, SPONZA, diffuseGiFor, tierSceneFor } = await import('../src/scenes.ts');
const { createGiBoxMesh, spawnProceduralScene } = await import('../src/build-scene.ts');
const { resolveDiffuseGiTier } = await import('@forgeax/engine-render');
const boxMesh = await createGiBoxMesh();
const cooked = await gi.cookGiMaterials();

async function measure(sceneId, configure) {
  const { renderer, assets, errors } = await gi.createGiRenderer({
    width: SIZE,
    height: SIZE,
    timing: true,
  });
  const world = new World();
  const scene = sceneId === 'sponza' ? SPONZA : PROCEDURAL_SCENES[sceneId];
  if (sceneId === 'sponza') await gi.spawnSponza(world, assets, SPONZA_DIST);
  else spawnProceduralScene(world, scene, gi.publishMaterials(world, assets, cooked), 1, boxMesh);
  const lease = renderer.attach(world).unwrap();
  const driver = await gi.createFrameDriver({ renderer, world, lease });
  const direct = gi.directProfile(renderer.inspect().profile);
  const label = configure(renderer, direct, scene);
  const started = performance.now();
  await driver.settle();
  for (let k = 0; k < WARMUP; k++) await driver.draw();
  const settleMs = performance.now() - started;
  const timings = [];
  const sampled = performance.now();
  for (let k = 0; k < FRAMES; k++) {
    const { observed } = await driver.observe(['linear-hdr'], ['linear-hdr', 'timings']);
    timings.push(observed.timings);
  }
  const { passes, ...gpu } = gi.summarizeTimings(timings);
  const field = renderer.inspect().diffuseGi;
  const cards = field?.cards;
  const probes =
    field?.gather === 'irradiance-field' && field.probes !== undefined
      ? { count: field.probes.count, perFrame: field.probes.perFrame }
      : undefined;
  const result = {
    scene: sceneId,
    ...label,
    gpu,
    residency: field?.residency,
    ...(PASSES
      ? {
          passes: (passes ?? []).filter((p) => /irradiance|ray|probe|diffuse/i.test(p.name)),
          ...(cards === undefined ? {} : { cards }),
          ...(probes === undefined ? {} : { probes }),
        }
      : {}),
    wallMs: { settle: settleMs, perFrame: (performance.now() - sampled) / FRAMES },
    errors: errors.length,
  };
  renderer.dispose?.();
  return result;
}

const results = [];
for (const sceneId of SCENES) {
  for (const tier of TIERS)
    results.push(
      await measure(sceneId, (renderer, direct, scene) => {
        const resolved = resolveDiffuseGiTier(
          tier,
          {
            ...tierSceneFor(scene),
            ...(CAPTURE_KIB === undefined ? {} : { maxCaptureBytes: Number(CAPTURE_KIB) * 1024 }),
          },
          renderer.inspect().capabilities,
        ).unwrap();
        const { diffuseGi: _previous, ...base } = direct;
        renderer.setProfile({ ...base, ...resolved.profile }).unwrap();
        return { tier, lane: resolved.lane, fallback: resolved.fallback?.reason };
      }),
    );
  for (const gather of GATHERS)
    results.push(
      await measure(sceneId, (renderer, direct, scene) => {
        renderer.setProfile({ ...direct, diffuseGi: diffuseGiFor(gather, scene) }).unwrap();
        return { gather };
      }),
    );
}
for (const r of results)
  console.log(
    `[gi-budget] ${r.scene} ${r.tier ?? r.gather} lane=${r.lane ?? r.gather} passes=${r.gpu.passCount} giPasses=${r.gpu.giPassCount} gpuMs=${r.gpu.totalMs?.toFixed(2)} giMs=${r.gpu.giMs?.toFixed(2)} wallMs=${r.wallMs.perFrame.toFixed(1)}${r.residency === undefined ? '' : ` residency=${JSON.stringify(r.residency)}`}`,
  );
if (OUT !== undefined) writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
// Dawn keeps native handles alive past the last renderer; exit explicitly.
process.exit(0);
