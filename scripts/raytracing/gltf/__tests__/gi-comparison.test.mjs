import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  intermediateBufferReads,
  optionReader,
  rasterCoverage,
  referenceAssetCommit,
  referenceCoverage,
  replayTimingSummary,
} from '../../../../apps/hello/gi/scripts/gi-comparison.mjs';
import { summarizeTimings } from '../../../../apps/hello/gi/scripts/gi-dawn.mjs';
import { indirectMetrics, writePfm } from '../../../../apps/hello/gi/scripts/gi-metrics.mjs';

test('unmeasured replay timestamps stay explicit rather than becoming zero-cost passes', () => {
  const passes = [
    { label: 'ray-path.0.batch', kind: 'compute', workIndices: [0], gpuNanoseconds: 1000000 },
    { label: 'ray-path.1.batch', kind: 'compute', workIndices: [1], gpuNanoseconds: null },
  ];
  const result = replayTimingSummary(passes, [
    { workIndex: 0, kind: 'dispatch' },
    { workIndex: 1, kind: 'dispatchIndirect' },
  ]);
  assert.equal(result.status, 'partial');
  assert.equal(result.measuredPasses, 1);
  assert.equal(result.measuredPassSumMs, 1);
  assert.equal(result.rawPasses[1].gpuNanoseconds, null);
  assert.equal(result.stages[0].dispatches, 2);
  assert.equal(replayTimingSummary([], []).status, 'partial');
});

test('overlapping pass timings preserve coverage separately from repeated duration', () => {
  const passes = [
    [0, 20],
    [10, 30],
  ].map(([begin, end], executionIndex) => ({
    status: 'measured',
    passName: `irradiance-${executionIndex}`,
    passKind: 'compute',
    executionIndex,
    measurementSource: 'pass-boundary',
    beginningTick: String(begin),
    endTick: String(end),
    durationNanoseconds: end - begin,
  }));
  const result = summarizeTimings([
    {
      status: 'complete',
      frame: {
        frameId: 4,
        timestampPeriodNanoseconds: 1,
        passes,
        measuredPassNanoseconds: 40,
      },
    },
  ]);
  assert.deepEqual(result.intervals.gi, {
    sumNanoseconds: 40,
    unionNanoseconds: 30,
    overlapNanoseconds: 10,
    envelopeNanoseconds: 30,
  });
  assert.equal(result.rawFrames[0].frameId, 4);
  assert.deepEqual(result.rawFrames[0].passes, passes);
});

test('failed GPU timing retains its structured producer error', () => {
  const observation = {
    status: 'failed',
    error: { code: 'timestamp-readback-failed', detail: { stage: 'map' } },
  };
  const result = summarizeTimings([observation]);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.diagnostics, [observation]);
});

test('dark geometry and missing lane pixels remain in the reference denominator', () => {
  const records = new Float32Array(60);
  const words = new Uint32Array(records.buffer);
  for (let p = 0; p < 3; p++) words[p * 20 + 3] = 64;
  words[16] = 7;
  words[36] = 0xffffffff;
  words[56] = 12;
  const mask = referenceCoverage(records, 3);
  assert.deepEqual([...mask], [1, 0, 1]);
  // A black/missing lane pixel must count as an error, even though its RGB is zero.
  const reference = Float32Array.from([1, 1, 1, 20, 20, 20, 1, 1, 1]);
  const lane = Float32Array.from([1, 1, 1, 99, 99, 99, 0, 0, 0]);
  const metrics = indirectMetrics(lane, reference, mask);
  assert.equal(metrics.pixels, 2);
  assert.equal(metrics.ratio, 0.5);
  assert.ok(Math.abs(metrics.relativeRmse - Math.SQRT1_2) < 1e-12);
});

test('reference coverage rejects unsampled, failed and truncated records', () => {
  const records = new Float32Array(20);
  const words = new Uint32Array(records.buffer);
  assert.throws(() => referenceCoverage(records, 1), /invalid reference sample/);
  words[3] = 64;
  words[7] = 1;
  assert.throws(() => referenceCoverage(records, 1), /invalid reference sample/);
  assert.throws(() => referenceCoverage(records, 2), /record count/);
});

test('reference coverage respects a bounded typed-array view', () => {
  const allocation = new Float32Array(40);
  const records = allocation.subarray(20);
  const words = new Uint32Array(records.buffer, records.byteOffset, 20);
  words[3] = 1;
  words[16] = 12;
  assert.deepEqual([...referenceCoverage(records, 1)], [1]);
});

test('temporal raster coverage preserves dark geometry, padded rows and bounded identities', () => {
  const bytes = new Uint8Array(128);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(80, 2, true);
  const observation = {
    domain: 'visible-surface',
    bytes,
    records: new Uint32Array(32),
    metadata: { format: 'rgba32uint', width: 2, height: 2, bytesPerRow: 64 },
  };
  assert.deepEqual([...rasterCoverage(observation, 2, 2)], [1, 0, 0, 1]);
  view.setUint32(0, 3, true);
  assert.throws(() => rasterCoverage(observation, 2, 2), /invalid raster row/);
  assert.throws(() => rasterCoverage(undefined, 2, 2), /invalid raster coverage/);
});

test('a gather control cannot silently accept duplicate selectors', () => {
  assert.throws(
    () => optionReader(['--gather', 'irradiance-field', '--gather', 'exact']),
    /duplicate/,
  );
  const option = optionReader(['--gather', 'exact', '--capture']);
  assert.equal(option('gather'), 'exact');
  assert.equal(option('size', '512'), '512');
  assert.throws(() => option('capture'), /missing value/);
  assert.throws(() => optionReader(['--size', '--capture'])('size'), /missing value/);
});

test('gallery rejects absent lanes and mismatched sampling windows', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'gi-gallery-contract-'));
  const script = new URL('../../../../apps/hello/gi/scripts/gi-gallery.mjs', import.meta.url);
  const run = () =>
    spawnSync(
      process.execPath,
      [script.pathname, '--root', root, '--scenes', 'sponza', '--lanes', 'exact,irradiance-field'],
      { encoding: 'utf8' },
    );
  try {
    assert.notEqual(run().status, 0);
    const make = (lane, frames, ratio = 1, seed = 47) => {
      const dir = resolve(root, lane);
      mkdirSync(dir, { recursive: true });
      const rgb = Float32Array.from([1, 1, 1]);
      for (const part of ['reference', 'reference-indirect', 'direct', lane, `${lane}-indirect`])
        writePfm(resolve(dir, `sponza-${part}.pfm`), rgb, 1, 1);
      writeFileSync(
        resolve(dir, 'report.json'),
        JSON.stringify({
          provenance: { commit: 'same-source' },
          settings: {
            gather: lane,
            size: 1,
            frames,
            samples: 256,
            bounces: 7,
            receiver: 'diffuse',
            warmup: 256,
            reflections: false,
            seed,
          },
          scenes: [
            {
              id: 'sponza',
              metrics: {
                coverageSha256: 'same-geometric-mask',
                totalRatio: 1,
                all: { ratio, relativeRmse: 0 },
              },
            },
          ],
        }),
      );
    };
    make('exact', 64);
    assert.notEqual(run().status, 0);
    make('irradiance-field', 32);
    const mismatch = run();
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /unmatched source, window or reference coverage/);
    make('irradiance-field', 64);
    assert.equal(run().status, 0);
    make('irradiance-field', 64, 1, 101);
    assert.notEqual(run().status, 0);
    make('irradiance-field', 64, 0.899);
    const badEnergy = run();
    assert.equal(badEnergy.status, 1);
    assert.match(badEnergy.stderr, /energy gate failed/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('procedural reference needs no asset checkout and never borrows a parent commit', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'gi-assets-provenance-'));
  try {
    const git = (...args) => {
      const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q');
    git(
      '-c',
      'user.name=GI Test',
      '-c',
      'user.email=gi@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'engine',
    );
    assert.equal(referenceAssetCommit(root, ['cornell', 'leak']), null);
    assert.throws(() => referenceAssetCommit(root, ['sponza']));
    mkdirSync(resolve(root, 'forgeax-engine-assets'));
    assert.equal(referenceAssetCommit(root, ['leak']), null);
    assert.throws(() => referenceAssetCommit(root, ['sponza']), /asset checkout/);
    git('-C', 'forgeax-engine-assets', 'init', '-q');
    git(
      '-C',
      'forgeax-engine-assets',
      '-c',
      'user.name=GI Test',
      '-c',
      'user.email=gi@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'assets',
    );
    const assetHead = git('-C', 'forgeax-engine-assets', 'rev-parse', 'HEAD');
    assert.notEqual(assetHead, git('rev-parse', 'HEAD'));
    assert.equal(referenceAssetCommit(root, ['sponza']), assetHead);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserves complete small-scene reads and immutable bound offsets', () => {
  const requests = [
    { resourceId: 'frame', workIndex: 7, subresource: { offset: 32, size: 224 } },
    { resourceId: 'rays', workIndex: 8, subresource: { offset: 512 } },
  ];
  const windows = requests.map((request, i) => ({ request, bytes: i ? 1024 * 1024 : 224 }));
  const before = structuredClone(windows);
  const rows = intermediateBufferReads(windows);
  assert.deepEqual(rows, requests);
  assert.strictEqual(rows[0], requests[0]);
  assert.deepEqual(windows, before);
});
test('large-scene reads keep each actual bound window and full small uniforms inside the hard cap', () => {
  const windows = [
    ...Array.from({ length: 48 }, (_, i) => ({
      request: { resourceId: `rays-${i}`, workIndex: i, subresource: { offset: 128 + i * 256 } },
      bytes: 16 * 1024 * 1024,
    })),
    {
      request: { resourceId: 'frame', workIndex: 20, subresource: { offset: 256, size: 224 } },
      bytes: 224,
    },
  ];
  const before = structuredClone(windows);
  const rows = intermediateBufferReads(windows);
  let bytes = 0;
  rows.forEach((row, i) => {
    const size = row.subresource?.size ?? windows[i].bytes;
    bytes += size;
    assert.ok(size > 0 && size <= windows[i].bytes);
    assert.equal(size % 4, 0);
    assert.equal(row.subresource.offset, windows[i].request.subresource.offset);
    assert.equal(row.workIndex, windows[i].request.workIndex);
    assert.equal(row.resourceId, windows[i].request.resourceId);
  });
  assert.ok(bytes <= 64 * 1024 * 1024);
  assert.deepEqual(rows.at(-1), windows.at(-1).request);
  assert.deepEqual(windows, before);
  assert.ok(rows[0].subresource.size < windows[0].bytes);
});
test('rejects invalid or unavailable buffer windows instead of silently accepting absent evidence', () => {
  for (const bytes of [0, -4, 3, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => intermediateBufferReads([{ request: { resourceId: 'bad', workIndex: 0 }, bytes }]),
      /invalid GI intermediate/,
    );
});

test('full receiver texture snapshots share the existing intermediate buffer budget', () => {
  const textureBytes = 2 * 512 * 512 * 4;
  const windows = [
    {
      request: { resourceId: 'probe-radiance', workIndex: 529, subresource: { offset: 128 } },
      bytes: 64 * 1024 * 1024,
    },
  ];
  const [request] = intermediateBufferReads(windows, textureBytes);
  assert.equal(request.subresource.offset, 128);
  assert.equal(request.subresource.size + textureBytes, 64 * 1024 * 1024);
  assert.throws(() => intermediateBufferReads(windows, 64 * 1024 * 1024), /budget/);
  assert.throws(() => intermediateBufferReads([], 64 * 1024 * 1024 + 4), /budget/);
  for (const bytes of [-4, 3, NaN, Infinity])
    assert.throws(() => intermediateBufferReads([], bytes), /budget/);
});
