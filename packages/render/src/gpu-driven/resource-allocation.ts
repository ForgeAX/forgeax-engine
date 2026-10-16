import type { GpuResourceAllocationInspection } from '../inspection-types';

export interface GpuResourceAllocationToken {
  readonly id: number;
  readonly bytes: number;
}

/**
 * Tracks logical Engine allocation ownership independently of physical GPU
 * residency. A replacement is live and pending at the same time until the
 * queue fence releases the old generation.
 */
export class GpuResourceAllocationLedger {
  private nextId = 1;
  private readonly live = new Map<number, number>();
  private readonly pending = new Map<number, number>();
  private liveBytes = 0;
  private pendingBytes = 0;
  private peakBytes = 0;
  private successfulAllocationCount = 0;
  private successfulAllocationBytes = 0;
  private retiredBytes = 0;
  private failedAllocationRollbacks = 0;
  private failedAllocationRollbackBytes = 0;

  allocate(bytes: number): GpuResourceAllocationToken {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(`GPU allocation bytes must be finite and non-negative (got ${bytes})`);
    }
    const token = { id: this.nextId++, bytes };
    this.live.set(token.id, token.bytes);
    this.liveBytes += token.bytes;
    this.successfulAllocationCount += 1;
    this.successfulAllocationBytes += token.bytes;
    this.updatePeak();
    return token;
  }

  retire(token: GpuResourceAllocationToken): void {
    const bytes = this.live.get(token.id);
    if (bytes === undefined) return;
    this.live.delete(token.id);
    this.liveBytes -= bytes;
    this.pending.set(token.id, bytes);
    this.pendingBytes += bytes;
    this.updatePeak();
  }

  release(token: GpuResourceAllocationToken): void {
    const pendingBytes = this.pending.get(token.id);
    if (pendingBytes !== undefined) {
      this.pending.delete(token.id);
      this.pendingBytes -= pendingBytes;
      this.retiredBytes += pendingBytes;
      return;
    }
    const liveBytes = this.live.get(token.id);
    if (liveBytes !== undefined) {
      this.live.delete(token.id);
      this.liveBytes -= liveBytes;
      this.retiredBytes += liveBytes;
    }
  }

  rollback(token: GpuResourceAllocationToken): void {
    const bytes = this.live.get(token.id);
    if (bytes === undefined) return;
    this.live.delete(token.id);
    this.liveBytes -= bytes;
    this.failedAllocationRollbacks += 1;
    this.failedAllocationRollbackBytes += bytes;
  }

  inspect(): GpuResourceAllocationInspection {
    return {
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: this.liveBytes,
      pendingRetirementBytes: this.pendingBytes,
      peakBytes: this.peakBytes,
      successfulAllocationCount: this.successfulAllocationCount,
      successfulAllocationBytes: this.successfulAllocationBytes,
      pendingRetirementCount: this.pending.size,
      retiredBytes: this.retiredBytes,
      failedAllocationRollbacks: this.failedAllocationRollbacks,
      failedAllocationRollbackBytes: this.failedAllocationRollbackBytes,
    };
  }

  private updatePeak(): void {
    this.peakBytes = Math.max(this.peakBytes, this.liveBytes + this.pendingBytes);
  }
}

export function combineGpuResourceAllocationInspections(
  inspections: readonly GpuResourceAllocationInspection[],
): GpuResourceAllocationInspection | undefined {
  if (inspections.length === 0) return undefined;
  const liveBytes = inspections.reduce((sum, value) => sum + value.liveBytes, 0);
  const pendingRetirementBytes = inspections.reduce(
    (sum, value) => sum + value.pendingRetirementBytes,
    0,
  );
  // Each owner reports its own historical high-water mark. Adding those
  // marks invents overlap between replacements that happened at different
  // times. The aggregate can prove the current simultaneous occupancy, or
  // retain the largest owner-local mark as a conservative lower-bound fact
  // when all resources have since retired; it cannot claim their historical
  // sum without an event-time aggregate owner.
  const peakBytes = Math.max(
    liveBytes + pendingRetirementBytes,
    ...inspections.map((value) => value.peakBytes),
  );
  return {
    unit: 'engine-allocation-bytes',
    physicalResidency: 'unknown',
    liveBytes,
    pendingRetirementBytes,
    peakBytes,
    successfulAllocationCount: inspections.reduce(
      (sum, value) => sum + value.successfulAllocationCount,
      0,
    ),
    successfulAllocationBytes: inspections.reduce(
      (sum, value) => sum + value.successfulAllocationBytes,
      0,
    ),
    pendingRetirementCount: inspections.reduce(
      (sum, value) => sum + value.pendingRetirementCount,
      0,
    ),
    retiredBytes: inspections.reduce((sum, value) => sum + value.retiredBytes, 0),
    failedAllocationRollbacks: inspections.reduce(
      (sum, value) => sum + value.failedAllocationRollbacks,
      0,
    ),
    failedAllocationRollbackBytes: inspections.reduce(
      (sum, value) => sum + value.failedAllocationRollbackBytes,
      0,
    ),
  };
}
