import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeCpuProfile } from '../analyze_cpu_profile.mjs';
import { compareSamples } from '../compare_samples.mjs';
import { emitJson, pointer, statistics } from '../lib.mjs';
import { measuredIntervals, summarizeGpuTiming } from '../summarize_gpu_timing.mjs';

const callFrame = (functionName) => ({
  functionName,
  url: 'file:///fixture.mjs',
  lineNumber: 0,
  columnNumber: 0,
});
function cpu() {
  return {
    startTime: 0,
    endTime: 1100,
    nodes: [
      { id: 1, callFrame: callFrame('(root)'), children: [2] },
      { id: 2, callFrame: callFrame('recursive'), children: [3] },
      { id: 3, callFrame: callFrame('recursive'), children: [4] },
      { id: 4, callFrame: callFrame('(garbage collector)') },
    ],
    samples: [3, 4],
    timeDeltas: [600, 400],
  };
}
const options = {
  samplesPointer: '/samples',
  identityPointer: '/workload',
  unit: 'ms',
  direction: 'lower',
};
const baseline = () => ({
  workload: { resolution: [1920, 1080], shadow: { cascades: 3, size: 1024, filter: 'pcf5' } },
  samples: [10, 20, 30, 40],
});

function gpu(frameId = 1) {
  const base = 9007199254740993n;
  const passes = [
    [0, 6],
    [3, 9],
    [12, 13],
  ].map(([start, end], executionIndex) => ({
    passName: executionIndex === 2 ? 'copy' : 'main',
    passKind: executionIndex === 2 ? 'copy' : 'raster',
    executionIndex,
    status: 'measured',
    measurementSource: executionIndex === 2 ? 'copy-boundary-envelope' : 'pass-boundary',
    beginningTick: String(base + BigInt(start * 1e6)),
    endTick: String(base + BigInt(end * 1e6)),
    durationNanoseconds: (end - start) * 1e6,
  }));
  return {
    schemaVersion: '1.0',
    frameId,
    deviceGeneration: 1,
    graphGeneration: 1,
    backendKind: 'webgpu',
    timestampPeriodNanoseconds: 1,
    passCapacity: 8,
    executedPassCount: 3,
    measuredPassCount: 3,
    droppedPassCount: 0,
    measuredPassNanoseconds: 13e6,
    passes,
  };
}

test('CPU attribution deduplicates recursive inclusive symbols and retains GC and unobserved time', () => {
  const report = analyzeCpuProfile(cpu());
  const recursive = report.topSelf.find((row) => row.functionName === 'recursive');
  assert.equal(recursive.selfMs, 0.6);
  assert.equal(recursive.inclusiveMs, 1);
  assert.equal(
    report.topSelf.find((row) => row.functionName === '(garbage collector)').selfMs,
    0.4,
  );
  assert.equal(report.unobservedMs, 0.1);
  assert.equal(report.topInclusive[0].inclusiveMs, 1);
});

test('CPU profile failures remain failures', () => {
  for (const change of [
    (p) => p.samples.push(999),
    (p) => (p.samples[0] = 999),
    (p) => (p.timeDeltas[0] = -1),
    (p) => (p.timeDeltas[0] = Infinity),
    (p) => (p.endTime = 1),
    (p) => (p.nodes[3].children = [1]),
    (p) => p.nodes[0].children.push(3),
  ]) {
    const profile = cpu();
    change(profile);
    assert.throws(() => analyzeCpuProfile(profile));
  }
});

test('nearest-rank statistics retain zeros and reject invalid samples', () => {
  assert.equal(statistics([0, 2, 4, 6]).p50, 2);
  assert.equal(statistics([0, 2, 4, 6]).p95, 6);
  assert.equal(statistics([0, 2, 4, 6]).mean, 3);
  assert.equal(statistics([1, 1]).populationStddev, 0);
  for (const input of [[], [null], ['1'], [-1], [NaN], [Infinity]])
    assert.throws(() => statistics(input));
});

test('JSON Pointer resolves escaped properties and rejects missing or inherited fields', () => {
  assert.equal(pointer({ 'a/b': { '~': [4] } }, '/a~1b/~0/0'), 4);
  for (const path of ['a', '/absent', '/a~2', '/toString']) assert.throws(() => pointer({}, path));
});

test('sample comparison checks nested quality identity and respects metric direction', () => {
  const candidate = baseline();
  candidate.samples = [5, 10, 15, 20];
  assert.equal(compareSamples(baseline(), candidate, options).meanImprovementPercent, 50);
  assert.equal(
    compareSamples(baseline(), candidate, { ...options, direction: 'higher' })
      .meanImprovementPercent,
    -50,
  );
  candidate.workload.shadow.size = 2048;
  const report = compareSamples(baseline(), candidate, options);
  assert.equal(report.comparable, false);
  assert.deepEqual(report.identityDifferences, ['/shadow/size']);
  assert.equal(report.changePercent, null);
  assert.equal(report.meanImprovementPercent, null);
});

test('sample comparison accepts identity key reordering but refuses missing identity and undefined ratios', () => {
  const a = baseline();
  const b = baseline();
  b.workload = { shadow: b.workload.shadow, resolution: b.workload.resolution };
  assert.equal(compareSamples(a, b, options).comparable, true);
  a.samples = [0];
  assert.equal(compareSamples(a, b, options).meanImprovementPercent, null);
  for (const bad of [{}, { workload: {} }, { workload: null }])
    assert.throws(() => compareSamples(bad, b, options));
});

test('GPU interval math preserves large raw ticks, overlaps, gaps, and execution identity', () => {
  const fact = measuredIntervals(gpu());
  assert.equal(fact.repeatedCoverageMs, 13);
  assert.equal(fact.intervalUnionMs, 10);
  assert.equal(fact.timestampEnvelopeMs, 13);
  const report = summarizeGpuTiming([{ status: 'complete', frame: gpu() }]);
  assert.equal(report.passes.filter((row) => row.passName === 'main').length, 1);
  const main = report.passes.find((row) => row.passName === 'main');
  assert.deepEqual(main.executionIndices, [0, 1]);
  assert.equal(main.durationMs.mean, 12);
  assert.equal(main.durationPerExecutionMs.count, 2);
  assert.equal(
    report.passes.find((row) => row.passName === 'copy').measurementSource,
    'copy-boundary-envelope',
  );
});

test('GPU observations deduplicate identical frames, retain partials, and separate contexts and generations', () => {
  const complete = { status: 'complete', frame: gpu() };
  const next = gpu(2);
  next.graphGeneration = 2;
  next.deviceGeneration = 2;
  const report = summarizeGpuTiming([
    complete,
    complete,
    { status: 'partial', frame: gpu(3) },
    { status: 'failed', error: {} },
    { status: 'unavailable', reason: {} },
    { status: 'complete', frame: next },
  ]);
  assert.deepEqual(report.counts, {
    rows: 6,
    duplicateRows: 1,
    completeFrames: 2,
    partialFrames: 1,
    failed: 1,
    unavailable: 1,
    equalTickPasses: 0,
  });
  assert.equal(report.groups.length, 2);
  assert.equal(report.passes[0].durationMs.count, 1);
  const multi = summarizeGpuTiming(
    [
      { context: 'a', observation: complete },
      { context: 'b', observation: complete },
    ],
    { contextPointer: '/context', observationPointer: '/observation' },
  );
  assert.equal(multi.counts.completeFrames, 2);
  assert.equal(multi.groups.length, 2);
});

test('GPU absent passes are not free work and zero ticks remain quantized observations', () => {
  const frame = gpu(2);
  frame.passes = frame.passes.slice(0, 1);
  frame.executedPassCount = 1;
  frame.measuredPassCount = 1;
  frame.measuredPassNanoseconds = 0;
  frame.passes[0].endTick = frame.passes[0].beginningTick;
  frame.passes[0].durationNanoseconds = 0;
  const report = summarizeGpuTiming([
    { status: 'complete', frame: gpu() },
    { status: 'complete', frame },
  ]);
  assert.equal(report.counts.equalTickPasses, 1);
  assert.equal(report.passes.find((row) => row.passName === 'copy').absentCompleteFrames, 1);
  assert.equal(report.passes.find((row) => row.passName === 'copy').durationMs.count, 1);
});

test('GPU malformed timestamps and conflicting frames are rejected', () => {
  for (const change of [
    (f) => (f.passes[0].beginningTick = '1.5'),
    (f) => (f.passes[0].endTick = '0'),
    (f) => f.passes[0].durationNanoseconds++,
    (f) => f.measuredPassCount++,
    (f) => (f.passes[1].executionIndex = 0),
  ]) {
    const frame = gpu();
    change(frame);
    assert.throws(() => measuredIntervals(frame));
  }
  const changed = gpu();
  changed.graphGeneration++;
  assert.throws(() =>
    summarizeGpuTiming([
      { status: 'complete', frame: gpu() },
      { status: 'complete', frame: changed },
    ]),
  );
});

test('CLI emits a refusal on quality mismatch and never overwrites a raw input or input symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-performance-tools-'));
  try {
    const a = join(directory, 'baseline.json');
    const b = join(directory, 'candidate.json');
    const candidate = baseline();
    candidate.workload.shadow.filter = 'pcfVogel';
    await writeFile(a, JSON.stringify(baseline()));
    await writeFile(b, JSON.stringify(candidate));
    const script = fileURLToPath(new URL('../compare_samples.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      [script, a, b, '--identity-pointer', '/workload', '--unit', 'ms'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).comparable, false);
    const raw = await readFile(a, 'utf8');
    await assert.rejects(emitJson({}, a, [a]));
    const alias = join(directory, 'alias.json');
    await symlink(a, alias);
    await assert.rejects(emitJson({}, alias, [a]));
    const hardlink = join(directory, 'hardlink.json');
    await link(a, hardlink);
    await assert.rejects(emitJson({}, hardlink, [a]));
    assert.equal(await readFile(a, 'utf8'), raw);
  } finally {
    await rm(directory, { recursive: true });
  }
});
