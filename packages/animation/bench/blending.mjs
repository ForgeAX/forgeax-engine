// Kernel throughput, real World playback, and an optional same-workload baseline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import * as current from '../dist/index.mjs';

const out = resolve(process.env.ANIMATION_EVIDENCE ?? 'artifacts/animation-blending');
mkdirSync(out, { recursive: true });
const baseline = process.env.ANIMATION_BASELINE_MODULE === undefined ? undefined : await import(pathToFileURL(resolve(process.env.ANIMATION_BASELINE_MODULE)));
const warmup = 60, samples = 300;
const rows = [];
function record(name, raw, budgetMs) {
  const sorted = [...raw].sort((a, b) => a - b);
  const row = { name, warmup, samples, medianMs: sorted[150], p95Ms: sorted[285], p99Ms: sorted[297], maxMs: sorted.at(-1), budgetMs, samplesMs: raw };
  rows.push(row);
  console.log(JSON.stringify({ ...row, samplesMs: undefined }));
  return row;
}
function measure(name, operation, budgetMs) {
  for (let i = 0; i < warmup; i++) operation(i);
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now(); operation(i); raw.push(performance.now() - start);
  }
  return record(name, raw, budgetMs);
}
const one = current.createBlendSpace1D(Array.from({ length: 32 }, (_, i) => i)).unwrap();
const oneWeights = new Float32Array(32);
measure('1D-32-samples-10000-evaluations', (frame) => {
  for (let i = 0; i < 10000; i++) one.sample(oneWeights, (i + frame) % 3100 / 100).unwrap();
}, 16.67);
const two = current.createBlendSpace2D({ points: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]], triangles: [[0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4], [3, 4, 7], [3, 7, 6], [4, 5, 8], [4, 8, 7]] }).unwrap();
const twoWeights = new Float32Array(9);
measure('2D-9-samples-8-triangles-10000-evaluations', (frame) => {
  for (let i = 0; i < 10000; i++) two.sample(twoWeights, (i + frame) % 400 / 100 - 1, (i * 3 + frame) % 400 / 100 - 1).unwrap();
}, 16.67);

async function preparePlayback(api, masked) {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin(), api.animationPlugin()]);
  const ids = Array.from({ length: 16 }, (_, i) => api.deriveAnimationTargetId(['Rig', String(i)]));
  const clip = (value) => ({ kind: 'animation-clip', duration: 2, channels: ids.map((targetId) => ({ targetId, property: 'translation', sampler: { input: new Float32Array([0]), output: new Float32Array([value, 0, 0]), interpolation: 'STEP' } })) });
  const clips = [0, 10].map((value) => world.allocSharedRef('AnimationClip', clip(value)));
  const mask = masked ? world.allocSharedRef('AnimationMask', api.defineAnimationMask(ids.slice(8).map((targetId) => ({ targetId, weight: 1 }))).unwrap()) : 0;
  let first, last;
  for (let i = 0; i < 100; i++) {
    const player = world.spawn({ component: Transform, data: {} }, { component: api.AnimationPlayer, data: { clips, times: [0, 0], speeds: [1, 1], weights: [0.5, 0.5], ...(masked ? { masks: [0, mask] } : {}) } }).unwrap();
    const targets = ids.map((value) => world.spawn({ component: Transform, data: {} }, { component: ChildOf, data: { parent: player } }, { component: api.AnimationTargetId, data: { value } }).unwrap());
    api.bindAnimationTargets(world, player, targets).unwrap();
    first ??= targets[0]; last = targets.at(-1);
  }
  return {
    tick: () => world.update(1 / 60).unwrap(),
    check() {
      assert.equal(world.get(first, Transform).unwrap().pos[0], masked ? 0 : 5);
      assert.equal(world.get(last, Transform).unwrap().pos[0], 5);
    },
    dispose: () => context.fiber.dispose(),
  };
}
// Four independent Worlds share the same ECS/Scene build. Pair each measurement
// round old/new/new/old, so changing host load cannot bias seconds-long blocks.
const comparisons = [];
if (baseline !== undefined) {
  const worlds = [];
  const labels = ['baseline', 'current', 'current', 'baseline'];
  try {
    for (const api of [baseline, current, current, baseline]) worlds.push(await preparePlayback(api, false));
    for (let i = 0; i < warmup; i++) for (const world of worlds) world.tick();
    const raw = worlds.map(() => []);
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < worlds.length; j++) {
        const start = performance.now(); worlds[j].tick(); raw[j].push(performance.now() - start);
      }
    }
    for (let j = 0; j < worlds.length; j++) {
      worlds[j].check(); comparisons.push(record(`${labels[j]}-100-rigs-16-targets`, raw[j], 16.67));
    }
  } finally { for (const world of worlds) await world.dispose(); }
} else {
  const world = await preparePlayback(current, false);
  try { measure('unmasked-100-rigs-16-targets', world.tick, 16.67); world.check(); }
  finally { await world.dispose(); }
}
const masked = await preparePlayback(current, true);
try { measure('masked-100-rigs-16-targets', masked.tick, 16.67); masked.check(); }
finally { await masked.dispose(); }
const ratio = comparisons.length === 0 ? undefined : (comparisons[1].medianMs + comparisons[2].medianMs) / (comparisons[0].medianMs + comparisons[3].medianMs);
const report = { comparisonMethod: 'per-round-ABBA-independent-worlds', head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, hardware: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, rows, unmaskedMedianRatio: ratio, unmaskedRegressionBudget: 1.05 };
writeFileSync(resolve(out, 'cpu-blending.json'), JSON.stringify(report, null, 2));
assert(rows.every((row) => row.p95Ms <= row.budgetMs), 'CPU frame/throughput budget exceeded; retain raw samples');
if (ratio !== undefined) assert(ratio <= 1.05, `unmasked median regression ${ratio}; retain raw samples`);
