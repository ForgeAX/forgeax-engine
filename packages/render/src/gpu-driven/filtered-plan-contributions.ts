import { SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import { StableRangeAllocator } from '../stable-range-allocator';
import { batchLodLevelCount, type GpuDrivenCandidate } from './batch-topology';
import {
  assembleFilteredBatch,
  assembleFilteredGroups,
  buildFilteredGroups,
  type FilteredGroup,
  type FilteredProductionPlan,
  filteredPlan,
  type PreparedBatch,
  type PreparedBatchRows,
  type PreparedProductionPlan,
} from './production-raster-prepare';
import type { ShadowClaimTable } from './shadow-claims';

type ProfilePart = <T>(part: 'groups' | 'group-key' | 'batches', action: () => T) => T;
interface Contribution {
  readonly row: PreparedBatchRows;
  immutableTopology: boolean | undefined;
  readonly groups: ReadonlyMap<string, FilteredGroup>;
  readonly shadowDrawKeys: ReadonlySet<string>;
  readonly bindingReads: ReadonlyMap<string, string>;
}
// Material ABI visible rows are vec4<u32>: 16 rows meet the portable 256-byte
// binding-offset boundary. Canonical topology keeps its legacy 64-row alignment.
interface WindowAllocation {
  readonly batchId: number;
  readonly generation: number;
  visibleStart: number;
  levelCapacity: number;
  indirectStart: number;
  levels: number;
}
interface MergedCandidates {
  group: FilteredGroup | undefined;
  batch: PreparedBatch | undefined;
  immutableTopology: boolean | undefined;
  allocation: WindowAllocation | undefined;
  readonly parts: readonly FilteredGroup[];
  readonly candidates: readonly GpuDrivenCandidate[];
}

/** Record-owner cache of immutable batch facts, never camera admission or GPU resources. */
export class FilteredPlanContributionOwner {
  private readonly contributions = new Map<number, Contribution>();
  private readonly merged = new Map<string, MergedCandidates>();
  private publication:
    | {
        readonly order: readonly number[];
        readonly rows: readonly PreparedBatchRows[];
        readonly value: FilteredProductionPlan;
      }
    | undefined;
  private readonly visibleRanges = new StableRangeAllocator();
  private readonly indirectRanges = new StableRangeAllocator();
  private readonly freeIds: number[] = [];
  private nextId = 0;
  private generation = 0;
  readonly windowCounters = { relocations: 0, compactions: 0 };
  readonly assemblyCounters = {
    publicationHits: 0,
    batchHits: 0,
    batchBuilds: 0,
    churnFallbacks: 0,
  };
  private scope: string | undefined;
  private worlds: readonly number[] | undefined;
  private shadowClaims: ShadowClaimTable | undefined;
  private bindingsProvided = false;
  lastWork = { projectedBatches: 0, projectedCandidates: 0, copiedCandidates: 0, reusedGroups: 0 };

  clear(): void {
    this.contributions.clear();
    this.merged.clear();
    this.publication = undefined;
    this.visibleRanges.reset();
    this.indirectRanges.reset();
    this.freeIds.length = 0;
    this.nextId = 0;
    this.scope = undefined;
    this.worlds = undefined;
    this.shadowClaims = undefined;
    this.bindingsProvided = false;
  }

  update(
    prepared: PreparedProductionPlan,
    // This is a CURRENT computed value fence, not artifact/wrapper identity.
    // The caller owns immutable batch facts and the current binding/claim publication.
    scope: string | undefined,
    shadowClaims?: ShadowClaimTable,
    bindings?: ReadonlyMap<string, string>,
    profilePart?: ProfilePart,
  ): FilteredProductionPlan {
    const previousOrder = this.publication?.order;
    this.lastWork = {
      projectedBatches: 0,
      projectedCandidates: 0,
      copiedCandidates: 0,
      reusedGroups: 0,
    };
    const ids =
      scope !== undefined && this.publication?.rows === prepared.batchRows
        ? undefined
        : new Set(prepared.batchRows.map((row) => row.source.batchId));
    // Unsupported authority or duplicate source IDs use the full reference.
    if (scope === undefined || (ids !== undefined && ids.size !== prepared.batchRows.length)) {
      this.clear();
      this.lastWork.projectedBatches = prepared.batchRows.length;
      this.lastWork.projectedCandidates = prepared.source.candidateCount;
      const result = filteredPlan(prepared, shadowClaims, bindings, profilePart);
      this.assemblyCounters.batchBuilds += result.batches.length;
      return result;
    }
    if (
      this.scope !== scope ||
      this.worlds !== prepared.worldKeys ||
      (this.shadowClaims !== undefined) !== (shadowClaims !== undefined) ||
      this.bindingsProvided !== (bindings !== undefined)
    ) {
      this.clear();
      this.scope = scope;
      this.worlds = prepared.worldKeys;
      this.bindingsProvided = bindings !== undefined;
    }
    // Retire before projection so a failed attempt cannot retain IDs from older owners.
    if (ids !== undefined)
      for (const id of this.contributions.keys()) if (!ids.has(id)) this.contributions.delete(id);
    const gather = () => {
      const cold = this.contributions.size === 0;
      let changedContributions = 0;
      let unchanged = this.publication?.order.length === prepared.batchRows.length;
      for (let index = 0; index < prepared.batchRows.length; index++) {
        const row = prepared.batchRows[index];
        if (row === undefined) continue;
        const id = row.source.batchId;
        const cached = this.contributions.get(id);
        if (this.publication?.order[index] !== id) unchanged = false;
        if (
          cached === undefined ||
          !sameContribution(cached.row, row) ||
          !sameBindings(cached.bindingReads, bindings) ||
          !sameShadowClaims(row, this.shadowClaims, shadowClaims)
        ) {
          const bindingReads = new Map<string, string>();
          const projected = buildFilteredGroups(
            [row],
            shadowClaims,
            bindings,
            profilePart === undefined
              ? undefined
              : (part, action) => (part === 'group-key' ? profilePart(part, action) : action()),
            bindingReads,
          );
          this.contributions.set(id, {
            row,
            ...projected,
            bindingReads,
            immutableTopology: undefined,
          });
          changedContributions++;
          this.lastWork.projectedBatches++;
          this.lastWork.projectedCandidates += row.source.candidates.length;
          unchanged = false;
        }
      }
      if (unchanged) {
        this.assemblyCounters.publicationHits++;
        this.assemblyCounters.batchHits += this.merged.size;
        return undefined;
      }
      this.publication = undefined;
      const groups = new Map<string, FilteredGroup | FilteredGroup[]>();
      const shadowKeys = new Set<string>();
      for (const row of prepared.batchRows) {
        const contribution = this.contributions.get(row.source.batchId);
        if (contribution === undefined) throw Error('Missing admitted filtered contribution');
        for (const key of contribution.shadowDrawKeys) shadowKeys.add(key);
        for (const [key, fragment] of contribution.groups) {
          const group = groups.get(key);
          if (group === undefined) groups.set(key, fragment);
          else if (Array.isArray(group)) group.push(fragment);
          else groups.set(key, [group, fragment]);
        }
      }
      // High churn uses complete assembly without certification or batch memo work.
      const retainAssembly = cold || changedContributions <= prepared.batchRows.length / 2;
      if (!retainAssembly) {
        this.assemblyCounters.churnFallbacks++;
        for (const entry of this.merged.values()) {
          entry.batch = undefined;
          entry.group = undefined;
        }
      }
      for (const [key, merged] of this.merged)
        if (!groups.has(key)) {
          const allocation = merged.allocation;
          if (allocation !== undefined) {
            this.visibleRanges.release(
              allocation.visibleStart,
              allocation.levelCapacity * allocation.levels,
            );
            this.indirectRanges.release(allocation.indirectStart, allocation.levels);
            this.freeIds.push(allocation.batchId);
          }
          this.merged.delete(key);
        }
      const values: FilteredGroup[] = [];
      const entries: MergedCandidates[] = [];
      for (const [key, group] of groups) {
        const cached = this.merged.get(key);
        const multiple = Array.isArray(group);
        const first = multiple ? group[0] : group;
        if (first === undefined) throw Error('Missing filtered group contribution');
        let candidates: readonly GpuDrivenCandidate[];
        if (
          cached !== undefined &&
          (multiple
            ? cached.parts.length === group.length &&
              group.every((part, index) => part === cached.parts[index])
            : cached.parts.length === 1 && cached.parts[0] === first)
        ) {
          candidates = cached.candidates;
          this.lastWork.reusedGroups++;
          if (retainAssembly && cached.group !== undefined) {
            cached.immutableTopology ??= immutableTopology(first, candidates);
          }
          if (retainAssembly && cached.group !== undefined && cached.immutableTopology) {
            entries.push(cached);
            values.push(cached.group);
            continue;
          }
        } else {
          candidates = !multiple
            ? first.candidates
            : Object.freeze(group.flatMap((part) => part.candidates));
          this.lastWork.copiedCandidates += !multiple ? 0 : candidates.length;
          this.merged.set(key, {
            parts: Object.freeze(multiple ? group : [first]),
            candidates,
            allocation: cached?.allocation,
            group: undefined,
            batch: undefined,
            immutableTopology: undefined,
          });
        }
        // The first canonical fragment owns mesh/receipt/representative metadata.
        const merged = this.merged.get(key);
        if (merged === undefined) throw Error('Missing merged filtered contribution');
        const levels = batchLodLevelCount({
          ...(first.lod === undefined ? {} : { lod: first.lod }),
        });
        const required = 2 ** Math.ceil(Math.log2(Math.max(1, Math.ceil(candidates.length / 16))));
        const old = merged.allocation;
        if (
          old === undefined ||
          old.levelCapacity < required ||
          old.levelCapacity > required * 4 ||
          old.levels !== levels
        ) {
          if (old !== undefined) {
            this.visibleRanges.release(old.visibleStart, old.levelCapacity * old.levels);
            this.windowCounters.relocations++;
          }
          const indirectStart =
            old?.levels === levels ? old.indirectStart : this.indirectRanges.allocate(levels);
          if (old !== undefined && old.levels !== levels)
            this.indirectRanges.release(old.indirectStart, old.levels);
          merged.allocation = {
            batchId: old?.batchId ?? this.freeIds.pop() ?? this.nextId++,
            generation: old?.generation ?? ++this.generation,
            visibleStart: this.visibleRanges.allocate(required * levels),
            levelCapacity: required,
            indirectStart,
            levels,
          };
        }
        const allocation = merged.allocation;
        if (allocation === undefined) throw Error('Missing filtered window allocation');
        merged.group = {
          ...first,
          candidates,
          allocation: {
            batchId: allocation.batchId,
            generation: allocation.generation,
            visibleBase: allocation.visibleStart * 16,
            visibleAllocationCapacity: allocation.levelCapacity * 16,
            indirectOffset: allocation.indirectStart * 20,
          },
        };
        merged.batch = undefined;
        entries.push(merged);
        values.push(merged.group);
      }
      const visibleLive = [...this.merged.values()].reduce(
        (sum, entry) =>
          sum +
          (entry.allocation === undefined
            ? 0
            : entry.allocation.levelCapacity * entry.allocation.levels),
        0,
      );
      const indirectLive = [...this.merged.values()].reduce(
        (sum, entry) => sum + (entry.allocation?.levels ?? 0),
        0,
      );
      if (
        this.visibleRanges.requiredCapacity() > Math.max(16, visibleLive * 2) ||
        this.indirectRanges.requiredCapacity() > Math.max(16, indirectLive * 2)
      ) {
        this.visibleRanges.reset();
        this.indirectRanges.reset();
        this.windowCounters.compactions++;
        const allocationsById = new Map(
          [...this.merged.values()].map((entry) => [entry.allocation?.batchId, entry]),
        );
        values.forEach((group, index) => {
          const allocation = group.allocation;
          if (allocation === undefined) throw Error('Missing published window allocation');
          const levels = batchLodLevelCount({
            ...(group.lod === undefined ? {} : { lod: group.lod }),
          });
          const visibleStart = this.visibleRanges.allocate(
            (allocation.visibleAllocationCapacity / 16) * levels,
          );
          const indirectStart = this.indirectRanges.allocate(levels);
          const retained = allocationsById.get(allocation.batchId);
          if (retained?.allocation === undefined)
            throw Error('Missing compacted filtered allocation');
          retained.allocation.visibleStart = visibleStart;
          retained.allocation.indirectStart = indirectStart;
          retained.batch = undefined;
          retained.group = {
            ...group,
            allocation: {
              ...allocation,
              visibleBase: visibleStart * 16,
              indirectOffset: indirectStart * 20,
            },
          };
          values[index] = retained.group;
        });
      }
      const batches = retainAssembly
        ? values.map((group, index) => {
            const entry = entries[index];
            if (entry === undefined) throw Error('Missing filtered assembly owner');
            if (entry.batch === undefined) {
              entry.batch = assembleFilteredBatch(group, prepared.worldKeys);
              this.assemblyCounters.batchBuilds++;
            } else this.assemblyCounters.batchHits++;
            return entry.batch;
          })
        : undefined;
      if (!retainAssembly) this.assemblyCounters.batchBuilds += values.length;
      return { values, shadowKeys, batches, entries, retainAssembly };
    };
    try {
      const gathered = profilePart === undefined ? gather() : profilePart('groups', gather);
      let result: FilteredProductionPlan;
      if (gathered === undefined) {
        const previous = this.publication?.value;
        if (previous === undefined) throw Error('Missing admitted filtered publication');
        this.lastWork.reusedGroups = this.merged.size;
        const drawKeys = shadowClaims === undefined ? prepared.drawKeys : previous.drawKeys;
        const plan =
          previous.plan.revision === prepared.source.revision
            ? previous.plan
            : Object.freeze({ ...previous.plan, revision: prepared.source.revision });
        result =
          plan === previous.plan && drawKeys === previous.drawKeys
            ? previous
            : { ...previous, plan, drawKeys };
      } else {
        result = assembleFilteredGroups(
          prepared.source,
          prepared.worldKeys,
          shadowClaims === undefined ? prepared.drawKeys : new Set<string>(),
          gathered.shadowKeys,
          gathered.values,
          profilePart,
          gathered.batches,
        );
        if (gathered.retainAssembly) {
          gathered.entries.forEach((entry, index) => {
            entry.batch = result.batches[index];
          });
        }
      }
      // The accepted publication remains the scope authority through churn;
      // only speculative per-batch assembly memos are retired above.
      this.publication = {
        order:
          gathered === undefined && previousOrder !== undefined
            ? previousOrder
            : prepared.batchRows.map((row) => row.source.batchId),
        rows: prepared.batchRows,
        value: result,
      };
      this.shadowClaims = shadowClaims;
      return result;
    } catch (error) {
      // A partial attempt publishes no plan and owns no reusable contribution.
      this.clear();
      throw error;
    }
  }
}

function sameShadowClaims(
  row: PreparedBatchRows,
  previous: ShadowClaimTable | undefined,
  current: ShadowClaimTable | undefined,
): boolean {
  if (previous === current) return true;
  if (previous === undefined || current === undefined) return false;
  // Facts contain one entry per primitive/draw, including unclaimed draws.
  // Instance ordinals cannot change claim admission or the projection key.
  for (const draws of row.facts.values()) {
    for (const [drawItemIndex, fact] of draws) {
      if (fact === undefined) continue;
      const candidate = { drawItemIndex };
      const before = previous.claim(fact.slot, candidate);
      const after = current.claim(fact.slot, candidate);
      if (before.compatible !== after.compatible) return false;
      if (!before.compatible) continue;
      // An admitted claim owns exactly one key. Its state separates groups,
      // and a custom ShadowCaster entry disables Standard LOD crossfade.
      if (before.keys[0] !== after.keys[0]) return false;
      const beforeEntry = before.entry;
      const afterEntry = after.entry;
      if (
        (beforeEntry === undefined || beforeEntry.materialShaderId === SHADOW_CASTER_SHADER_ID) !==
        (afterEntry === undefined || afterEntry.materialShaderId === SHADOW_CASTER_SHADER_ID)
      )
        return false;
      if (
        beforeEntry?.renderState !== afterEntry?.renderState &&
        JSON.stringify(beforeEntry?.renderState) !== JSON.stringify(afterEntry?.renderState)
      )
        return false;
    }
  }
  return true;
}

function sameContribution(previous: PreparedBatchRows, next: PreparedBatchRows): boolean {
  return (
    previous.source.generation === next.source.generation &&
    previous.source.contentEpoch === next.source.contentEpoch &&
    previous.source.key === next.source.key &&
    previous.source.prepared === next.source.prepared &&
    previous.source.candidates === next.source.candidates &&
    previous.facts === next.facts &&
    previous.draws === next.draws
  );
}

function sameBindings(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string> | undefined,
): boolean {
  for (const [key, value] of previous) if ((current?.get(key) ?? '') !== value) return false;
  return true;
}

// Only owned frozen table facts can intern a plan identity. Borrowed readonly
// records may change in place and must reach the topology encoder each time.
function immutableTopology(
  group: FilteredGroup,
  candidates: readonly GpuDrivenCandidate[],
): boolean {
  const source = group.source;
  if (
    !frozenDataObject(source) ||
    !frozenDataObject(source.key) ||
    !frozenDataObject(source.candidates) ||
    !frozenDataObject(candidates)
  )
    return false;
  for (let index = 0; index < candidates.length; index++) {
    if (!frozenDataObject(candidates[index])) return false;
  }
  const prepared = source.prepared;
  if (
    prepared !== undefined &&
    (!frozenDataObject(prepared) || !frozenDataObject(prepared.identity))
  )
    return false;
  const lod = group.lod;
  if (lod === undefined) return true;
  if (!frozenDataObject(lod) || !frozenDataObject(lod.coverages)) return false;
  const ranges = lod.ranges;
  if (ranges === undefined) return true;
  if (!frozenDataObject(ranges)) return false;
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index];
    if (range !== undefined && !frozenDataObject(range)) return false;
  }
  return true;
}

/** Frozen accessors still observe callers; certification must not invoke them. */
function frozenDataObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  const keys = Reflect.ownKeys(value);
  if (array) {
    // Dense ordinary arrays only: no holes, index accessors or method overrides.
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || !('value' in descriptor)) return false;
    }
  } else {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) return false;
    }
  }
  return true;
}
