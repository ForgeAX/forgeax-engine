import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { selectCpuTimeline, queryCpuTimeline } from '../cpu_query.mjs';
import { buildCpuTimeline } from '../render_cpu_timeline.mjs';
import { cpuTimelineCallTrees, cpuTimelineFunctionRows } from '../cpu_timeline_view.mjs';

function fixture() {
  const callFrame = (functionName) => ({
    functionName,
    url: 'file:///owner.mjs',
    lineNumber: 0,
    columnNumber: 0,
  });
  const profile = {
    startTime: 1000,
    endTime: 13000,
    nodes: [
      { id: 1, callFrame: callFrame('(root)'), children: [2, 5] },
      { id: 2, callFrame: callFrame('update'), children: [3, 4] },
      { id: 3, callFrame: callFrame('update') },
      { id: 4, callFrame: callFrame('draw') },
      { id: 5, callFrame: callFrame('(idle)') },
    ],
    samples: [2, 3, 4, 5, 4],
    timeDeltas: [1000, 2000, 2000, 1000, 2000],
  };
  const raw = {
    failures: [],
    profiles: ['page', 'worker'].map((type, index) => ({
      target: { targetId: 'target-' + index, type, title: index ? 'forgeax-render' : 'Host' },
      profile,
      scriptDigests: [],
    })),
  };
  const anchor = { offsetLowerMs: 1, offsetUpperMs: 1, timeOriginMs: 10000 };
  const report = {
    cpu: { commonWindow: { startTime: 1000, endTime: 13000 }, failures: [] },
    coldFirelineCpu: { anchorsBefore: [anchor], anchorsAfter: [anchor] },
    windows: { sampled: { submissionGaps: { worstCompletedGaps: [] } } },
  };
  const frames = {
    timeOrigin: 10000,
    firstLiveAt: 0,
    end: 12,
    frames: [0, 5, 10].map((at, i) => ({
      at,
      frameId: i + 1,
      worldIdentity: 'world',
      deviceGeneration: 0,
    })),
  };
  return buildCpuTimeline(raw, { report, frames, rawSha256: 'a'.repeat(64) });
}
const selected = (model, extra = {}) =>
  selectCpuTimeline(model, { target: 'forgeax-render', ...extra });

test('selection borrows canonical tracks and preserves complete capture/clock identity', () => {
  const model = fixture(),
    s = selected(model, { fromMs: 1.5, toMs: 7 });
  assert.equal(s.model.tracks.length, 1);
  assert.equal(model.tracks.length, 2);
  assert.equal(s.model.tracks[0], model.tracks[1]);
  const q = queryCpuTimeline(s);
  assert.deepEqual(q.identity, model.identity);
  assert.deepEqual(q.clock, model.clock);
  assert.deepEqual(q.range, { fromMs: 1.5, toMs: 7 });
  assert.equal(q.targets[0].sampleCount, 4);
  assert.equal(q.targets[0].sampledMs, 5.5);
  assert.equal(q.targets[0].unobservedMs, 0);
  assert.equal(q.targets[0].reconstruction.method, 'timestamp-ordered-ending-sample');
});
test('interval selection clips spans while preserving original coordinates, recursion and supporting sample bounds', () => {
  const model = fixture(),
    s = selected(model, { fromMs: 1.5, toMs: 7 });
  const q = queryCpuTimeline(s, { view: 'intervals', nodeId: 2 });
  assert.deepEqual(
    q.rows.map((r) => [r.startMs, r.endMs, r.durationMs]),
    [
      [1.5, 5, 3.5],
      [6, 7, 1],
    ],
  );
  assert.deepEqual(q.rows[0].originalRange, { startMs: 1, endMs: 5 });
  assert.deepEqual(q.rows[0].sampleRange, { fromIndex: 0, toIndexExclusive: 2 });
  assert.equal(q.rows[0].sampleCount, 2);
  assert.equal(q.rows[1].sampleCount, 1);
  assert.equal(queryCpuTimeline(s, { view: 'intervals', search: 'UPDATE' }).rows.length, 3);
  const functions = queryCpuTimeline(s, { nodeId: 2 });
  assert.equal(
    functions.rows[0].inclusiveMs,
    q.rows.reduce((n, r) => n + r.durationMs, 0),
  );
  assert.equal(functions.rows[0].selfMs, 0);
  // Half-open boundaries never include the idle interval starting at 5 ms.
  assert.equal(
    queryCpuTimeline(selected(model, { fromMs: 3, toMs: 5 }), { view: 'intervals', nodeId: 5 }).rows
      .length,
    0,
  );
});
test('functions and trees reuse viewer calculations; filtering/paging happens after complete aggregation', () => {
  const model = fixture(),
    s = selected(model),
    q = queryCpuTimeline(s, { limit: 1 });
  assert.equal(q.rows[0].functionName, 'draw');
  assert.equal(q.rows[0].selfMs, 4);
  assert.equal(q.page.hasMore, true);
  const all = queryCpuTimeline(s, { limit: 1000 });
  assert.deepEqual(
    all.rows.map((r) => r.nodeId).sort(),
    cpuTimelineFunctionRows(s.model, 0, 12)[0]
      .rows.map((r) => r.nodeId)
      .sort(),
  );
  const recursive = queryCpuTimeline(s, { search: 'update', sort: 'inclusiveMs' });
  assert.deepEqual(
    recursive.rows.map((r) => [r.nodeId, r.inclusiveMs]),
    [
      [2, 6],
      [3, 2],
    ],
  );
  const trees = queryCpuTimeline(s, { view: 'tree', direction: 'bottom-up' });
  assert.deepEqual(trees.trees, cpuTimelineCallTrees(s.model, 0, 12, { direction: 'bottom-up' }));
  assert.equal(queryCpuTimeline(s, { offset: 1, limit: 1 }).rows[0].nodeId, 3);
});
test('completion lookup, function ranking and interval lookup compose without a new analyzer', () => {
  const model = fixture(),
    completions = queryCpuTimeline(selected(model), { view: 'completions' });
  assert.deepEqual(
    completions.rows.map((r) => r.completionIndex),
    [0, 1],
  );
  const s = selected(model, { completionIndex: completions.rows[1].completionIndex });
  const top = queryCpuTimeline(s, { limit: 1 }).rows[0];
  const spans = queryCpuTimeline(s, { view: 'intervals', nodeId: top.nodeId });
  assert.equal(top.functionName, 'draw');
  assert.equal(top.selfMs, 2);
  assert.equal(spans.rows.length, 1);
  assert.equal(spans.rows[0].startMs, 6);
  assert.equal(spans.rows[0].endMs, 8);
  assert.equal(spans.rows[0].sliceIndex, 5);
  assert.deepEqual(spans.rows[0].sampleRange, { fromIndex: 3, toIndexExclusive: 4 });
  assert.equal(spans.completion.current.frameId, 3);
  assert.equal(spans.targets[0].unobservedMs, 2);
  assert.equal(
    queryCpuTimeline(selected(model, { completionIndex: 1, fromMs: 6, toMs: 7 })).completion
      .overlapMs,
    1,
  );
  assert.equal(
    queryCpuTimeline(selected(model, { fromMs: 4, toMs: 6 }), { view: 'completions' }).rows[0]
      .completionGapMs,
    5,
  );
});
test('unobserved ranges remain unknown and partial completion/missing receipts remain visible', () => {
  const model = fixture();
  model.producerReportOk = false;
  model.completeness = 'partial';
  model.frameIntervals[1].coverage = 'partial';
  model.frameIntervals[1].missingIntermediateReceipts = 6;
  const q = queryCpuTimeline(selected(model, { completionIndex: 1 }));
  assert.equal(q.producerReportOk, false);
  assert.equal(q.completeness, 'partial');
  assert.equal(q.completion.coverage, 'partial');
  assert.equal(q.completion.missingIntermediateReceipts, 6);
  const empty = queryCpuTimeline(selected(model, { fromMs: 10, toMs: 12 }), { view: 'intervals' });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.targets[0].sampledMs, 0);
  assert.equal(empty.targets[0].unobservedMs, 2);
});
test('invalid ranges, target-local coordinates, unsupported filters and lossy tree paging are rejected', () => {
  const model = fixture(),
    s = selected(model);
  for (const opts of [
    { target: 'missing' },
    { fromMs: NaN },
    { fromMs: -1 },
    { fromMs: 4, toMs: 4 },
    { completionIndex: 2 },
    { completionIndex: 0, fromMs: 6 },
  ])
    assert.throws(() => selectCpuTimeline(model, opts));
  for (const opts of [
    { view: 'calls' },
    { limit: 0 },
    { offset: -1 },
    { sort: 'calls' },
    { nodeId: 999 },
    { direction: 'bottom-up' },
    { view: 'tree', limit: 1 },
    { view: 'tree', search: 'draw' },
    { view: 'completions', nodeId: 4 },
  ])
    assert.throws(() => queryCpuTimeline(s, opts));
  assert.throws(
    () => queryCpuTimeline(selectCpuTimeline(model), { nodeId: 4 }),
    /exactly one target/,
  );
});
test('one CPU query CLI emits bounded results with file identity and preserves existing output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cpu-query-')),
    input = join(dir, 'timeline.json'),
    output = join(dir, 'result.json');
  const cli = fileURLToPath(new URL('../cpu.mjs', import.meta.url)),
    bytes = JSON.stringify(fixture());
  const run = (args) =>
    spawnSync(process.execPath, [cli, 'query', input, ...args], { encoding: 'utf8' });
  try {
    await writeFile(input, bytes);
    const r = run([
      '--target',
      'forgeax-render',
      '--completion-index',
      '1',
      '--limit',
      '1',
      '--output',
      output,
    ]);
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(await readFile(output));
    assert.equal(data.rows[0].selfMs, 2);
    assert.equal(data.rows.length, 1);
    assert.equal(data.inputSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.notEqual(run(['--output', output]).status, 0);
    assert.notEqual(run(['--view', 'tree', '--limit', '1']).status, 0);
    assert.equal(await readFile(input, 'utf8'), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
