import {
  type CompiledRenderGraph,
  compiledRenderGraphAllocation,
  compiledRenderGraphGeneration,
  observeCompiledRenderGraphAllocations,
  type RenderGraphGenerationAllocationEntry,
  type RenderGraphGenerationAllocationInspection,
} from '@forgeax/engine-render-graph';
import type { RenderPipelineFrame } from '../render-pipeline';
import type { RenderFrameState } from './frame-snapshot';

type Graph = CompiledRenderGraph<RenderPipelineFrame>;
type GraphGenerationRole = 'active' | 'candidate' | 'retiring';
type GraphGenerationStatus = 'active' | 'retiring' | 'failed';

interface GraphGenerationAllocationRecord {
  readonly graph: Graph;
  readonly observed: boolean;
  status: GraphGenerationStatus;
}

/** Retained physical handles from this View, including candidates and retiring bindings. */
class GraphGenerationAllocationOwner {
  readonly records = new Map<Graph, GraphGenerationAllocationRecord>();
  private readonly physical = new Map<object, { bytes: number; references: number }>();
  private bytes = 0;
  private unobserved = 0;
  peakBytes = 0;

  retain(handle: object, bytes: number): void {
    const allocation = this.physical.get(handle);
    if (allocation === undefined) {
      this.physical.set(handle, { bytes, references: 1 });
      this.bytes += bytes;
    } else {
      allocation.references += 1;
    }
  }

  release(handle: object): void {
    const allocation = this.physical.get(handle);
    if (allocation === undefined) return;
    allocation.references -= 1;
    if (allocation.references !== 0) return;
    this.physical.delete(handle);
    this.bytes -= allocation.bytes;
  }

  track(graph: Graph): GraphGenerationAllocationRecord {
    const existing = this.records.get(graph);
    if (existing !== undefined) return existing;
    const observed = observeCompiledRenderGraphAllocations(graph, this);
    const record: GraphGenerationAllocationRecord = { graph, observed, status: 'active' };
    this.records.set(graph, record);
    if (!observed) this.unobserved += 1;
    // External Graph implementations expose snapshots, without physical handle events.
    const held = this.unobserved === 0 ? this.bytes : this.reportedBytes();
    this.peakBytes = Math.max(this.peakBytes, held);
    return record;
  }

  settled(graph: Graph, succeeded: boolean): void {
    const record = this.records.get(graph);
    if (record === undefined) return;
    if (succeeded) {
      this.records.delete(graph);
      if (!record.observed) this.unobserved -= 1;
    } else {
      record.status = 'failed';
    }
  }

  private reportedBytes(): number {
    const { liveBytes, pendingRetirementBytes } = graphGenerationAllocationTotals(
      this.records.values(),
    );
    return liveBytes + pendingRetirementBytes;
  }
}

const graphGenerationAllocationOwners = new WeakMap<
  RenderFrameState,
  GraphGenerationAllocationOwner
>();

function allocationOwner(frameState: RenderFrameState): GraphGenerationAllocationOwner {
  const existing = graphGenerationAllocationOwners.get(frameState);
  if (existing !== undefined) return existing;
  const created = new GraphGenerationAllocationOwner();
  graphGenerationAllocationOwners.set(frameState, created);
  return created;
}

function graphGenerationAllocationTotals(records: Iterable<GraphGenerationAllocationRecord>): {
  liveBytes: number;
  pendingRetirementBytes: number;
} {
  const physical = new Map<string, { bytes: number; live: boolean }>();
  let liveBytes = 0;
  let pendingRetirementBytes = 0;
  const add = (key: string | undefined, bytes: number, state: 'live' | 'pending-retirement') => {
    const live = state === 'live';
    if (key === undefined) {
      if (live) liveBytes += bytes;
      else pendingRetirementBytes += bytes;
    } else {
      const prior = physical.get(key);
      if (prior === undefined) physical.set(key, { bytes, live });
      else {
        prior.bytes = bytes;
        prior.live ||= live;
      }
    }
  };
  for (const { graph } of records) compiledRenderGraphAllocation(graph, add);
  for (const allocation of physical.values()) {
    if (allocation.live) liveBytes += allocation.bytes;
    else pendingRetirementBytes += allocation.bytes;
  }
  return { liveBytes, pendingRetirementBytes };
}

export function trackGraphGeneration(frameState: RenderFrameState, graph: Graph): void {
  allocationOwner(frameState).track(graph);
}

export function setGraphGenerationRetiring(frameState: RenderFrameState, graph: Graph): void {
  const record = allocationOwner(frameState).track(graph);
  if (record.status !== 'failed') record.status = 'retiring';
}

export function setGraphGenerationRetirementResult(
  frameState: RenderFrameState,
  graph: Graph,
  succeeded: boolean,
): void {
  allocationOwner(frameState).settled(graph, succeeded);
}

/**
 * Project the actual RenderSystem graph-generation owners as one detached
 * allocation receipt. The candidate and fallback graph can overlap before a
 * submit settles; failed retirement stays visible until the frame owner is
 * discarded instead of disappearing with the asynchronous Set entry.
 */
export function inspectRenderGraphGenerationAllocation(
  frameState: RenderFrameState,
): RenderGraphGenerationAllocationInspection {
  const rolesByGraph = new Map<
    CompiledRenderGraph<RenderPipelineFrame>,
    Set<GraphGenerationRole>
  >();
  const add = (
    graph: CompiledRenderGraph<RenderPipelineFrame> | null | undefined,
    role: GraphGenerationRole,
  ) => {
    if (graph === null || graph === undefined) return;
    const roles = rolesByGraph.get(graph);
    if (roles === undefined) rolesByGraph.set(graph, new Set([role]));
    else roles.add(role);
  };
  add(frameState.compiledFrameGraph?.graph, 'active');
  add(frameState.compiledFrameGraphCandidate?.installed.graph, 'candidate');
  add(frameState.compiledFrameGraphCandidate?.previous.installed?.graph, 'retiring');
  for (const graph of frameState.retiredCompiledFrameGraphs) add(graph, 'retiring');

  const owner = allocationOwner(frameState);
  const entries: RenderGraphGenerationAllocationEntry[] = [];
  let unavailableGenerationCount = 0;
  for (const [graph, record] of owner.records) {
    const roles = rolesByGraph.get(graph) ?? new Set<GraphGenerationRole>();
    if (record.status === 'retiring' || record.status === 'failed') roles.add('retiring');
    if (roles.size === 0) {
      // A candidate can be detached from the active state's role fields while
      // it is still being prepared. Keep its owner record observable until
      // the publication or cleanup event settles it.
      roles.add(record.status === 'active' ? 'active' : 'retiring');
    }
    const allocation = compiledRenderGraphAllocation(graph);
    if (allocation === undefined) {
      unavailableGenerationCount += 1;
      continue;
    }
    const retirement =
      record.status === 'failed' ? 'failed' : roles.has('retiring') ? 'pending' : 'active';
    entries.push({
      generation: compiledRenderGraphGeneration(graph),
      roles: Object.freeze([...roles]),
      retirement,
      allocation,
    });
  }
  entries.sort((left, right) => left.generation - right.generation);
  const { liveBytes, pendingRetirementBytes } = graphGenerationAllocationTotals(
    owner.records.values(),
  );
  const peakBytes = Math.max(owner.peakBytes, liveBytes + pendingRetirementBytes);
  const failedEntries = entries.filter((entry) => entry.retirement === 'failed');
  const failedAllocation = graphGenerationAllocationTotals(
    [...owner.records.values()].filter((record) => record.status === 'failed'),
  );
  return Object.freeze({
    unit: 'engine-allocation-bytes',
    physicalResidency: 'unknown',
    availability:
      entries.length === 0
        ? unavailableGenerationCount === 0
          ? 'complete'
          : 'unavailable'
        : unavailableGenerationCount === 0
          ? 'complete'
          : 'partial',
    unavailableGenerationCount,
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
    liveBytes,
    pendingRetirementBytes,
    peakBytes,
    failedRetirementCount: failedEntries.length,
    failedRetirementBytes: failedAllocation.liveBytes + failedAllocation.pendingRetirementBytes,
  });
}
