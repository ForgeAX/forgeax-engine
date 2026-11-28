import type { RhiDevice, Texture } from '@forgeax/engine-rhi';
import { AttachmentBindings } from './attachment-bindings.js';
import { allocationBytes } from './compiled-inspection.js';
import type { InheritedTextureRead } from './content-ranges.js';
import {
  type CompiledResource,
  type CompiledView,
  type GraphTextureAllocation,
  physicalAllocationKey,
  releaseGraphTexture,
} from './kernel-internal.js';
import type { RenderGraphFrame, RenderGraphResourceAllocationInspection } from './types.js';

type AllocationState = 'live' | 'pending-retirement';
export type AllocationVisitor = (
  key: string | undefined,
  bytes: number,
  state: AllocationState,
) => void;

/** Physical ownership events for a bound recording, before diagnostic key formatting. */
export interface GraphAllocationObserver {
  retain(handle: object, bytes: number): void;
  release(handle: object): void;
}

type ImportedSlot<Frame extends RenderGraphFrame> = Extract<
  CompiledResource<Frame>,
  { origin: 'imported' }
>;
type NativeInput<Frame extends RenderGraphFrame> = Extract<
  ImportedSlot<Frame>,
  { kind: 'texture' }
>;
type OwnedSlot<Frame extends RenderGraphFrame> = Extract<
  CompiledResource<Frame>,
  { origin: 'created' }
>;

type AcquiredSlot<Frame extends RenderGraphFrame> = OwnedSlot<Frame> & {
  handle: NonNullable<OwnedSlot<Frame>['handle']>;
};

function acquired<Frame extends RenderGraphFrame>(
  slot: OwnedSlot<Frame>,
): slot is AcquiredSlot<Frame> {
  return slot.handle !== undefined;
}

/** The successful bindings and leases handed from the allocator to execution. */
export class BoundGraphResources<Frame extends RenderGraphFrame> {
  readonly attachments = new AttachmentBindings();
  readonly imports: ImportedSlot<Frame>[] = [];
  readonly frameViews: CompiledView<Frame>[] = [];
  readonly nativeInputs: NativeInput<Frame>[] = [];
  persistentTextures?: Map<Texture, GraphTextureAllocation>;
  inheritedTextureReads?: {
    readonly label: string;
    readonly allocation: GraphTextureAllocation;
    readonly reads: readonly InheritedTextureRead[];
  }[];
  importOnly = true;
  private readonly allocations = new Map<object, AcquiredSlot<Frame>>();
  private phase: AllocationState = 'live';
  private inspection: RenderGraphResourceAllocationInspection | undefined;
  private heldBytes = 0;
  private peakBytes = 0;
  private successfulAllocationCount = 0;
  private successfulAllocationBytes = 0;
  private retiredBytes = 0;
  private unknownByteSizeCount = 0;
  private allocationObserver: GraphAllocationObserver | undefined;

  inspect(): RenderGraphResourceAllocationInspection {
    if (this.inspection !== undefined) return this.inspection;
    this.inspection = Object.freeze({
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: this.phase === 'live' ? this.heldBytes : 0,
      pendingRetirementBytes: this.phase === 'pending-retirement' ? this.heldBytes : 0,
      peakBytes: this.peakBytes,
      successfulAllocationCount: this.successfulAllocationCount,
      successfulAllocationBytes: this.successfulAllocationBytes,
      pendingRetirementCount: this.phase === 'pending-retirement' ? this.allocations.size : 0,
      retiredBytes: this.retiredBytes,
      failedAllocationRollbacks: 0,
      failedAllocationRollbackBytes: 0,
      unknownByteSizeCount: this.unknownByteSizeCount,
      importedResourceCount: this.imports.length,
    });
    return this.inspection;
  }

  state(handle: object | undefined): AllocationState | 'released' {
    return handle !== undefined && this.allocations.has(handle) ? this.phase : 'released';
  }

  visit(consume: AllocationVisitor): void {
    for (const [handle, slot] of this.allocations) {
      const bytes = slot.ownedByteSize;
      if (bytes !== undefined) consume(physicalAllocationKey(handle), bytes, this.phase);
    }
  }

  observeAllocations(observer: GraphAllocationObserver): boolean {
    if (this.allocations.size === 0 || this.allocationObserver === observer) return true;
    if (this.allocationObserver !== undefined) return false;
    this.allocationObserver = observer;
    for (const [handle, slot] of this.allocations) {
      if (slot.ownedByteSize !== undefined) observer.retain(handle, slot.ownedByteSize);
    }
    return true;
  }

  retireAll(): void {
    if (this.phase === 'pending-retirement') return;
    this.phase = 'pending-retirement';
    this.inspection = undefined;
  }

  release(handle: object): void {
    const slot = this.allocations.get(handle);
    if (slot === undefined) return;
    const bytes = slot.ownedByteSize;
    this.inspection = undefined;
    this.allocations.delete(handle);
    if (bytes === undefined) this.unknownByteSizeCount -= 1;
    else {
      this.heldBytes -= bytes;
      this.retiredBytes += bytes;
      this.allocationObserver?.release(handle);
    }
    if (this.allocations.size === 0) this.allocationObserver = undefined;
  }

  addImport(slot: ImportedSlot<Frame>): void {
    // Acceleration structures derive no usage bits. A declared access makes their handle live.
    if (slot.kind === 'acceleration-structure') {
      this.importOnly = false;
      if (slot.firstUse !== null) this.imports.push(slot);
      return;
    }
    if (slot.usage === 0) {
      if (slot.kind === 'texture') this.importOnly = false;
      return;
    }
    this.imports.push(slot);
    if (slot.kind === 'texture' && slot.native !== undefined) {
      slot.nativeViews = [];
      this.nativeInputs.push(slot);
    }
  }

  addImportedView(view: CompiledView<Frame>, parent: NativeInput<Frame>): void {
    if (parent.usage === 0) return;
    this.frameViews.push(view);
    if (view.resolve === undefined) parent.nativeViews?.push(view);
  }

  inherit(
    label: string,
    allocation: GraphTextureAllocation,
    reads: readonly InheritedTextureRead[],
  ): void {
    this.inheritedTextureReads ??= [];
    this.inheritedTextureReads.push({ label, allocation, reads });
  }

  owningSlots(): Iterable<AcquiredSlot<Frame>> {
    return this.allocations.values();
  }

  own(slot: OwnedSlot<Frame>): void {
    if (!acquired(slot) || this.allocations.has(slot.handle)) return;
    const handle = slot.handle;
    const allocation = slot.textureAllocation;
    const newlyAllocated = allocation === undefined || allocation.references === 1;
    if (allocation !== undefined && allocation.shape.lifetime === 'persistent') {
      this.persistentTextures ??= new Map();
      this.persistentTextures.set(allocation.texture, allocation);
    }
    const bytes = allocationBytes(slot);
    slot.ownedByteSize = bytes;
    this.allocations.set(handle, slot);
    if (newlyAllocated) this.successfulAllocationCount += 1;
    if (bytes === undefined) this.unknownByteSizeCount += 1;
    else {
      this.heldBytes += bytes;
      if (newlyAllocated) this.successfulAllocationBytes += bytes;
    }
    this.peakBytes = this.heldBytes;
  }
}

export function releaseBoundResource<Frame extends RenderGraphFrame>(
  device: RhiDevice,
  slot: AcquiredSlot<Frame>,
) {
  if (slot.kind === 'texture') {
    return slot.textureAllocation === undefined
      ? device.destroyTexture(slot.handle)
      : releaseGraphTexture(device, slot.textureAllocation);
  }
  return device.destroyBuffer(slot.handle);
}
