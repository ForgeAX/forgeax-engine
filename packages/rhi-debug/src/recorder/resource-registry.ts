import type { DebugRhiInstance } from '../recorder';
import type { HandleId } from '../types';
import { snapshotResourceBytes } from './core';

export interface ResourceCandidate {
  readonly handleId: HandleId;
  readonly kind: 'buffer' | 'texture';
  readonly estimatedBytes: number;
}

export class ResourceRegistry {
  constructor(private readonly recorder: DebugRhiInstance) {}

  candidates(): readonly ResourceCandidate[] {
    return Array.from(this.recorder.descriptorTable(), ([handleId, descriptor]) => ({
      handleId,
      kind: descriptor.kind,
      estimatedBytes: snapshotResourceBytes(descriptor).payload,
    }));
  }

  estimateSnapshotBytes(maxResourceBytes = Number.POSITIVE_INFINITY): number {
    return this.candidates().reduce(
      (total, candidate) =>
        candidate.estimatedBytes > maxResourceBytes ? total : total + candidate.estimatedBytes,
      0,
    );
  }

  clearGeneration(): void {
    this.recorder.transitionToError();
    this.recorder.resetForDeviceLoss();
  }
}
