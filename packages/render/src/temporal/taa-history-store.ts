export type TaaHistoryResetReason =
  | 'first-frame'
  | 'camera-cut'
  | 'resize'
  | 'recover'
  | 'device-generation';

export interface TaaHistoryInspection {
  readonly token: number;
  readonly deviceGeneration: number;
  readonly content: 'uninitialized' | 'active';
  readonly fallback: 'neutral-texture';
  readonly requestVersion: number;
  readonly generation: number;
  readonly seed: number;
  readonly attempt: 'none' | 'active' | 'committed' | 'aborted';
  readonly valid: boolean;
  readonly resetReason: TaaHistoryResetReason | undefined;
}

export interface TaaHistoryReceipt {
  readonly deviceGeneration: number;
  readonly completed: boolean;
}

export interface TaaHistoryAttempt {
  readonly generation: number;
  readonly seed: number;
  commit(receipt?: TaaHistoryReceipt): void;
  abort(): void;
}

let nextHistoryToken = 1;

/** TAA-only history owner. No global registry or backend handle crosses this boundary. */
export class TaaHistoryStore {
  private readonly token = nextHistoryToken++;
  private deviceGeneration = 0;
  private content: TaaHistoryInspection['content'] = 'uninitialized';
  private requestVersion = 0;
  private generation = 0;
  private seed = 0;
  private valid = false;
  private attempt: TaaHistoryInspection['attempt'] = 'none';
  private resetReason: TaaHistoryResetReason | undefined;

  begin(reason: TaaHistoryResetReason | undefined = undefined): TaaHistoryAttempt {
    const generation = this.generation;
    const seed = this.seed;
    this.attempt = 'active';
    let state: 'active' | 'committed' | 'aborted' = 'active';
    return {
      generation,
      seed,
      commit: (receipt) => {
        if (state !== 'active') return;
        if (
          receipt !== undefined &&
          (!receipt.completed || receipt.deviceGeneration !== this.deviceGeneration)
        ) {
          state = 'aborted';
          this.attempt = 'aborted';
          return;
        }
        state = 'committed';
        this.attempt = 'committed';
        this.valid = true;
        this.content = 'active';
        this.requestVersion += 1;
        this.generation += 1;
        this.seed += 1;
        this.resetReason = reason;
      },
      abort: () => {
        if (state !== 'active') return;
        state = 'aborted';
        this.attempt = 'aborted';
      },
    };
  }

  seedHistory(reason: TaaHistoryResetReason = 'first-frame'): void {
    this.valid = false;
    this.content = 'uninitialized';
    this.resetReason = reason;
    this.attempt = 'none';
  }

  reset(reason: TaaHistoryResetReason): void {
    this.generation = 0;
    this.seed = 0;
    this.valid = false;
    this.content = 'uninitialized';
    this.attempt = 'none';
    this.resetReason = reason;
  }

  recoverForGeneration(deviceGeneration: number): void {
    if (!Number.isSafeInteger(deviceGeneration) || deviceGeneration < 0) {
      throw new RangeError('deviceGeneration must be a non-negative safe integer.');
    }
    this.deviceGeneration = deviceGeneration;
    this.valid = false;
    this.content = 'uninitialized';
    this.attempt = 'none';
    this.resetReason = 'device-generation';
  }

  inspect(): TaaHistoryInspection {
    return {
      token: this.token,
      deviceGeneration: this.deviceGeneration,
      content: this.content,
      fallback: 'neutral-texture',
      requestVersion: this.requestVersion,
      generation: this.generation,
      seed: this.seed,
      attempt: this.attempt,
      valid: this.valid,
      resetReason: this.resetReason,
    };
  }
}
