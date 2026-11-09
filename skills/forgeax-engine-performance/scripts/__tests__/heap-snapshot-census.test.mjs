import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heapSnapshotCensus } from '../heap_snapshot_census.mjs';

const snapshot = () => ({ snapshot: { node_count: 4, meta: {
  node_fields: ['name', 'self_size', 'type'], node_types: ['string', 'number', ['object', 'native', 'closure']],
} }, strings: ['World', 'system / JSArrayBufferData', 'update'],
  nodes: [0, 32, 0, 0, 32, 0, 1, 4096, 1, 2, 64, 2] });

test('censuses actual metadata column order and conserves counts and bytes', () => {
  const result = heapSnapshotCensus(snapshot());
  assert.equal(result.count, 4); assert.equal(result.selfBytes, 4224);
  for (const partition of [result.byType, result.byName]) {
    assert.equal(partition.reduce((n, row) => n + row.count, 0), 4);
    assert.equal(partition.reduce((n, row) => n + row.selfBytes, 0), 4224);
  }
  assert.deepEqual(result.byName.find(row => row.key === 'object:World'), { key: 'object:World', count: 2, selfBytes: 64 });
});

test('rejects incomplete, invalid and falsely declared populations', () => {
  const incomplete = snapshot(); incomplete.nodes.pop();
  assert.throws(() => heapSnapshotCensus(incomplete), /columns/);
  const invalid = snapshot(); invalid.nodes[2] = 10;
  assert.throws(() => heapSnapshotCensus(invalid), /Invalid heap snapshot node/);
  const mismatch = snapshot(); mismatch.snapshot.node_count = 3;
  assert.throws(() => heapSnapshotCensus(mismatch), /count does not match/);
});
