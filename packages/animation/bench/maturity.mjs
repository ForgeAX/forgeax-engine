// Uninstrumented ABBA CPU timings; heap-sampling is a separate diagnostic pass.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus } from 'node:os';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { ChildOf, scenePlugin, Transform } from '@forgeax/engine-scene';
import * as current from '../dist/index.mjs';

const baseline = process.env.ANIMATION_BASELINE
  ? await import(pathToFileURL(resolve(process.env.ANIMATION_BASELINE)).href) : current;
const out = resolve(process.env.ANIMATION_EVIDENCE ?? 'artifacts/animation-maturity');
mkdirSync(out, { recursive: true });
const report = { environment: { cpu: cpus()[0]?.model, node: process.version, platform: process.platform,
  backend: 'CPU only; no renderer', heapSamplingIntervalBytes: 32768 },
  conditions: { warmup: 60, samples: 120, order: 'ABBA', timing: 'process.cpuUsage and performance.now; current pose read, solve and World writes; excludes Scene propagation and compilation',
    budget: 'unconstrained current/baseline p95 <= 1.25 for >=0.1ms workloads; numerical residual must not worsen by >1e-4; report a failed or unstable window explicitly',
    heap: 'sampled allocation estimate is a separate diagnostic, not exact allocation bytes; heapUsed is V8 heap occupancy' }, results: [] };
const gc = [];
const observer = new PerformanceObserver((list) => gc.push(...list.getEntries().map((e) => ({ start: e.startTime, ms: e.duration }))));
observer.observe({ entryTypes: ['gc'] });
function chain(world, count, length) {
  const joints = [];
  for (let i = 0; i < count; i++) joints.push(world.spawn(
    { component: Transform, data: { pos: [i === 0 ? 0 : length, 0, 0] } },
    ...(i === 0 ? [] : [{ component: ChildOf, data: { parent: joints[i - 1] } }]),
  ).unwrap());
  return joints;
}
async function workload(api, kind, count, bones, limits) {
  const world = new World();
  const context = await createWorldContext(world, [scenePlugin()]);
  const rigs = [];
  for (let i = 0; i < count; i++) {
    const source = chain(world, bones, 1 / (bones - 1));
    if (kind === 'IK') rigs.push({ source, solver: api.createIKSolver(world, {
      joints: source, maxIterations: 32, tolerance: 1e-3,
      ...(limits ? { limits: source.slice(0, -1).map((joint) => ({ joint, min: [0, 0, -Math.PI], max: [0, 0, Math.PI] })) } : {}),
    }).unwrap() });
    else {
      const target = chain(world, bones, 1.7 / (bones - 1));
      rigs.push({ source, solver: api.createSkeletonRetargeter(world, {
        pairs: source.map((joint, index) => ({ source: joint, target: target[index] })), rootTranslationScale: 1.7,
      }).unwrap() });
    }
  }
  const goal = [0.65, 0.4, 0];
  const rotation = [0, 0, 0, 1];
  return { async dispose() { await context.fiber.dispose(); }, tick(frame) {
    let residual = 0;
    let iterations = 0;
    goal[1] = 0.25 + Math.sin(frame / 17) * 0.12;
    const angle = Math.sin(frame / 31) * 0.5;
    rotation[2] = Math.sin(angle / 2); rotation[3] = Math.cos(angle / 2);
    for (const rig of rigs) {
      if (kind === 'IK') {
        const solved = rig.solver.solve(goal).unwrap();
        assert(Number.isFinite(solved.error) && solved.iterations <= 32);
        residual = Math.max(residual, solved.error); iterations = Math.max(iterations, solved.iterations);
      } else {
        // Move all source joints, including twist: stale-pose shortcuts cannot satisfy this workload.
        for (const joint of rig.source) world.set(joint, Transform, { quat: rotation }).unwrap();
        rig.solver.retarget().unwrap();
      }
    }
    return { residual, iterations };
  }, drain() { world.update(0).unwrap(); } };
}
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.floor((values.length - 1) * p)];
for (const [kind, count, bones, limits] of [
  ['IK',100,3,false], ['IK',100,16,false], ['IK',10,64,false], ['IK',1,256,false],
  ['IK',100,3,true], ['IK',10,64,true], ['Retarget',100,3,false], ['Retarget',100,64,false], ['Retarget',10,256,false],
]) {
  const row = { kind, count, bones, limits, blocks: [] };
  for (const mode of ['A','B','B','A']) {
    const test = await workload(mode === 'A' ? baseline : current, kind, count, bones, limits);
    for (let i=0; i<60; i++) { test.tick(i); test.drain(); }
    global.gc?.();
    const started = performance.now();
    const raw = [];
    for (let i=0; i<120; i++) {
      const start = performance.now();
      const cpuStart = process.cpuUsage();
      const result = test.tick(i+60);
      const usage = process.cpuUsage(cpuStart);
      const wallMs = performance.now() - start;
      const cpuMs = (usage.user + usage.system) / 1000;
      raw.push({ frame: i+60, cpuMs, wallMs, ...result, heapBytes: process.memoryUsage().heapUsed });
      test.drain();
    }
    await new Promise(setImmediate);
    row.blocks.push({ mode, p50Ms: percentile(raw.map((r)=>r.cpuMs),0.5), p95Ms: percentile(raw.map((r)=>r.cpuMs),0.95),
      gc: gc.filter((e)=>e.start>=started), peakHeapBytes: Math.max(...raw.map((r)=>r.heapBytes)), raw });
    await test.dispose();
  }
  const byMode = (mode) => row.blocks.filter((b)=>b.mode===mode).flatMap((b)=>b.raw.map((r)=>r.cpuMs));
  row.p95Ratio = percentile(byMode('B'),0.95)/percentile(byMode('A'),0.95);
  const test = await workload(current,kind,count,bones,limits);
  const inspector = new Session(); inspector.connect();
  await inspector.post('HeapProfiler.startSampling',{samplingInterval:32768, includeObjectsCollectedByMajorGC:true, includeObjectsCollectedByMinorGC:true});
  for (let i=0;i<60;i++) { test.tick(i+60); test.drain(); }
  const { profile } = await inspector.post('HeapProfiler.stopSampling');
  writeFileSync(resolve(out, `allocation-${kind}-${count}-${bones}-${limits}.json`), JSON.stringify(profile));
  inspector.disconnect();
  const sum = (node) => node.selfSize + node.children.reduce((n,c)=>n+sum(c),0);
  row.sampledAllocationBytesPerTick = sum(profile.head)/60;
  await test.dispose();
  report.results.push(row);
  writeFileSync(resolve(out,'cpu-abba.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({kind,count,bones,limits,p95Ratio:row.p95Ratio,
    blocks:row.blocks.map(({mode,p50Ms,p95Ms})=>({mode,p50Ms,p95Ms})), sampledAllocationBytesPerTick:row.sampledAllocationBytesPerTick }));
}
observer.disconnect();
