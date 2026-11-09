import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  allocationUnion, summarizeAllocationCaptures, allocationRoundMarkdown, verifiedAllocationArtifact,
} from '../summarize_game3d_allocations.mjs';

function trace() {
  const nodes = [
    { name: 'large', count: 1, bytes: 1000 },
    { name: 'frequent', count: 100, bytes: 100 },
    { name: 'remainder', count: 2, bytes: 2 },
  ].map((row, id) => ({ ...row, id, url: 'source.mjs', line: id, column: 0 }));
  return { count: 103, bytes: 1102, nodes };
}
const snapshot = () => ({
  snapshot: { node_count: 3, meta: {
    node_fields: ['type', 'name', 'self_size'],
    node_types: [['object', 'closure', 'native'], 'string', 'number'],
  } }, strings: ['World', 'run', 'backing'], nodes: [0, 0, 32, 1, 1, 64, 2, 2, 4096],
});
function fixtures() {
  const names = ['forgeax-render', 'forgeax-engine'];
  const moving = { status: 'complete',
    ordinary: [{ index: 0, before: { now: 0, ready: 0 }, after: { now: 1000, ready: 50 } }],
    windows: [{ index: 0, realms: names.map((name) => ({ name, sampledBytes: 1000,
      sampledRecords: 3, secondsBounds: [1, 2], readyFrameBounds: [5, 10] })) }],
  };
  const counts = { status: 'complete', method: 'Intrusive diagnostic window',
    traceBefore: { execution: { frame: { completed: 10 }, render: { completedFrame: 9 } } },
    traceAfter: { execution: { frame: { completed: 30 }, render: { completedFrame: 17 } } },
    realms: names.map((name) => ({ name, counts: { path: name, count: 103, bytes: 1102 } })),
  };
  const retained = { status: 'complete',
    drained: { execution: { frame: { completed: 40, inFlight: 0 } } },
    afterSnapshots: { execution: { frame: { completed: 40, inFlight: 0 } } },
    final: { execution: { frame: { completed: 45 } } },
    realms: names.toReversed().map((name) => ({ name, snapshot: { path: name },
      before: { usedSize: 1024 } })),
  };
  return { moving, counts, retained };
}
const readArtifact = async (_reference, kind) => kind === 'counts' ? trace() : snapshot();

test('shared union keeps count-heavy small rows and conserves both totals', () => {
  const result = allocationUnion(trace(), 1);
  assert.deepEqual(result.rows.map((row) => row.name), ['large', 'frequent', '(other)']);
  assert.equal(result.rows.reduce((n, row) => n + row.count, 0), 103);
  assert.equal(result.rows.reduce((n, row) => n + row.bytes, 0), 1102);
});
test('shuffled realms retain independent completion denominators and census populations', async () => {
  const { moving, counts, retained } = fixtures();
  const result = await summarizeAllocationCaptures(moving, counts, retained, readArtifact);
  const [engine, render] = result.counts.realms;
  assert.equal(engine.completedFrames, 20); assert.equal(engine.eventsPerFrame, 103 / 20);
  assert.equal(render.completedFrames, 8); assert.equal(render.eventsPerFrame, 103 / 8);
  assert.deepEqual(result.sampled[0].realms[0].bytesPerSecondBounds, [500, 1000]);
  assert.equal(result.retained.realms[0].selfBytes, 4192);
  assert.equal(result.retained.realms[0].objectNodes, 1);
  const markdown = allocationRoundMarkdown(result);
  assert.match(markdown, /forgeax-engine/); assert.match(markdown, /forgeax-render/);
  assert.match(markdown, /frequent/); assert.match(markdown, /native/);
});
test('incomplete, duplicate, contradictory and unpaused receipts fail closed', async () => {
  for (const change of [
    (x) => { x.moving.status = 'running'; },
    (x) => { x.counts.realms[1].name = x.counts.realms[0].name; },
    (x) => { x.counts.realms[0].counts.count = 1; },
    (x) => { x.counts.traceAfter.execution.render.completedFrame = 9; },
    (x) => { x.retained.afterSnapshots.execution.frame.completed++; },
  ]) {
    const f = fixtures(); change(f);
    await assert.rejects(summarizeAllocationCaptures(f.moving, f.counts, f.retained, readArtifact));
  }
});
test('artifact contents must match the producer digest', async () => {
  const path = await mkdtemp(join(tmpdir(), 'forgeax-round-'));
  try {
    await writeFile(join(path, 'artifact.json'), '{}');
    await assert.rejects(verifiedAllocationArtifact({ path: 'artifact.json', sha256: 'wrong' }, path),
      /digest mismatch/);
  } finally { await rm(path, { recursive: true }); }
});


test('a real function named other is not confused with the remainder row', () => {
  const input = trace(); input.nodes[0].name = '(other)';
  const result = allocationUnion(input, 1);
  assert.equal(result.rows.reduce((n, row) => n + row.count, 0), input.count);
  assert.equal(result.rows.reduce((n, row) => n + row.bytes, 0), input.bytes);
  assert(result.rows.some((row) => row.name === '(other)' && row.url === 'source.mjs'));
});

test('admitted captures require stable producers, equal content and the same motion/admission tools', async () => {
  function admitted() {
    const f = fixtures();
    for (const [index, report] of [f.moving, f.counts, f.retained].entries()) {
      report.kind = 'capture-' + index;
      report.motionSha256 = 'same-motion';
      report.workloadHelperSha256 = 'same-admission';
      report.workload = { topic: 'game-3d.runtime-vase', guid: 'actual-guid', generation: index + 1,
        entity: index + 10, values: { height: 2.4, radius: 0.75, sides: 32 },
        vertexCount: 495, aabb: [-1, 0, -1, 1, 2.4, 1] };
      report.finalWorkload = structuredClone(report.workload);
    }
    return f;
  }
  let f = admitted();
  const summary = await summarizeAllocationCaptures(f.moving, f.counts, f.retained, readArtifact);
  assert.equal(summary.workload.captures.length, 3);
  assert.match(allocationRoundMarkdown(summary), /Workload admission/);
  for (const change of [
    f => { delete f.counts.workload; },
    f => { f.retained.finalWorkload.generation++; },
    f => { f.counts.motionSha256 = 'other-motion'; },
    f => { f.retained.workloadHelperSha256 = 'other-admission'; },
    f => { f.counts.workload.vertexCount--; f.counts.finalWorkload.vertexCount--; },
  ]) {
    f = admitted(); change(f);
    await assert.rejects(summarizeAllocationCaptures(f.moving, f.counts, f.retained, readArtifact));
  }
});
