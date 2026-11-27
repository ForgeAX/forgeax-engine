import { batchLodLevelCount } from './batch-layout';
import { MemberCandidates } from './batch-members';
import type { GpuDrivenBatch, SubmissionPlan } from './batch-topology';
import type { FilteredTaskHeaders } from './filtered-task-headers';
import {
  assembleFilteredBatch,
  type BatchPartition,
  groupForPartition,
  type PreparedBatch,
  type PreparedBatchRows,
  partitionBatch,
} from './production-raster-prepare';

export interface FilteredWindow {
  readonly id: number;
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly visibleStart: number;
  readonly levelCapacity: number;
  readonly indirectStart: number;
  readonly levels: number;
}
export interface FilteredGeometry {
  readonly source: GpuDrivenBatch;
  readonly partitions: readonly BatchPartition[];
  readonly bindings: ReadonlyMap<string, string> | undefined;
}
export interface FilteredPartition {
  readonly row: PreparedBatchRows;
  readonly partition: BatchPartition;
  readonly window: FilteredWindow;
  readonly batch: PreparedBatch | undefined;
  readonly topology: GpuDrivenBatch;
}
export interface FilteredRow {
  headers?: FilteredTaskHeaders;
  readonly row: PreparedBatchRows;
  readonly bindings: ReadonlyMap<string, string> | undefined;
  readonly windowKeys: readonly string[];
  readonly topology: readonly GpuDrivenBatch[];
  readonly batches: readonly PreparedBatch[];
  seen: number;
}
export interface FilteredRowStage {
  readonly geometry: FilteredGeometry;
  readonly partitions: ReadonlyMap<string, FilteredPartition>;
  readonly row: FilteredRow;
  readonly projectedCandidates: number;
  readonly built: number;
  readonly reused: number;
}
export interface FilteredRowStorage {
  readonly geometry: FilteredGeometry | undefined;
  partition(key: string): FilteredPartition | undefined;
  window(key: string): FilteredWindow | undefined;
  allocate(previous: FilteredWindow | undefined, capacity: number, levels: number): FilteredWindow;
}

/** Ordinary duplicate observations can keep a published window after cache retirement. */
export function filteredWindowConflicts(window: FilteredWindow, plan: SubmissionPlan): boolean {
  for (const batch of plan.batches) {
    if (window.id === batch.batchId) return true;
    const levels = batchLodLevelCount(batch);
    const visibleStart = batch.visibleBase / 64;
    const visibleCount = ((batch.visibleAllocationCapacity ?? batch.visibleCapacity) / 64) * levels;
    const indirectStart = batch.indirectOffset / 20;
    if (
      overlaps(
        window.visibleStart,
        window.levelCapacity * window.levels,
        visibleStart,
        visibleCount,
      ) ||
      overlaps(window.indirectStart, window.levels, indirectStart, levels)
    )
      return true;
  }
  return false;
}

function overlaps(start: number, count: number, other: number, otherCount: number): boolean {
  return start < other + otherCount && other < start + count;
}

/** Pure row assembly around owner-issued provisional windows; it publishes no maps. */
export function stageFilteredRow(
  row: PreparedBatchRows,
  bindings: ReadonlyMap<string, string> | undefined,
  storage: FilteredRowStorage,
): FilteredRowStage {
  const source = row.source;
  const retained = storage.geometry;
  const reuse =
    retained !== undefined &&
    MemberCandidates.is(source.candidates) &&
    retained.source.generation === source.generation &&
    retained.source.members === source.members &&
    retained.source.candidates === source.candidates &&
    retained.source.binding === source.binding &&
    retained.bindings === bindings;
  const geometry = reuse
    ? retained
    : { source, partitions: partitionBatch(source, bindings), bindings };
  const partitions = new Map<string, FilteredPartition>();
  const topology: GpuDrivenBatch[] = [];
  const batches: PreparedBatch[] = [];
  let built = 0;
  let reused = 0;
  for (const partition of geometry.partitions) {
    const key = `${source.batchId}:${partition.key}`;
    const group = groupForPartition(row, partition);
    const lod = group?.lod ?? row.lod;
    const levels = batchLodLevelCount({ ...(lod === undefined ? {} : { lod }) });
    const capacity = Math.max(1, Math.ceil(partition.candidates.length / 64));
    const previous = storage.window(key);
    const window = windowFits(previous, source.generation, capacity, levels)
      ? previous
      : storage.allocate(previous, capacity, levels);
    const previousPartition = storage.partition(key);
    let projected: FilteredPartition;
    if (
      previousPartition?.row === row &&
      previousPartition.partition === partition &&
      previousPartition.window === window
    ) {
      projected = previousPartition;
      reused++;
    } else {
      projected = projectPartition(row, partition, window, group, lod);
      built++;
    }
    partitions.set(key, projected);
    topology.push(projected.topology);
    if (projected.batch !== undefined) batches.push(projected.batch);
  }
  return {
    geometry,
    partitions,
    row: { row, bindings, windowKeys: [...partitions.keys()], topology, batches, seen: 0 },
    projectedCandidates: reuse || bindings === undefined ? 0 : source.candidates.length,
    built,
    reused,
  };
}

function windowFits(
  window: FilteredWindow | undefined,
  generation: number,
  capacity: number,
  levels: number,
): window is FilteredWindow {
  return (
    window !== undefined &&
    window.sourceGeneration === generation &&
    window.levelCapacity >= capacity &&
    window.levelCapacity <= capacity * 4 &&
    window.levels === levels
  );
}

function projectPartition(
  row: PreparedBatchRows,
  partition: BatchPartition,
  window: FilteredWindow,
  group: ReturnType<typeof groupForPartition>,
  lod: PreparedBatchRows['lod'],
): FilteredPartition {
  const allocation = {
    batchId: window.id,
    generation: window.generation,
    visibleBase: window.visibleStart * 64,
    visibleAllocationCapacity: window.levelCapacity * 64,
    indirectOffset: window.indirectStart * 20,
  };
  const batch = group === undefined ? undefined : assembleFilteredBatch({ ...group, allocation });
  const { lod: _borrowedLod, ...sourceFacts } = row.source;
  const topology =
    batch?.batch ??
    Object.freeze({
      ...sourceFacts,
      ...allocation,
      candidates: partition.candidates,
      ...(partition.members === undefined ? {} : { members: partition.members }),
      visibleCapacity: 0,
      materialAddress: 0,
      ...(lod === undefined ? {} : { lod }),
    });
  return { row, partition, window, batch, topology };
}
