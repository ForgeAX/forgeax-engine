import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { Transform } from '@forgeax/engine-scene';
import { createNavigationGrid, NavigationAgent, NavigationAgentStatus, navigationPlugin, setNavigationPath } from '../dist/index.mjs';

const output = new URL('../../../artifacts/g03-navigation/', import.meta.url);
mkdirSync(output, { recursive: true });
const samples = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.floor(sorted.length * 0.95)], maxMs: sorted.at(-1) };
};
const report = {
  generatedAt: new Date().toISOString(), node: process.version, platform: `${platform()}-${arch()}`, cpu: cpus()[0]?.model,
  productHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHash: createHash('sha256').update(['graph', 'grid', 'agent'].map((name) => readFileSync(new URL(`../src/${name}.ts`, import.meta.url))).join('\n')).digest('hex'),
  runtimeModules: Object.fromEntries([
    ['navigation', new URL(import.meta.resolve('../dist/index.mjs'))],
    ...['ecs', 'scene', 'types', 'plugin'].map((name) => [name, new URL(import.meta.resolve(`@forgeax/engine-${name}`))]),
  ].map(([name, url]) => [name, { url: url.href, sha256: createHash('sha256').update(readFileSync(url)).digest('hex') }])),
  cases: [],
};
const failures = [];
for (const scenario of ['open-256', 'maze-128', 'weighted-open-256']) {
  const width = scenario === 'maze-128' ? 128 : 256;
  const blocked = new Uint8Array(width * width);
  if (scenario === 'maze-128') {
    for (let x = 8; x < width - 1; x += 8) {
      const gap = (x / 8) % 2 === 0 ? 2 : width - 3;
      for (let y = 0; y < width; y++) if (Math.abs(y - gap) > 1) blocked[y * width + x] = 1;
    }
  }
  const constructionStart = performance.now();
  const weights = scenario === 'weighted-open-256' ? new Float32Array(width * width).fill(1000) : undefined;
  const graph = createNavigationGrid({ width, height: width, blocked, weights }).unwrap();
  const constructionMs = performance.now() - constructionStart;
  for (let i = 0; i < 20; i++) graph.findPath(0, width * width - 1).unwrap();
  const timings = []; const visits = []; let cost = 0;
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const result = graph.findPath(0, width * width - 1).unwrap();
    timings.push(performance.now() - start); visits.push(result.visited); cost = result.cost;
    assert.equal(result.nodes.at(-1), width * width - 1);
    if (scenario === 'weighted-open-256') { assert.equal(result.cost, 510000); assert.ok(result.visited <= 1024); }
    for (const id of result.nodes) assert.equal(blocked[id], 0);
  }
  const measured = samples(timings);
  report.cases.push({ scenario, nodeCount: graph.nodeCount, edgeCount: graph.edgeCount, warmup: 20, queries: 100, constructionMs, ...measured, samplesMs: timings, maxVisited: Math.max(...visits), cost, budgets: { constructionMs: 1000, p95Ms: 50 } });
  if (constructionMs > 1000 || measured.p95Ms > 50) failures.push(scenario);
}
const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxDeltaSeconds: 1 / 30, maxStepsPerUpdate: 1 } });
const ctx = await createWorldContext(world, [navigationPlugin()]);
try {
  const entities = [];
  for (let i = 0; i < 1000; i++) {
    const entity = world.spawn({ component: NavigationAgent, data: { speed: 1 } }).unwrap();
    setNavigationPath(world, entity, [0, 0, 0, 0, 0, 10, 10, 0, 10]).unwrap(); entities.push(entity);
  }
  for (let i = 0; i < 30; i++) world.update(1 / 60).unwrap();
  const timings = []; const cpuTimings = [];
  for (let i = 0; i < 300; i++) { const start = performance.now(); const cpuStart = process.cpuUsage(); world.update(1 / 60).unwrap(); timings.push(performance.now() - start); const cpuEnd = process.cpuUsage(cpuStart); cpuTimings.push((cpuEnd.user + cpuEnd.system) / 1000); }
  const measured = samples(timings);
  const position = world.get(entities[0], Transform).unwrap().pos;
  for (const entity of entities) {
    const actual = world.get(entity, Transform).unwrap().pos;
    assert.ok(actual[0] === 0 && actual[1] === 0 && Math.abs(actual[2] - 5.5) < 0.001);
    assert.equal(world.get(entity, NavigationAgent).unwrap().status, NavigationAgentStatus.following);
  }
  report.cases.push({ scenario: '1000-agents-full-world', agents: 1000, validatedAgents: entities.length, warmup: 30, frames: 300, ...measured, samplesMs: timings, processCpu: { ...samples(cpuTimings), samplesMs: cpuTimings }, position: [...position], budgets: { p95Ms: 1000 / 60 } });
  if (measured.p95Ms > 1000 / 60) failures.push('1000-agents-full-world');
} finally { await ctx.fiber.dispose(); }

// Keep the actual World trajectory as effect evidence, including arrival state.
const effectWorld = new World();
const effectCtx = await createWorldContext(effectWorld, [navigationPlugin()]);
try {
  const blocked = new Uint8Array(25); for (const id of [2, 7, 12, 17]) blocked[id] = 1;
  const path = createNavigationGrid({ width: 5, height: 5, blocked }).unwrap().findPath(0, 4).unwrap();
  const entity = effectWorld.spawn({ component: NavigationAgent, data: { speed: 3 } }).unwrap();
  setNavigationPath(effectWorld, entity, path.points).unwrap();
  const trajectory = [];
  for (let frame = 0; frame < 300; frame++) {
    effectWorld.update(1 / 60).unwrap(); const p = effectWorld.get(entity, Transform).unwrap().pos;
    trajectory.push([p[0], p[2]]); assert.equal(blocked[Math.round(p[2]) * 5 + Math.round(p[0])], 0);
  }
  assert.equal(effectWorld.get(entity, NavigationAgent).unwrap().status, NavigationAgentStatus.arrived);
  report.effect = { frames: 300, fixedDeltaSeconds: 1 / 60, width: 5, height: 5, blocked: [...blocked], path: [...path.points], trajectory, finalPosition: [...effectWorld.get(entity, Transform).unwrap().pos], arrived: true };
} finally { await effectCtx.fiber.dispose(); }
report.failures = failures;
writeFileSync(process.env.FORGEAX_NAVIGATION_BENCH_OUTPUT ?? new URL('benchmark.json', output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, cases: report.cases.map(({ samplesMs, processCpu, ...item }) => ({ ...item, samplesMs: `${samplesMs.length} samples`, ...(processCpu === undefined ? {} : { processCpu: { ...processCpu, samplesMs: `${processCpu.samplesMs.length} samples` } }) })), effect: { ...report.effect, trajectory: `${report.effect.trajectory.length} samples` } }, null, 2));
assert.deepEqual(failures, [], 'Navigation performance budgets failed; retain measurements.');
