import { StableRangeAllocator } from '../stable-range-allocator';
import { batchLodLevelCount } from './batch-layout';
import { MemberCandidates } from './batch-members';
import type { GpuDrivenBatch } from './batch-topology';
import {
  assembleFilteredBatch,
  assembleFilteredGroups,
  type BatchPartition,
  type FilteredProductionPlan,
  groupForPartition,
  type PreparedBatch,
  type PreparedBatchRows,
  type PreparedProductionPlan,
  partitionBatch,
} from './production-raster-prepare';

type ProfilePart = <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => T;
interface Window {
  readonly id: number;
  readonly generation: number;
  readonly sourceGeneration: number;
  readonly visibleStart: number;
  readonly levelCapacity: number;
  readonly indirectStart: number;
  readonly levels: number;
}
interface GeometryPartition {
  readonly source: GpuDrivenBatch;
  readonly partitions: readonly BatchPartition[];
  readonly bindings: ReadonlyMap<string, string> | undefined;
}

/** Object binding partitions survive every material and residency edit. */
export class FilteredPlanContributionOwner {
  private readonly geometry = new Map<number, GeometryPartition>();
  private readonly windows = new Map<string, Window>();
  private readonly prepared = new Map<
    string,
    {
      row: PreparedBatchRows;
      partition: BatchPartition;
      window: Window;
      batch: PreparedBatch | undefined;
      topology: GpuDrivenBatch;
    }
  >();
  /**
   * One row's complete projection. An identical prepared row with the same object
   * bindings selects the same partitions, windows and assembled batches, so a
   * retained row publishes its last outputs without recomputing any key.
   */
  private readonly rows = new Map<
    number,
    {
      readonly row: PreparedBatchRows;
      readonly bindings: ReadonlyMap<string, string> | undefined;
      readonly windowKeys: readonly string[];
      readonly topology: readonly GpuDrivenBatch[];
      readonly batches: readonly PreparedBatch[];
      seen: number;
    }
  >();
  private pass = 0;
  private readonly visibleRanges = new StableRangeAllocator();
  private readonly indirectRanges = new StableRangeAllocator();
  private nextId = 0;
  private readonly freeIds: number[] = [];
  private generation = 0;
  private publication: FilteredProductionPlan | undefined;
  readonly windowCounters = { relocations: 0, compactions: 0 };
  readonly assemblyCounters = {
    publicationHits: 0,
    batchHits: 0,
    batchBuilds: 0,
    churnFallbacks: 0,
  };
  lastWork = { projectedBatches: 0, projectedCandidates: 0, copiedCandidates: 0, reusedGroups: 0 };

  clear(): void {
    this.geometry.clear();
    this.windows.clear();
    this.prepared.clear();
    this.rows.clear();
    this.visibleRanges.reset();
    this.indirectRanges.reset();
    this.nextId = 0;
    this.freeIds.length = 0;
    this.publication = undefined;
  }

  update(
    prepared: PreparedProductionPlan,
    bindings?: ReadonlyMap<string, string>,
    profile?: ProfilePart,
  ): FilteredProductionPlan {
    this.lastWork = {
      projectedBatches: 0,
      projectedCandidates: 0,
      copiedCandidates: 0,
      reusedGroups: 0,
    };
    const objectBindings = bindings?.size === 0 ? undefined : bindings;
    const build = () => {
      const pass = ++this.pass;
      // Window keys are owned by one source batch; only rows that dropped or
      // retired a key can release a window. Duplicate rows fall back to a scan.
      const releasedWindows: string[] = [];
      let scanWindows = false;
      const batches: PreparedBatch[] = [];
      const topology: GpuDrivenBatch[] = [];
      let fixedCandidates = true;
      let seenRows = 0;
      for (const row of prepared.batchRows) {
        const source = row.source;
        const retainedRow = this.rows.get(source.batchId);
        if (
          retainedRow !== undefined &&
          retainedRow.row === row &&
          retainedRow.bindings === objectBindings &&
          retainedRow.seen !== pass
        ) {
          retainedRow.seen = pass;
          seenRows++;
          for (const batch of retainedRow.topology) {
            topology.push(batch);
            fixedCandidates &&= MemberCandidates.is(batch.candidates);
          }
          for (const batch of retainedRow.batches) batches.push(batch);
          this.assemblyCounters.batchHits += retainedRow.topology.length;
          this.lastWork.reusedGroups += retainedRow.topology.length;
          continue;
        }
        const rowWindowKeys: string[] = [];
        const rowTopology: GpuDrivenBatch[] = [];
        const rowBatches: PreparedBatch[] = [];
        let geometry = this.geometry.get(source.batchId);
        if (
          geometry === undefined ||
          !MemberCandidates.is(source.candidates) ||
          geometry.source.generation !== source.generation ||
          geometry.source.members !== source.members ||
          geometry.source.candidates !== source.candidates ||
          geometry.source.binding !== source.binding ||
          geometry.bindings !== objectBindings
        ) {
          geometry = {
            source,
            partitions: partitionBatch(source, objectBindings),
            bindings: objectBindings,
          };
          this.geometry.set(source.batchId, geometry);
          this.lastWork.projectedCandidates +=
            objectBindings === undefined ? 0 : source.candidates.length;
        }
        for (const partition of geometry.partitions) {
          const group = groupForPartition(row, partition);
          const key = `${source.batchId}:${partition.key}`;
          // Geometry windows stay allocated while a Pass temporarily selects the direct lane.
          rowWindowKeys.push(key);
          const lod = group?.lod ?? row.lod;
          const levels = batchLodLevelCount({ ...(lod === undefined ? {} : { lod }) });
          const capacity =
            2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(partition.candidates.length / 64))));
          let window = this.windows.get(key);
          if (
            window === undefined ||
            window.sourceGeneration !== source.generation ||
            window.levelCapacity < capacity ||
            window.levelCapacity > capacity * 4 ||
            window.levels !== levels
          ) {
            if (window !== undefined) {
              this.visibleRanges.release(window.visibleStart, window.levelCapacity * window.levels);
              this.indirectRanges.release(window.indirectStart, window.levels);
              this.windowCounters.relocations++;
            }
            window = {
              id: window?.id ?? this.freeIds.pop() ?? this.nextId++,
              sourceGeneration: source.generation,
              generation: ++this.generation,
              visibleStart: this.visibleRanges.allocate(capacity * levels),
              levelCapacity: capacity,
              indirectStart: this.indirectRanges.allocate(levels),
              levels,
            };
            this.windows.set(key, window);
          }
          let cached = this.prepared.get(key);
          if (cached?.row !== row || cached.partition !== partition || cached.window !== window) {
            const allocation = {
              batchId: window.id,
              generation: window.generation,
              visibleBase: window.visibleStart * 64,
              visibleAllocationCapacity: window.levelCapacity * 64,
              indirectOffset: window.indirectStart * 20,
            };
            const batch =
              group === undefined ? undefined : assembleFilteredBatch({ ...group, allocation });
            const { lod: _borrowedLod, ...sourceFacts } = source;
            const projected =
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
            cached = { row, partition, window, batch, topology: projected };
            this.prepared.set(key, cached);
            this.assemblyCounters.batchBuilds++;
            this.lastWork.projectedBatches++;
          } else {
            this.assemblyCounters.batchHits++;
            this.lastWork.reusedGroups++;
          }
          topology.push(cached.topology);
          rowTopology.push(cached.topology);
          fixedCandidates &&= MemberCandidates.is(cached.topology.candidates);
          if (cached.batch !== undefined) {
            batches.push(cached.batch);
            rowBatches.push(cached.batch);
          }
        }
        if (retainedRow !== undefined && retainedRow.seen !== pass) {
          // A replaced row may retire partition windows its last projection owned.
          for (const key of retainedRow.windowKeys)
            if (!rowWindowKeys.includes(key)) releasedWindows.push(key);
        } else if (retainedRow !== undefined) scanWindows = true;
        if (retainedRow?.seen !== pass) seenRows++;
        this.rows.set(source.batchId, {
          row,
          bindings: objectBindings,
          windowKeys: rowWindowKeys,
          topology: rowTopology,
          batches: rowBatches,
          seen: pass,
        });
      }
      // Retired rows release their geometry, windows and assembled batches.
      // Every retained row was seen when the counts agree.
      if (this.rows.size !== seenRows)
        for (const [id, retained] of this.rows) {
          if (retained.seen === pass) continue;
          this.rows.delete(id);
          this.geometry.delete(id);
          for (const key of retained.windowKeys) releasedWindows.push(key);
        }
      const releaseWindow = (key: string) => {
        const window = this.windows.get(key);
        if (window === undefined) return;
        this.visibleRanges.release(window.visibleStart, window.levelCapacity * window.levels);
        this.indirectRanges.release(window.indirectStart, window.levels);
        this.freeIds.push(window.id);
        this.windows.delete(key);
        this.prepared.delete(key);
      };
      if (scanWindows) {
        const liveWindows = new Set<string>();
        for (const retained of this.rows.values())
          for (const key of retained.windowKeys) liveWindows.add(key);
        for (const key of [...this.windows.keys()]) if (!liveWindows.has(key)) releaseWindow(key);
      } else for (const key of releasedWindows) releaseWindow(key);
      const previous = this.publication;
      if (
        previous !== undefined &&
        (previous.projectionSource !== undefined) === fixedCandidates &&
        previous.plan.revision === prepared.source.revision &&
        topology.length === previous.plan.batches.length &&
        topology.every((batch, index) => batch === previous.plan.batches.at(index))
      ) {
        this.assemblyCounters.publicationHits++;
        return previous;
      }
      const assembled = assembleFilteredGroups(prepared.source, batches, topology);
      const value: FilteredProductionPlan = fixedCandidates
        ? { ...assembled, projectionSource: assembled.plan }
        : assembled;
      this.publication = value;
      return value;
    };
    try {
      return profile === undefined ? build() : profile('batches', build);
    } catch (error) {
      this.clear();
      throw error;
    }
  }
}
