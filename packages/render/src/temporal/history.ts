import type { DeviceScope, ResourceRef } from '../device/device-scope';
import { createTemporalCoverage, type TemporalCoverage } from './coverage';
import type { TemporalView } from './view';

export type TemporalProducer = 'rigid' | 'instance' | 'skin' | 'morph' | 'transparent' | 'vfx';
export type TemporalProducerState = Partial<Record<TemporalProducer, string>>;

export interface TemporalHistorySnapshot {
  readonly historyValid: boolean;
  readonly frameIndex: number;
  readonly previous: TemporalProducerState;
  readonly coverage: TemporalCoverage;
  readonly resetReason: string | undefined;
}

interface HistoryOptions {
  readonly width: number;
  readonly height: number;
  readonly mode: 'off' | 'taa';
}

export class TemporalHistory {
  readonly childScope: DeviceScope | undefined;
  readonly coverage: TemporalCoverage;
  readonly historyCount: number;
  readonly historyBytes: number;
  private readonly resources: readonly ResourceRef<object>[];
  private current: TemporalProducerState = {};
  private pending: TemporalProducerState | undefined;
  private valid = false;
  private index = 0;
  private resetReason: string | undefined;

  constructor(scope: DeviceScope, options: HistoryOptions) {
    const taa = options.mode === 'taa';
    this.coverage = taa
      ? createTemporalCoverage(options.width, options.height)
      : Object.freeze({
          width: options.width,
          height: options.height,
          bytes: 0,
          fullScreen: true as const,
        });
    this.historyCount = taa ? 6 : 0;
    this.historyBytes = this.coverage.bytes;
    if (!taa) {
      this.resources = [];
      return;
    }
    const child = scope.createChild(`${scope.owner}:temporal-history`);
    this.childScope = child;
    this.resources = Object.freeze([
      child.ref('texture', Object.freeze({ slot: 'color-a' })),
      child.ref('texture', Object.freeze({ slot: 'color-b' })),
      child.ref('texture', Object.freeze({ slot: 'temporal-a' })),
      child.ref('texture', Object.freeze({ slot: 'temporal-b' })),
      child.ref('texture', Object.freeze({ slot: 'stability-a' })),
      child.ref('texture', Object.freeze({ slot: 'stability-b' })),
    ]);
  }

  stage(view: TemporalView, producers: TemporalProducerState): void {
    if (view.mode !== 'taa' || this.historyCount === 0) return;
    this.pending = { ...producers };
    this.resetReason = undefined;
  }

  commit(): void {
    if (this.pending === undefined) return;
    this.current = Object.freeze({ ...this.pending });
    this.pending = undefined;
    this.valid = true;
    this.index += 1;
  }

  abort(reason: string = 'submit-failure'): void {
    this.pending = undefined;
    this.resetReason = reason;
  }

  snapshot(): TemporalHistorySnapshot {
    return Object.freeze({
      historyValid: this.valid,
      frameIndex: this.index,
      previous: Object.freeze({ ...this.current }),
      coverage: this.coverage,
      resetReason: this.resetReason,
    });
  }

  get resourceRefs(): readonly ResourceRef<object>[] {
    return this.resources;
  }
}
