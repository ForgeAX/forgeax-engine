import { err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type { FrameList } from '../scene/frame-list';
import {
  batchLodLevelCount,
  batchVisibleSpan,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES as INDIRECT_COMMAND_BYTES,
} from './batch-layout';
import type { GpuDrivenCandidate, SubmissionPlan } from './batch-topology';

export interface GpuDrivenViewBufferCapacities {
  readonly candidate: number;
  readonly visible: number;
  readonly batch: number;
  readonly indirect: number;
}

export interface ViewBufferRequest<Name extends string> {
  readonly name: Name;
  readonly size: number;
  readonly usage: number;
  readonly storage: boolean;
}

export function validateViewBufferRequests(
  device: RhiDevice,
  requests: readonly ViewBufferRequest<string>[],
): Result<void, RhiError> {
  const maxBufferSize = Number(device.limits.maxBufferSize);
  const maxStorageBufferBindingSize = Number(device.limits.maxStorageBufferBindingSize);
  for (const request of requests) {
    const limit = request.storage ? maxStorageBufferBindingSize : maxBufferSize;
    if (!Number.isFinite(limit) || limit <= 0 || request.size <= limit) continue;
    return err(
      new RhiError({
        code: 'limit-exceeded',
        expected: `GPU-driven ${request.name} buffer (${request.size} B) fits within ${request.storage ? 'device.limits.maxStorageBufferBindingSize' : 'device.limits.maxBufferSize'} (${limit} B)`,
        hint: 'reduce the visible/candidate workload or split the GPU-driven buffer plan before retrying',
        detail: { maxStorageBufferBindingSize: limit, requestedBytes: request.size },
      }),
    );
  }
  return ok(undefined);
}

export function nextCapacity(required: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, required)));
}

/** Raster binds windows at 256-byte storage offsets: 64 visible entries. */
const VISIBLE_ALIGNMENT = 64;
const VISIBLE_GROWTH = 1.5;
/** First-allocation headroom: one small window relocation must not rebuild every binding. */
const VISIBLE_HEADROOM = 1.25;

function alignVisible(entries: number): number {
  return Math.ceil(Math.max(VISIBLE_ALIGNMENT, entries) / VISIBLE_ALIGNMENT) * VISIBLE_ALIGNMENT;
}

/**
 * Visible-index allocation for one view: the aligned requirement plus bounded
 * headroom on first allocation, then geometric growth, so a stable workload
 * never reallocates and a growing one reallocates amortized O(1) times. Slack
 * never exceeds what the device can bind; the requirement itself is never clamped.
 */
export function growGpuDrivenVisibleCapacity(
  current: number,
  required: number,
  maxEntries: number,
): number {
  const needed = alignVisible(required);
  if (needed <= current) return current;
  const grown = alignVisible(
    current === 0 ? Math.ceil(needed * VISIBLE_HEADROOM) : Math.ceil(current * VISIBLE_GROWTH),
  );
  const ceiling = Math.floor(Math.max(0, maxEntries) / VISIBLE_ALIGNMENT) * VISIBLE_ALIGNMENT;
  return Math.max(needed, Math.min(grown, ceiling));
}

/**
 * Derive each GPU-driven allocation from its own logical capacity domain.
 * Candidate records are dense; visible indices use the sparse, 64-entry
 * aligned ranges assigned by BatchTopology. Keeping these values separate is
 * what makes a large LOD candidate set bounded instead of multiplying the
 * candidate record and inline LOD-row buffers by the visible address space.
 */
export function deriveGpuDrivenViewBufferCapacities(
  plan: Pick<SubmissionPlan, 'candidateCount' | 'batches'>,
): GpuDrivenViewBufferCapacities {
  const cached = viewBufferCapacities.get(plan);
  if (cached !== undefined) return cached;
  const memberships = new Set<FrameList<GpuDrivenCandidate>>();
  let candidateCount = 0;
  let visible = 0;
  let indirect = 0;
  for (const batch of plan.batches) {
    const members = batch.candidates;
    if (!memberships.has(members)) {
      memberships.add(members);
      candidateCount += members.length;
    }
    // Derived from the batch segments the kernels address, so a plan whose
    // LOD chain grew never lets a level segment write past the buffer. Exact
    // (aligned): growth slack is the allocator's decision, bounded by limits.
    visible = Math.max(visible, batch.visibleBase + batchVisibleSpan(batch));
    indirect = Math.max(
      indirect,
      batch.indirectOffset / INDIRECT_COMMAND_BYTES + batchLodLevelCount(batch),
    );
  }
  const capacities = Object.freeze({
    candidate: nextCapacity(candidateCount),
    visible: alignVisible(visible),
    batch: nextCapacity(plan.batches.length),
    indirect: nextCapacity(indirect),
  });
  // Plans are immutable and shared by every view (cascade, layer) drawing them.
  viewBufferCapacities.set(plan, capacities);
  return capacities;
}
const viewBufferCapacities = new WeakMap<object, GpuDrivenViewBufferCapacities>();
