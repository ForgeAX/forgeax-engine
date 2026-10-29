import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureAllocations, summarizeProbeProfile } from '../allocation_probe.mjs';
import { heapNodes } from '../heap_profile.mjs';
import {
  compareHeapProfiles,
  diffByteTables,
  inlineSourceSymbols,
  sourcePackage,
} from '../compare_heap_profiles.mjs';

const frame = (functionName, url = '', lineNumber = 0) => ({
  functionName,
  url,
  lineNumber,
  columnNumber: 0,
});
const node = (id, selfSize, callFrame, children = []) => ({ id, selfSize, callFrame, children });
// Already-symbolized frames: url is the source path (inline sources).
const heap = (queryBytes, readBytes) => ({
  head: node(1, 0, frame('(root)'), [
    node(2, queryBytes, frame('query', 'packages/ecs/src/query.ts', 9), [
      node(3, 50, frame('push')),
    ]),
    node(4, readBytes, frame('readRow', 'packages/ecs/src/table.ts', 20)),
    node(5, 5, frame('t', 'https://fixture.test/assets/x.js')),
  ]),
  samples: [],
});
const side = (profile, metadata = null) => ({
  profile,
  metadata,
  symbols: inlineSourceSymbols(profile),
});

test('source packages and byte-table diffs', () => {
  assert.equal(sourcePackage('engine/packages/render/src/a.ts'), 'render');
  assert.equal(sourcePackage('node_modules/@scope/pkg/x.js'), '@scope/pkg');
  assert.equal(sourcePackage('assets/gameplay/a.ts'), 'assets/gameplay');
  assert.equal(sourcePackage('a.ts'), 'a.ts');
  const rows = diffByteTables(
    new Map([
      ['a', 10],
      ['b', 4],
    ]),
    new Map([
      ['a', 2],
      ['c', 3],
    ]),
  );
  assert.deepEqual(
    rows.map((r) => [r.key, r.deltaBytes, r.deltaPercent]),
    [
      ['a', -8, -80],
      ['b', -4, -100],
      ['c', 3, null],
    ],
  );
});

test('retained floor comparison attributes deltas by package, file and function', () => {
  const result = compareHeapProfiles(side(heap(100, 40)), side(heap(30, 40)), {
    kind: 'retained',
  });
  assert.equal(result.total.deltaBytes, -70);
  assert.deepEqual(result.functions[0], {
    key: 'packages/ecs/src/query.ts#query',
    beforeBytes: 150,
    afterBytes: 80,
    deltaBytes: -70,
    deltaPercent: (-70 * 100) / 150,
  });
  assert.equal(result.packages.find((r) => r.key === 'ecs').deltaBytes, -70);
  assert.equal(result.packages.find((r) => r.key === '(unresolved)').deltaBytes, 0);
  assert.equal(result.unresolved[0].key, 't @ /assets/x.js');
  assert.equal(result.before.totalBytes, 195);
});

test('comparison refuses a retained/churn population mismatch', () => {
  const churn = { includesCollectedByMajorGC: true, samplingInterval: 16384 };
  assert.throws(
    () => compareHeapProfiles(side(heap(1, 1), churn), side(heap(1, 1)), { kind: 'retained' }),
    /contradicts/,
  );
  assert.throws(() => compareHeapProfiles(side(heap(1, 1)), side(heap(1, 1)), { kind: 'cpu' }));
  const ok = compareHeapProfiles(side(heap(1, 1), churn), side(heap(2, 1), churn), {
    kind: 'churn',
  });
  assert.equal(ok.samplingIntervalsMatch, true);
});

test('CLI compares two inline-symbolized profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-heap-compare-'));
  try {
    await writeFile(join(root, 'a.json'), JSON.stringify(heap(100, 40)));
    await writeFile(join(root, 'b.json'), JSON.stringify(heap(30, 40)));
    const cli = fileURLToPath(new URL('../compare_heap_profiles.mjs', import.meta.url));
    const run = spawnSync(
      process.execPath,
      [cli, join(root, 'a.json'), join(root, 'b.json'), '--kind', 'retained', '--inline-sources'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.kind, 'heap-profile-comparison');
    assert.equal(output.total.deltaBytes, -70);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('node allocation probe separates an allocating function from an allocation-free one', async () => {
  const out = new Float64Array(3);
  const allocating = await measureAllocations((i) => [i, i + 1, i + 2]);
  const reused = await measureAllocations((i) => {
    out[0] = i;
    out[1] = i + 1;
    out[2] = i + 2;
    return out;
  });
  assert.ok(allocating.bytesPerCall > 32, `allocating ${allocating.bytesPerCall}`);
  assert.ok(reused.bytesPerCall < 4, `reused ${reused.bytesPerCall}`);
  await assert.rejects(measureAllocations(() => 0, { calls: 0 }));
});

test('quarantines orphan sample identities only through explicit attribution handling', () => {
  const profile = heap(1, 2);
  profile.samples.push({ nodeId: 999, size: 64 });
  assert.throws(() => heapNodes(profile), /Invalid heap sample/);
  assert.equal(heapNodes(profile, { allowOrphanSamples: true }).length, 5);
  profile.samples.push({ nodeId: 'invalid', size: 1 });
  assert.throws(() => heapNodes(profile, { allowOrphanSamples: true }), /Invalid heap sample/);
});

test('includes an explicit target when an optimized marker disappears without counting inspector work', () => {
  const url = 'file:///bench.mjs';
  const profile = {
    head: node(1, 0, frame('(root)'), [
      node(2, 16, frame('__forgeaxAllocationProbe')),
      node(3, 64, frame('snapshots', url)),
      node(4, 1024, frame('post', 'node:inspector')),
    ]),
    samples: [
      { nodeId: 2, size: 16, ordinal: 1 },
      { nodeId: 3, size: 64, ordinal: 2 },
      { nodeId: 4, size: 1024, ordinal: 3 },
      { nodeId: 99, size: 8, ordinal: 4 },
    ],
  };
  const report = summarizeProbeProfile(profile, { calls: 1, firstMeasuredOrdinal: 1, targetFrame: { url, functionName: 'snapshots' } });
  assert.equal(report.attributedSampledBytes, 64);
  assert.equal(report.unattributedSampledBytes, 8);
  assert.equal(report.bytesPerCall, 72);
});
