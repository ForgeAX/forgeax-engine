import { describe, expect, it } from 'vitest';
import { inspectResourceClassSplits } from '../gpu-driven/batch-topology';
import {
  combineGpuResourceAllocationInspections,
  GpuResourceAllocationLedger,
} from '../gpu-driven/resource-allocation';

describe('GPU resource allocation ownership', () => {
  it('keeps replacement coexistence through fence retirement and release', () => {
    const ledger = new GpuResourceAllocationLedger();
    const first = ledger.allocate(64);
    const second = ledger.allocate(128);

    expect(ledger.inspect()).toMatchObject({
      liveBytes: 192,
      pendingRetirementBytes: 0,
      peakBytes: 192,
    });
    ledger.retire(first);
    expect(ledger.inspect()).toMatchObject({
      liveBytes: 128,
      pendingRetirementBytes: 64,
      peakBytes: 192,
    });
    ledger.release(first);
    expect(ledger.inspect()).toMatchObject({
      liveBytes: 128,
      pendingRetirementBytes: 0,
      retiredBytes: 64,
    });
    ledger.release(second);
    expect(ledger.inspect()).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 0,
      retiredBytes: 192,
    });
  });

  it('records failed allocation rollback without leaving live bytes', () => {
    const ledger = new GpuResourceAllocationLedger();
    const token = ledger.allocate(256);
    ledger.rollback(token);
    expect(ledger.inspect()).toMatchObject({
      liveBytes: 0,
      failedAllocationRollbacks: 1,
      failedAllocationRollbackBytes: 256,
      peakBytes: 256,
    });
  });

  it('attributes only resourceIdentity changes as resource-class splits', () => {
    const base = {
      generation: 0,
      key: {
        assetHandle: 1,
        drawKind: 'indexed' as const,
        first: 0,
        count: 3,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list' as const,
        pipelineClass: 'pbr',
        materialResourceClass: 'water-a',
        resourceIdentity: 'water-a',
      },
      candidates: [],
      visibleBase: 0,
      visibleCapacity: 0,
      indirectOffset: 0,
      contentEpoch: 0,
    };
    const sameClass = { ...base, batchId: 0 };
    const secondRange = {
      ...base,
      batchId: 1,
      key: { ...base.key, first: 3, count: 6 },
    };
    expect(inspectResourceClassSplits({ batches: [sameClass, secondRange] })).toMatchObject({
      resourceClassCount: 1,
      resourceClassSplitReasons: [],
    });
    const changedClass = {
      ...secondRange,
      key: { ...secondRange.key, resourceIdentity: 'water-b' },
    };
    expect(inspectResourceClassSplits({ batches: [sameClass, changedClass] })).toMatchObject({
      resourceClassCount: 2,
      resourceClassSplitReasons: ['resource-class:water-a', 'resource-class:water-b'],
    });
  });

  it('combines owner facts without claiming physical residency', () => {
    const ledger = new GpuResourceAllocationLedger();
    ledger.allocate(32);
    const combined = combineGpuResourceAllocationInspections([ledger.inspect()]);
    expect(combined).toMatchObject({
      unit: 'engine-allocation-bytes',
      physicalResidency: 'unknown',
      liveBytes: 32,
    });
  });

  it('does not add historical peaks from owners with no simultaneous occupancy', () => {
    const first = new GpuResourceAllocationLedger();
    const firstToken = first.allocate(64);
    first.retire(firstToken);
    first.release(firstToken);

    const second = new GpuResourceAllocationLedger();
    const secondToken = second.allocate(128);
    second.retire(secondToken);
    second.release(secondToken);

    expect(
      combineGpuResourceAllocationInspections([first.inspect(), second.inspect()]),
    ).toMatchObject({
      liveBytes: 0,
      pendingRetirementBytes: 0,
      // The owner-local peaks are historical and happened in separate
      // replacement windows; their sum is not an aggregate high-water mark.
      peakBytes: 128,
    });
  });
});
