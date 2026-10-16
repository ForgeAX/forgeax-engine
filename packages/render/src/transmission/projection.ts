/** The two CPU facts that are allowed to influence transmission topology. */
export interface TransmissionDemand {
  readonly activeCount: number;
  readonly needsRoughMips: boolean;
}

/** Detached material facts supplied by the persistent render-scene owner. */
export interface TransmissionDemandCandidate {
  readonly attached: boolean;
  readonly ready: boolean;
  readonly transmission: number;
  readonly roughness: number;
}

export type TransmissionDemandOperation =
  | {
      readonly kind: 'upsert';
      readonly key: string;
      readonly candidate: TransmissionDemandCandidate;
    }
  | { readonly kind: 'remove'; readonly key: string };

interface CandidateRecord {
  readonly active: boolean;
  readonly rough: boolean;
}

function candidateRecord(candidate: TransmissionDemandCandidate): CandidateRecord {
  const active =
    candidate.attached &&
    candidate.ready &&
    Number.isFinite(candidate.transmission) &&
    candidate.transmission > 0;
  return {
    active,
    rough: active && Number.isFinite(candidate.roughness) && candidate.roughness > 0,
  };
}

/**
 * Incremental CPU projection for transmission topology.
 *
 * The projection stores no material, visibility, camera, or GPU object. Each
 * operation updates the two counters directly; an empty operation list is a
 * no-scan steady-state frame.
 */
export class PersistentTransmissionDemandProjection {
  private readonly records = new Map<string, CandidateRecord>();
  private activeCount = 0;
  private roughCount = 0;

  apply(operations: readonly TransmissionDemandOperation[]): TransmissionDemand {
    for (const operation of operations) {
      const previous = this.records.get(operation.key);
      if (previous !== undefined) this.removeCounts(previous);
      if (operation.kind === 'remove') {
        this.records.delete(operation.key);
        continue;
      }
      const next = candidateRecord(operation.candidate);
      this.records.set(operation.key, next);
      this.addCounts(next);
    }
    return this.inspect();
  }

  inspect(): TransmissionDemand {
    return {
      activeCount: this.activeCount,
      needsRoughMips: this.roughCount > 0,
    };
  }

  private addCounts(record: CandidateRecord): void {
    if (record.active) this.activeCount += 1;
    if (record.rough) this.roughCount += 1;
  }

  private removeCounts(record: CandidateRecord): void {
    if (record.active) this.activeCount -= 1;
    if (record.rough) this.roughCount -= 1;
  }
}
