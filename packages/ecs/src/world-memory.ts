import type { BufferPoolStats } from './buffer-pool';
import type { FrameArenaStats } from './frame-arena';
import type { BufferReaderStats } from './owned-buffers';
import type { World } from './world';
import { worldInternal } from './world-internal';

const COVERAGE = Object.freeze({
  backing: Object.freeze([
    'arena',
    'managed-and-owned-pool',
    'tables',
    'entity-records',
    'archetype-rows',
  ] as const),
  hardBudgets: Object.freeze(['arena', 'owned-buffer-admission'] as const),
  excluded: Object.freeze(['vm-heap', 'external-resources', 'native', 'gpu'] as const),
});
export interface WorldMemoryStats {
  readonly arena: FrameArenaStats;
  readonly buffers: BufferPoolStats;
  readonly readers: BufferReaderStats;
  readonly tableBytes: number;
  readonly entityRecordBytes: number;
  readonly archetypeBytes: number;
  readonly coverage: typeof COVERAGE;
}
/** Cold inspection of existing owners; no numeric storage or identity mirror. */
export function readWorldMemoryStats(world: World): WorldMemoryStats {
  const internal = world[worldInternal];
  const graph = internal.getGraph();
  const buffers = new Set<ArrayBufferLike>();
  for (const table of graph.tables) {
    if (table === undefined) continue;
    buffers.add(table.membership.buffer);
    for (const storage of table.storage.values()) {
      buffers.add(storage.added.buffer);
      for (const column of storage.fields.values()) buffers.add(column.buffer);
    }
  }
  let tableBytes = 0;
  for (const buffer of buffers) tableBytes += buffer.byteLength;
  let archetypeBytes = 0;
  for (const archetype of graph.archetypes)
    if (archetype !== undefined) archetypeBytes += archetype.rows.byteLength;
  const records = internal.getRecords();
  return {
    arena: internal.getFrameArena().stats(),
    buffers: internal.getBufferPool().stats(),
    readers: world.buffers.stats(),
    tableBytes,
    archetypeBytes,
    entityRecordBytes:
      records.generation.byteLength +
      records.archetypeId.byteLength +
      records.archetypeRow.byteLength,
    coverage: COVERAGE,
  };
}
