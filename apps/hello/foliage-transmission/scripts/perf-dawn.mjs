#!/usr/bin/env node
// Paired diffuse-transmission cost probe over the same leaf grid:
//   standard - canonical layer-free Standard root (baseline)
//   off      - cooked diffuse-transmission root, factor 0 (variant overhead)
//   on       - cooked diffuse-transmission root, factor 1 (lobe cost)
// Each lane runs in its own process (fresh device and pipeline cache) and
// frame time includes GPU completion. A local diagnostic, not a CI gate.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFoliage } from './dawn-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const grid = Number.parseInt(process.env.PERF_GRID ?? '40', 10);
const frames = Number.parseInt(process.env.PERF_FRAMES ?? '120', 10);
const warmup = Math.min(20, Math.floor(frames / 4));

const LANES = {
  standard: { mode: 'no-transmission', gridMaterial: 'standard' },
  off: { mode: 'no-transmission', gridMaterial: 'diffuse-transmission' },
  on: { mode: 'transmission', gridMaterial: 'diffuse-transmission' },
};

if (process.env.PERF_CHILD_LANE !== undefined) {
  const lane = LANES[process.env.PERF_CHILD_LANE];
  const run = await runFoliage({ appRoot: resolve(here, '..'), ...lane, grid, frames, timeFrames: true });
  const samples = run.frameMs.slice(warmup).sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const median = samples[Math.floor(samples.length / 2)] ?? Number.NaN;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.NaN;
  run.dispose();
  if (run.errors.length > 0) {
    console.error(`engine errors=${run.errors.map((error) => error.code).join(',')}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ lane: process.env.PERF_CHILD_LANE, leaves: grid * grid + 3, samples: samples.length, mean, median, p95 }));
  process.exit(0);
}

const results = {};
for (const mode of ['standard', 'off', 'on', 'standard', 'off', 'on']) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, PERF_CHILD_LANE: mode },
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    console.error(child.stdout, child.stderr);
    process.exit(1);
  }
  const line = child.stdout.trim().split('\n').at(-1);
  const sample = JSON.parse(line);
  console.log(`[perf] ${mode.padEnd(8)} leaves=${sample.leaves} median=${sample.median.toFixed(3)}ms mean=${sample.mean.toFixed(3)}ms p95=${sample.p95.toFixed(3)}ms`);
  (results[mode] ??= []).push(sample.median);
}
const best = (mode) => Math.min(...results[mode]);
const baseline = best('standard');
for (const lane of ['off', 'on']) {
  const value = best(lane);
  console.log(`[perf] best-median ${lane} vs standard: ${value.toFixed(3)}ms vs ${baseline.toFixed(3)}ms delta=${(value - baseline).toFixed(3)}ms (${(((value - baseline) / baseline) * 100).toFixed(1)}%)`);
}
