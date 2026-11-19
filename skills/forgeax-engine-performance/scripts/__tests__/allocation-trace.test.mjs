import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocationTrace,
  allocationTraceDifference,
  allocationTraceDistribution,
} from '../allocation_trace.mjs';
function fixture() {
  return {
    snapshot: {
      meta: {
        trace_node_fields: ['size', 'children', 'id', 'count', 'function_info_index'],
        trace_function_info_fields: ['column', 'script_name', 'name', 'line'],
      },
    },
    strings: ['root', 'a', 'b', 'file.mjs'],
    trace_function_infos: [0, 3, 0, 0, 2, 3, 1, 8, 4, 3, 2, 9],
    trace_tree: [8, [32, [], 3, 2, 2], 1, 1, 0, 64, [], 2, 4, 1],
  };
}
test('partitions self counters once across parents, siblings and metadata column orders', () => {
  const result = allocationTrace(fixture());
  assert.equal(result.count, 7);
  assert.equal(result.bytes, 104);
  assert.deepEqual(result.nodes.map((x) => [x.name, x.count, x.bytes]).sort(), [
    ['a', 4, 64],
    ['b', 2, 32],
    ['root', 1, 8],
  ]);
  assert.equal(result.nodes.find((x) => x.name === 'a').line, 8);
});
test('rejects missing tracing, invalid references, duplicate nodes and negative counters', () => {
  const missing = fixture();
  missing.trace_tree = [];
  assert.throws(() => allocationTrace(missing), /trackAllocations/);
  for (const [at, value] of [
    [4, 999],
    [3, -1],
    [7, 1],
  ]) {
    const input = fixture();
    input.trace_tree[at] = value;
    assert.throws(() => allocationTrace(input));
  }
});

test('deltas reject a reset tracker and preserve new trace nodes without double counting', () => {
  const before = allocationTrace(fixture()),
    after = structuredClone(before);
  after.nodes[0].count += 3;
  after.nodes[0].bytes += 96;
  const delta = allocationTraceDifference(before, after);
  assert.equal(delta.count, 3);
  assert.equal(delta.bytes, 96);
  const reset = structuredClone(after);
  reset.nodes.shift();
  assert.throws(() => allocationTraceDifference(before, reset), /disappeared/);
  const renamed = structuredClone(after);
  renamed.nodes[0].name = 'other';
  assert.throws(() => allocationTraceDifference(before, renamed), /identity/);
  const backwards = structuredClone(before);
  backwards.nodes[0].bytes--;
  assert.throws(() => allocationTraceDifference(before, backwards), /decreased/);
});

test('distribution conserves counts and bytes, groups call paths, and separates source identities', () => {
  const trace = allocationTrace(fixture());
  trace.nodes.push({ ...trace.nodes[1], id: 99 });
  trace.count += trace.nodes[1].count;
  trace.bytes += trace.nodes[1].bytes;
  const result = allocationTraceDistribution(trace, 1);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].name, 'a');
  assert.equal(result.rows[0].count, 8);
  assert.equal(
    result.rows.reduce((n, row) => n + row.count, 0),
    trace.count,
  );
  assert.equal(
    result.rows.reduce((n, row) => n + row.bytes, 0),
    trace.bytes,
  );
  trace.nodes.at(-1).url = 'different.mjs';
  assert.equal(
    allocationTraceDistribution(trace, 10).rows.filter((row) => row.name === 'a').length,
    2,
  );
  assert.throws(() => allocationTraceDistribution({ ...trace, count: 0 }), /totals/);
  assert.throws(() => allocationTraceDistribution(trace, 0), /positive/);
});

test('same stable function and script IDs admit lazy V8 source positions without accepting identity changes', () => {
  const before = allocationTrace(fixture());
  before.nodes[0] = { ...before.nodes[0], functionId: 123, scriptId: 7, line: 0, column: 0 };
  const after = structuredClone(before);
  after.nodes[0].line = 12;
  after.nodes[0].column = 4;
  after.nodes[0].count++;
  assert.equal(allocationTraceDifference(before, after).count, 1);
  for (const field of ['functionId', 'scriptId', 'functionIndex', 'name', 'url']) {
    const changed = structuredClone(after);
    changed.nodes[0][field] = typeof changed.nodes[0][field] === 'number' ? 999 : 'changed';
    assert.throws(() => allocationTraceDifference(before, changed), /identity/);
  }
  const known = structuredClone(after);
  known.nodes[0].line = 13;
  assert.throws(() => allocationTraceDifference(after, known), /identity/);
  const unproven = structuredClone(before);
  delete unproven.nodes[0].functionId;
  assert.throws(() => allocationTraceDifference(unproven, after), /identity/);
  const raw = fixture();
  raw.snapshot.meta.trace_function_info_fields.push('function_id', 'script_id');
  raw.trace_function_infos = [0, 3, 0, 0, 100, 7, 2, 3, 1, 8, 101, 7, 4, 3, 2, 9, 102, 7];
  assert.equal(allocationTrace(raw).nodes[0].functionId, 100);
  assert.equal(allocationTrace(raw).nodes[0].scriptId, 7);
});
