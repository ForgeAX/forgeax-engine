import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeCaptureWindows,
  analyzeCpuWindow,
  intersectCpuAnchors,
} from '../analyze_cpu_windows.mjs';
import { cpuSampleTimeline } from '../cpu_timeline.mjs';
import { digest } from '../lib.mjs';

const frame = (functionName) => ({
  functionName,
  url: 'file:///fixture.mjs',
  lineNumber: 0,
  columnNumber: 0,
});
function profile() {
  return {
    startTime: 0,
    endTime: 1000,
    nodes: [
      { id: 1, callFrame: frame('(root)'), children: [2, 3] },
      { id: 2, callFrame: frame('script') },
      { id: 3, callFrame: frame('(idle)') },
    ],
    samples: [2, 2, 3],
    timeDeltas: [100, 300, 300],
  };
}
const hash = 'a'.repeat(64);
function capture() {
  const raw = {
    profiles: ['page', 'worker', 'worker'].map((type, index) => ({
      target: { targetId: `target-${index}`, type, url: `original-${index}` },
      profile: profile(),
      scriptDigests: [],
    })),
    failures: [],
  };
  const anchor = { offsetLowerMs: 0, offsetUpperMs: 0, timeOriginMs: 10000 };
  const previous = { frameId: 3, worldIdentity: 'world', deviceGeneration: 0, completedAtMs: 0.2 };
  const current = { ...previous, frameId: 4, completedAtMs: 0.6 };
  const report = {
    gameCommit: 'game',
    engineCommit: 'engine',
    cpu: { commonWindow: { startTime: 0, endTime: 1000 }, failures: [] },
    coldFirelineCpu: { anchorsBefore: [anchor], anchorsAfter: [anchor] },
    windows: {
      sampled: {
        submissionGaps: {
          worstCompletedGaps: [{ previous, current, completedGapMs: 0.4 }],
        },
      },
    },
  };
  const frames = {
    firstLiveAt: 0.1,
    end: 0.9,
    timeOrigin: 10000,
    frames: [previous, current].map((row) => ({ ...row, at: row.completedAtMs })),
  };
  const maps = {
    complete: true,
    rawSha256: hash,
    gameCommit: 'game',
    engineCommit: 'engine',
    commonWindow: report.cpu.commonWindow,
    profiles: raw.profiles.map((entry) => ({
      target: entry.target,
      scriptDigests: [],
      symbols: [{ nodeId: 2, source: { file: 'actual-owner.ts', line: 4, column: 1 } }],
    })),
  };
  return { raw, report, frames, maps };
}

test('window attribution excludes first-sample startup and tail, and clips ending intervals', () => {
  const result = analyzeCpuWindow(profile(), { startTime: 200, endTime: 600 });
  assert.equal(result.sampledMs, 0.4);
  assert.equal(result.categories.script, 0.2);
  assert.equal(result.categories['(idle)'], 0.2);
  const whole = analyzeCpuWindow(profile(), { startTime: 0, endTime: 1000 });
  assert.equal(whole.sampledMs, 0.6);
  assert.equal(whole.unsampledMs, 0.4);
  assert.equal(whole.firstSampleDelayMs, 0.1);
});

test('negative raw deltas preserve timestamp/sample pairing and expose reordered sensitivity', () => {
  const p = profile();
  p.samples = [2, 3, 2, 3];
  p.timeDeltas = [100, 200, -100, 200];
  const timeline = cpuSampleTimeline(p);
  assert.deepEqual(
    timeline.intervals.map((s) => [s.id, s.timestamp]),
    [
      [2, 100],
      [2, 200],
      [3, 300],
      [3, 400],
    ],
  );
  assert.equal(timeline.audit.negativeDeltaCount, 1);
  assert.equal(timeline.audit.reorderedSamples, 2);
  assert.equal(timeline.audit.attributionSensitive, true);
  assert.equal(analyzeCpuWindow(p, p).categories.script, 0.1);
  assert.deepEqual(p.timeDeltas, [100, 200, -100, 200]);
  p.timeDeltas = [1200, -1000, 100, 100];
  assert.throws(() => cpuSampleTimeline(p), /exceeds/);
});

test('all profile data is validated even when malformed samples lie outside selected LIVE', () => {
  const p = profile();
  p.samples[0] = 999;
  assert.throws(() => analyzeCpuWindow(p, { startTime: 500, endTime: 600 }), /Unknown/);
});

test('anchor intersection requires both sides, same page and consistent measured intervals', () => {
  const a = { offsetLowerMs: 10, offsetUpperMs: 12, timeOriginMs: 3 };
  const b = { ...a, offsetLowerMs: 11, offsetUpperMs: 14 };
  assert.equal(intersectCpuAnchors([a], [b], 3).offsetMs, 11.5);
  for (const [before, after, origin] of [
    [[], [b], 3],
    [[a], [], 3],
    [[a], [b], 4],
    [[a], [{ ...b, offsetLowerMs: 13 }], 3],
    [[{ ...a, pageNowMs: 1, chromeBeforeMs: 1, chromeAfterMs: 2 }], [b], 3],
  ])
    assert.throws(() => intersectCpuAnchors(before, after, origin));
});

test('same-capture analysis retains separate targets, raw-bound mappings and non-additive diagnostic scope', () => {
  const { raw, report, frames, maps } = capture();
  const result = analyzeCaptureWindows(raw, report, frames, maps, hash);
  assert.equal(result.comparable, false);
  assert.equal(result.ordinaryFpsAcceptance, false);
  assert.equal(result.completeness, 'complete');
  assert.equal(result.slices.length, 2);
  assert.deepEqual(
    result.slices[0].profiles.map((p) => p.target),
    raw.profiles.map((p) => p.target),
  );
  assert.equal(result.slices[0].profiles[0].topSourceSelf[0].file, 'actual-owner.ts');
  assert.equal(result.slices[1].profiles[0].sampledMs, 0.4);
  assert.equal(Object.hasOwn(result, 'totalCpuMs'), false);
});

test('rejects foreign gaps, incomplete captures, stale mappings and missing LIVE instead of analyzing startup', () => {
  for (const mutate of [
    (x) => x.frames.frames.pop(),
    (x) => x.raw.failures.push({ targetId: 'lost' }),
    (x) => (x.maps.rawSha256 = 'foreign'),
    (x) => x.maps.profiles[0].scriptDigests.push({ url: 'foreign', sha256: 'bad' }),
    (x) => (x.maps.profiles[0].symbols[0].nodeId = 999),
    (x) => (x.report.cpu.commonWindow.endTime = 999),
    (x) => (x.frames.firstLiveAt = undefined),
    (x) =>
      (x.report.windows.sampled.submissionGaps.worstCompletedGaps[0].current.deviceGeneration = 1),
  ]) {
    const x = capture();
    mutate(x);
    assert.throws(() => analyzeCaptureWindows(x.raw, x.report, x.frames, x.maps, hash));
  }
});

test('CLI replays explicit inputs, marks partial coverage, and protects every input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forgeax-cpu-window-'));
  try {
    const x = capture();
    x.frames.end = 1.2;
    const files = ['raw', 'report', 'frames'].map((name) => join(dir, `${name}.json`));
    for (const [index, name] of ['raw', 'report', 'frames'].entries())
      await writeFile(files[index], JSON.stringify(x[name]));
    const script = fileURLToPath(new URL('../analyze_cpu_windows.mjs', import.meta.url));
    const args = [script, files[0], '--report', files[1], '--frames', files[2]];
    const child = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(child.status, 2, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.completeness, 'partial');
    assert.equal(result.inputs[0].sha256, digest(await readFile(files[0])));
    assert.equal(
      spawnSync(process.execPath, [...args, '--output', files[1]], { encoding: 'utf8' }).status,
      1,
    );
    assert.equal(spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
