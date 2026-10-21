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
      const liveSources = new Set<number>();
      const liveWindows = new Set<string>();
      const batches: PreparedBatch[] = [];
      const topology: GpuDrivenBatch[] = [];
      let fixedCandidates = true;
      for (const row of prepared.batchRows) {
        const source = row.source;
        liveSources.add(source.batchId);
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
          liveWindows.add(key);
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
          fixedCandidates &&= MemberCandidates.is(cached.topology.candidates);
          if (cached.batch !== undefined) batches.push(cached.batch);
        }
      }
      for (const id of this.geometry.keys()) if (!liveSources.has(id)) this.geometry.delete(id);
      for (const [key, window] of this.windows)
        if (!liveWindows.has(key)) {
          this.visibleRanges.release(window.visibleStart, window.levelCapacity * window.levels);
          this.indirectRanges.release(window.indirectStart, window.levels);
          this.freeIds.push(window.id);
          this.windows.delete(key);
          this.prepared.delete(key);
        }
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
