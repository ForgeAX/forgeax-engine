import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { quat } from '@forgeax/engine-math';
import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine-render';
import { summarizeGpuPassTimingIntervals } from '@forgeax/engine-render/internal';
import { Transform } from '@forgeax/engine-scene';
import { Terrain } from '@forgeax/engine-terrain';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { terrainHarness } from './harness.mjs';
const startupBegin = performance.now();
const renderPath = process.env.TERRAIN_PERF_RENDER_PATH ?? 'forward';
assert(['forward', 'deferred'].includes(renderPath), 'performance render path must be explicit');
const h = await terrainHarness({ width: 960, height: 540, backendArgs: ['backend=metal'], appOptions: { standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath } } });
const startupMs = performance.now() - startupBegin;
const dir = resolve(import.meta.dirname, process.env.TERRAIN_PERF_ARTIFACT_DIR ?? '../.forgeax-debug/performance-final');
mkdirSync(dir, { recursive: true });
const percentile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)];
const stats = (xs) => ({
  median: percentile(xs, 0.5),
  p95: percentile(xs, 0.95),
  peak: Math.max(...xs),
  samples: xs,
});
const report = {
  schemaVersion: 2,
  resolution: [960, 540],
  renderPath,
  receiverGeometryBytesPerView: renderPath === 'deferred' ? 960 * 540 * 4 : 0,
  warmupFrames: 60,
  measuredFrames: 60,
  shadowMapSize: 1024,
  adapter: h.shim.adapterInfo,
  backend: h.shim.requestedBackend,
  startupMs,
  startupBoundary: 'Native device/App initialization, serialized production Pack fetch/decode, closure adoption and scene assembly. First GPU submission is measured separately.',
  nativeOuterGpuTiming: { status: 'unavailable', reason: 'No native outer timestamp interval is exposed by this owner.' },
  timingContract:
    'GPU pass sum repeats interval coverage; measured envelope is not a queue-wide frame interval. CPU frame-to-completion includes actual queue wait and observer overhead, with no subtraction.',
  budgets: { gpuIntervalUnionP95Ms: 16.67, cpuDrawP95Ms: 8, frameToCompletedP95Ms: 33.34 },
  budgetRationale: 'Foundation carrier at 960x540: GPU interval coverage within one 60Hz interval, CPU recording within half the interval, observed frame completion within two intervals. These thresholds are declared before the isolated measurement.',
  cases: [],
};
try {
  h.app.world.set(h.subjects.terrain, Terrain, { lod0Diameter: 1.2 }).unwrap();
  for (const moving of [false, true])
    for (const forcedLod of [0, -1, 2, 0]) {
      const eye = (i) => {
        const pos = moving
          ? [65 + 20 * Math.sin(i * 0.05), 55, 145 + 15 * Math.cos(i * 0.05)]
          : [65, 55, 145];
        h.app.world
          .set(h.subjects.camera, Transform, {
            pos,
            quat: quat.fromLookAt(quat.create(), pos, [62, 0, 56], [0, 1, 0]),
          })
          .unwrap();
      };
      h.app.world.set(h.subjects.terrain, Terrain, { forcedLod }).unwrap();
      for (let i = 0; i < 60; i++) {
        eye(i);
        await h.frame();
      }
      const cpu = [],
        update = [],
        latency = [],
        frameLatency = [],
        gpu = [],
        gpuUnion = [],
        gpuOverlap = [],
        gpuEnvelope = [],
        rawTimings = [];
      const drawDiagnostics = [], completionDiagnostics = [];
      let receipt;
      for (let i = 0; i < 60; i++) {
        eye(i);
        const frame = await h.frame();
        receipt = frame.receipt;
        cpu.push(frame.cpuMs);
        if (frame.drawDiagnostics !== undefined) drawDiagnostics.push(frame.drawDiagnostics);
        if (frame.completionDiagnostics !== undefined) completionDiagnostics.push(frame.completionDiagnostics);
        update.push(frame.updateMs);
        latency.push(frame.drawToCompletedMs);
        frameLatency.push(frame.frameToCompletedMs);
        const observed = (await h.app.renderer.observe(receipt, { include: ['timings'] })).unwrap()
          .timings;
        assert.equal(
          observed.status,
          'complete',
          'actual GPU timestamps are mandatory on this fixed Metal device',
        );
        const timing = observed.frame;
        assert.equal(timing.frameId, receipt.frameId, 'GPU timing must belong to the actual measured receipt');
        assert.equal(timing.droppedPassCount, 0);
        assert.equal(timing.measuredPassCount, timing.executedPassCount);
        rawTimings.push(timing);
        const coverage = summarizeGpuPassTimingIntervals(timing.passes, timing.timestampPeriodNanoseconds).unwrap();
        gpu.push(coverage.sumNanoseconds / 1e6);
        gpuUnion.push(coverage.unionNanoseconds / 1e6);
        gpuOverlap.push(coverage.overlapNanoseconds / 1e6);
        const intervals = timing.passes.filter((p) => p.status === 'measured');
        assert(intervals.length > 0, 'a complete timing result must contain measured intervals');
        const first = intervals.reduce(
            (v, p) => (BigInt(p.beginningTick) < v ? BigInt(p.beginningTick) : v),
            BigInt(intervals[0].beginningTick),
          ),
          last = intervals.reduce((v, p) => (BigInt(p.endTick) > v ? BigInt(p.endTick) : v), 0n);
        gpuEnvelope.push((Number(last - first) * timing.timestampPeriodNanoseconds) / 1e6);
      }
      const pixels = await h.verify(receipt),
        bytes = await h.pixels();
      const name = `${moving ? 'moving' : 'static'}-${forcedLod < 0 ? 'auto' : `lod${forcedLod}`}-${report.cases.length}`;
      writeFileSync(resolve(dir, `${name}.png`), writeReferencePng(bytes, 960, 540));
      report.cases.push({
        name,
        moving,
        forcedLod,
        cpuDrawMs: stats(cpu),
        ...(drawDiagnostics.length === 0 ? {} : { drawDiagnostics }),
        ...(completionDiagnostics.length === 0 ? {} : { completionDiagnostics, receiptCompletionMs: stats(completionDiagnostics.map((d) => d.receiptCompletedMs - d.frameStartMs)), extraQueueDrainMs: stats(completionDiagnostics.map((d) => d.queueDrainedMs - d.receiptCompletedMs)) }),
        cpuWorldUpdateMs: stats(update),
        drawToCompletedMs: stats(latency),
        frameToCompletedMs: stats(frameLatency),
        gpuPassSumMs: stats(gpu),
        gpuIntervalUnionMs: stats(gpuUnion),
        gpuDuplicatedOverlapMs: stats(gpuOverlap),
        gpuMeasuredEnvelopeMs: stats(gpuEnvelope),
        rawTimings,
        inspection: h.app.renderer.inspect(),
        pixels,
      });
    }
  report.failures = report.cases.flatMap((entry) => [
    ...(entry.gpuIntervalUnionMs.p95 > report.budgets.gpuIntervalUnionP95Ms ? [`${entry.name}: GPU interval union p95`] : []),
    ...(entry.cpuDrawMs.p95 > report.budgets.cpuDrawP95Ms ? [`${entry.name}: CPU recording p95`] : []),
    ...(entry.frameToCompletedMs.p95 > report.budgets.frameToCompletedP95Ms ? [`${entry.name}: frame completion p95`] : []),
  ]);
  report.status = report.failures.length === 0 ? 'PASS' : 'FAIL';
  writeFileSync(resolve(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { ...report, cases: report.cases.map(({ rawTimings, ...entry }) => entry) },
      null,
      2,
    ),
  );
  assert.deepEqual(report.failures, [], 'frozen performance budgets must pass');
} finally {
  await h.dispose();
}

// Dawn owns native polling threads; terminate only after successful evidence and awaited cleanup.
process.exit(0);
