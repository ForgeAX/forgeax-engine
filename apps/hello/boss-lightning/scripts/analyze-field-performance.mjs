import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { distribution, gpuIntervals } from './field-oracle.mjs';

// Offline only. This consumes all frozen runs; it never executes a GPU gate.
const manifestPath = resolve(process.argv[2]);
const outputPath = resolve(process.argv[3]);
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const report = { verdict: 'incomplete', manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  budgets: { fullFrameCpuP95Ms: 33.34, oracleFrames: 90, warmup: 30, samples: 60 }, runs: [], capacities: [] };
const retained = [];
const read = path => JSON.parse(readFileSync(path, 'utf8'));
try {
  assert.equal(manifest.runs.length, 36, 'all 3 capacities x 3 ABBA rounds x 4 runs');
  const identities = new Set();
  for (const run of manifest.runs) {
    assert([10000, 100000, 1000000].includes(run.capacity));
    assert([0, 1, 2].includes(run.round));
    assert([0, 1, 2, 3].includes(run.order));
    const identity = `${run.capacity}/${run.round}/${run.order}`;
    assert(!identities.has(identity), `duplicate ${identity}`); identities.add(identity);
    const enabled = run.order === 1 || run.order === 2;
    const key = `benchmark/${run.capacity}/${enabled ? 'on' : 'off'}`;
    const directory = resolve(dirname(manifestPath), run.directory);
    const commandResult = read(resolve(directory, 'process-result.json'));
    assert.equal(commandResult.status, 0); assert.equal(commandResult.timedOut, false);
    assert.equal(commandResult.cancelled, null); assert.notEqual(commandResult.cleanup.kind, 'failed');
    const admission = read(resolve(directory, 'admission.json'));
    assert.equal(admission.verdict, 'admitted'); assert.equal(admission.key, key);
    assert(admission.durationSeconds >= 60); assert(admission.samples.length >= 60);
    assert(admission.samples.every(s => s.cpuPercent <= 20 && s.load1 <= 3 && s.memoryPressure === 'normal'));
    assert(admission.samples.every((s, index) => s.swapBytes <= (index === 0 ? admission.initialSwapBytes : admission.samples[index - 1].swapBytes)));
    const resultBytes = readFileSync(resolve(directory, 'benchmark.json'));
    const result = JSON.parse(resultBytes);
    assert.equal(result.key, key); assert.equal(result.software, false);
    assert.equal(result.completedFrames, 90); assert.equal(result.samples.length, 90);
    assert.equal(result.activeParticles, run.capacity); assert.equal(result.indirectParticles, run.capacity);
    assert(result.pixels.visiblePixels > 0); assert.equal(result.pixels.width, 512); assert.equal(result.pixels.height, 512);
    assert(result.frames.every((frame, index) => frame.frame === index && frame.rendererSubmissions === 1));
    assert.equal(result.steadyFieldUpload.calls, 0); assert.equal(result.steadyFieldUpload.bytes, 0);
    const emitters = run.capacity === 1000000 ? 16 : 4;
    assert(result.resources.fieldHigh <= emitters * 16 * 1024 * 1024);
    assert(result.resources.fieldBuffers.every(buffer => buffer.size <= 16 * 1024 * 1024));
    assert.equal(result.resources.fieldUploads, enabled ? emitters : 0);
    const retired = read(resolve(directory, 'resources-retired.json'));
    assert.equal(retired.fieldLiveAfterDispose, 0);
    const epoch = { ...result.source, shaderManifestSha256: result.shaderManifestSha256 };
    if (report.epoch === undefined) report.epoch = epoch;
    else assert.deepEqual(epoch, report.epoch, 'one exact source/shader epoch for all ABBA runs');
    assert.equal(admission.head, result.source.head);
    const samples = result.samples.slice(30);
    assert.equal(samples.length, 60);
    assert(samples.every(s => Number.isFinite(s.cpu.frameMs) && s.timing?.status === 'complete' && s.intervals?.spans.length > 0));
    const cpu = Object.fromEntries(Object.keys(samples[0].cpu).map(name => [name, distribution(samples.map(s => s.cpu[name]))]));
    const gpu = Object.fromEntries(['sumMs', 'unionMs', 'overlapMs', 'envelopeMs'].map(name => [name, distribution(samples.map(s => s.intervals[name]))]));
    const phases = {};
    for (const phase of ['simulate', 'project', 'raster']) {
      const intervals = samples.map(sample => {
        const frame = sample.timing.frame;
        const passes = frame.passes.filter(pass => pass.status === 'measured' && pass.passName.endsWith(`.${phase}`));
        assert(passes.length > 0, `missing actual ${phase} timestamp work`);
        return gpuIntervals({ ...frame, passes });
      });
      phases[phase] = Object.fromEntries(['sumMs', 'unionMs', 'overlapMs', 'envelopeMs'].map(name => [name, distribution(intervals.map(i => i[name]))]));
    }
    const row = { identity, key, directory, capacity: run.capacity, round: run.round, order: run.order, enabled,
      resultSha256: createHash('sha256').update(resultBytes).digest('hex'), cpu, gpu, phases, cold: result.cold,
      resources: result.resources, retired, adapter: result.adapter, nativeOuter: result.nativeOuter,
      budgetPassed: cpu.frameMs.p95 <= 33.34, source: result.source };
    report.runs.push(row); retained.push({ row, samples });
  }
  for (const capacity of [10000, 100000, 1000000]) {
    const variants = {};
    for (const enabled of [false, true]) {
      const runs = retained.filter(r => r.row.capacity === capacity && r.row.enabled === enabled);
      assert.equal(runs.length, 6);
      const samples = runs.flatMap(r => r.samples); assert.equal(samples.length, 360);
      variants[enabled ? 'on' : 'off'] = {
        sampleCount: samples.length,
        cpuFrameMs: distribution(samples.map(s => s.cpu.frameMs)),
        gpu: Object.fromEntries(['sumMs', 'unionMs', 'overlapMs', 'envelopeMs'].map(name => [name, distribution(samples.map(s => s.intervals[name]))])),
      };
    }
    report.capacities.push({ capacity, ...variants,
      fieldIncrementCpuMs: Object.fromEntries(['p50', 'p95'].map(name => [name, variants.on.cpuFrameMs[name] - variants.off.cpuFrameMs[name]])),
      fieldIncrementGpuMs: Object.fromEntries(['sumMs', 'unionMs', 'overlapMs', 'envelopeMs'].map(metric => [metric,
        Object.fromEntries(['p50', 'p95'].map(name => [name, variants.on.gpu[metric][name] - variants.off.gpu[metric][name]]))])),
      interpretation: 'differences of retained distributions; not paired-frame estimates or native outer timing' });
  }
  report.verdict = report.runs.every(run => run.budgetPassed) ? 'pass' : 'fail';
  assert.equal(report.verdict, 'pass', 'every admitted run retains the frozen full-frame p95 budget');
} catch (error) {
  report.verdict = report.verdict === 'fail' ? 'fail' : 'incomplete';
  report.failure = String(error); process.exitCode = 1;
} finally {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}
