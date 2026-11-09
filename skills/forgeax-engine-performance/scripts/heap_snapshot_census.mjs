#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { emitJson, loadJson, requireFact, runCli } from './lib.mjs';

/** Census the V8 snapshot population, without confusing it with allocation events. */
export function heapSnapshotCensus(snapshot) {
  const meta = snapshot?.snapshot?.meta;
  requireFact(Array.isArray(meta?.node_fields) && Array.isArray(meta.node_types) &&
    Array.isArray(snapshot.nodes) && Array.isArray(snapshot.strings), 'Require V8 heap snapshot node metadata');
  const fields = meta.node_fields, width = fields.length;
  const typeAt = fields.indexOf('type'), nameAt = fields.indexOf('name'), sizeAt = fields.indexOf('self_size');
  requireFact(typeAt >= 0 && nameAt >= 0 && sizeAt >= 0 && snapshot.nodes.length % width === 0,
    'Invalid heap snapshot node columns');
  const types = meta.node_types[typeAt];
  requireFact(Array.isArray(types), 'Require snapshot node type enumeration');
  const byType = new Map(), byName = new Map();
  let count = 0, selfBytes = 0;
  const add = (map, key, size) => {
    let row = map.get(key);
    if (!row) { row = { key, count: 0, selfBytes: 0 }; map.set(key, row); }
    row.count++; row.selfBytes += size;
  };
  for (let index = 0; index < snapshot.nodes.length; index += width) {
    const type = types[snapshot.nodes[index + typeAt]], name = snapshot.strings[snapshot.nodes[index + nameAt]];
    const size = snapshot.nodes[index + sizeAt];
    requireFact(typeof type === 'string' && typeof name === 'string' && Number.isSafeInteger(size) && size >= 0,
      'Invalid heap snapshot node');
    count++; selfBytes += size;
    add(byType, type, size); add(byName, type + ':' + name, size);
  }
  requireFact(snapshot.snapshot.node_count === count, 'Snapshot node count does not match payload');
  const sorted = map => [...map.values()].sort((a, b) => b.selfBytes - a.selfBytes || b.count - a.count || a.key.localeCompare(b.key));
  return { kind: 'v8-heap-snapshot-census', count, selfBytes, byType: sorted(byType), byName: sorted(byName),
    interpretation: 'Every V8 snapshot node is counted once; grouped tables are alternative partitions. Counts include VM/internal nodes, arrays, closures, strings and native nodes, not only application objects. Self bytes are not retained dominator sizes. The snapshot alone does not prove forced GC, stable workload, natural pauses or allocation rate; record capture boundaries separately. Native ArrayBuffer backing may be represented by separate nodes and must not be added twice.' };
}

runCli(import.meta.url, async () => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean' }, output: { type: 'string' },
  } });
  if (values.help) { console.log('node heap_snapshot_census.mjs SNAPSHOT [--output FILE]'); return; }
  requireFact(positionals.length === 1, 'Require one V8 heap snapshot');
  const input = await loadJson(positionals[0]);
  await emitJson({ inputSha256: input.sha256, ...heapSnapshotCensus(input.value) }, values.output, positionals);
});
