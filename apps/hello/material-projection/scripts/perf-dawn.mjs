#!/usr/bin/env node
// Paired material cost probe over one full-screen sphere grid. Each lane swaps
// only the grid material against its baseline:
//   standard-triplanar     - world triplanar (3 taps per map) vs standard-uv
//   standard-object-normal - object-space normal decode vs standard-uv
//   lambert                - diffuse-only Standard path vs standard-uv
//   matcap / normal        - unlit shading modes vs plain unlit
// standard-uv is Standard with UV base + tangent normal maps. Each pair runs in
// one process that alternates lane and baseline every 8-frame block, so both
// see the same GPU clock state; per-process clock variance on Apple GPUs is
// larger than the lane deltas. The verdict is the median over PERF_ROUNDS
// processes of the in-process median ratio. A local diagnostic, not a CI gate.
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectionManifest, runProjection } from './dawn-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const grid = Number.parseInt(process.env.PERF_GRID ?? '6', 10);
const frames = Number.parseInt(process.env.PERF_FRAMES ?? '960', 10);
// A few large spheres at a high resolution keep the frame fragment-bound, so
// lane deltas measure shading rather than per-draw CPU work.
const [perfWidth, perfHeight] = (process.env.PERF_SIZE ?? '2560x1440').split('x').map((value) => Number.parseInt(value, 10));
// Samples are 8-frame blocks; the first quarter is warmup (pipeline compile).
const warmup = Math.floor(frames / 8 / 4);
const rounds = Number.parseInt(process.env.PERF_ROUNDS ?? '4', 10);
const BASELINES = {
  'standard-triplanar': 'standard-uv',
  'standard-object-normal': 'standard-uv',
  lambert: 'standard-uv',
  matcap: 'unlit',
  normal: 'unlit',
};
const middle = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

if (process.env.PERF_CHILD_LANE !== undefined) {
  const lane = process.env.PERF_CHILD_LANE;
  const baseline = BASELINES[lane];
  const run = await runProjection({
    appRoot: resolve(here, '..'),
    grid,
    gridLane: baseline,
    timeLanes: [baseline, lane],
    frames,
    timeFrames: true,
    size: { width: perfWidth, height: perfHeight },
  });
  run.dispose();
  if (run.errors.length > 0) {
    console.error(`engine errors=${run.errors.map((error) => error.code).join(',')}`);
    process.exit(1);
  }
  const skip = Math.ceil(warmup / 2);
  const laneMedian = middle(run.laneMs[lane].slice(skip));
  const baselineMedian = middle(run.laneMs[baseline].slice(skip));
  console.log(JSON.stringify({ lane, baseline, laneMedian, baselineMedian, ratio: laneMedian / baselineMedian }));
  process.exit(0);
}

// Build the shader manifest once; every child reads the same file.
process.env.PROJECTION_MANIFEST ??= resolve(tmpdir(), `forgeax-projection-manifest-${process.pid}.json`);
await projectionManifest();
const results = {};
for (let round = 0; round < rounds; round += 1)
  for (const lane of Object.keys(BASELINES)) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, PERF_CHILD_LANE: lane },
      encoding: 'utf8',
    });
    if (child.status !== 0) {
      console.error(child.stdout, child.stderr);
      process.exit(1);
    }
    const sample = JSON.parse(child.stdout.trim().split('\n').at(-1));
    console.log(
      `[perf] round ${round} ${lane.padEnd(24)} ${sample.laneMedian.toFixed(3)}ms vs ${sample.baseline} ${sample.baselineMedian.toFixed(3)}ms (${((sample.ratio - 1) * 100).toFixed(1)}%)`,
    );
    (results[lane] ??= []).push(sample);
  }
const summary = {};
for (const [lane, samples] of Object.entries(results)) {
  const ratios = samples.map((sample) => sample.ratio);
  summary[lane] = {
    baseline: BASELINES[lane],
    medianRatio: middle(ratios),
    minRatio: Math.min(...ratios),
    maxRatio: Math.max(...ratios),
    laneMs: middle(samples.map((sample) => sample.laneMedian)),
    baselineMs: middle(samples.map((sample) => sample.baselineMedian)),
  };
  const row = summary[lane];
  console.log(
    `[perf] ${lane} vs ${row.baseline}: ${((row.medianRatio - 1) * 100).toFixed(1)}% ` +
      `[${((row.minRatio - 1) * 100).toFixed(1)}%, ${((row.maxRatio - 1) * 100).toFixed(1)}%] ` +
      `${row.laneMs.toFixed(3)}ms vs ${row.baselineMs.toFixed(3)}ms`,
  );
}
console.log(`[perf] summary ${JSON.stringify({ grid, frames, size: `${perfWidth}x${perfHeight}`, rounds, lanes: summary })}`);
