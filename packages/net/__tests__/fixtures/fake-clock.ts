export type RecoveryResourceKind =
  | 'timers'
  | 'listeners'
  | 'sockets'
  | 'pendingConnects'
  | 'ledgers'
  | 'deferredCallbacks';

export type RecoveryResourceCounts = Readonly<Record<RecoveryResourceKind, number>>;

const resourceKinds: readonly RecoveryResourceKind[] = [
  'timers',
  'listeners',
  'sockets',
  'pendingConnects',
  'ledgers',
  'deferredCallbacks',
];

export class RecoveryResourceCounter {
  readonly #counts = new Map<RecoveryResourceKind, number>(
    resourceKinds.map((kind) => [kind, 0]),
  );

  acquire(kind: RecoveryResourceKind): () => void {
    this.#counts.set(kind, this.count(kind) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.count(kind) - 1;
      if (next < 0) throw new Error(`resource counter underflow for ${kind}`);
      this.#counts.set(kind, next);
    };
  }

  count(kind: RecoveryResourceKind): number {
    return this.#counts.get(kind) ?? 0;
  }

  snapshot(): RecoveryResourceCounts {
    return Object.fromEntries(resourceKinds.map((kind) => [kind, this.count(kind)])) as RecoveryResourceCounts;
  }

  assertZero(): void {
    const active = Object.entries(this.snapshot()).filter(([, count]) => count !== 0);
    if (active.length > 0) throw new Error(`retired resources remain: ${JSON.stringify(active)}`);
  }
}

export interface FakeTimer {
  readonly id: number;
  readonly dueAtMs: number;
  cancel(): void;
}

interface ScheduledTimer {
  readonly id: number;
  readonly dueAtMs: number;
  readonly callback: () => void;
  readonly release: () => void;
  cancelled: boolean;
}

export class FakeClock {
  readonly #resources: RecoveryResourceCounter;
  readonly #timers = new Map<number, ScheduledTimer>();
  #nowMs = 0;
  #nextTimerId = 1;

  constructor(resources = new RecoveryResourceCounter()) {
    this.#resources = resources;
  }

  get nowMs(): number {
    return this.#nowMs;
  }

  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  schedule(delayMs: number, callback: () => void): FakeTimer {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError('timer delay must be a finite non-negative number');
    }
    const id = this.#nextTimerId++;
    const timer: ScheduledTimer = {
      id,
      dueAtMs: this.#nowMs + delayMs,
      callback,
      release: this.#resources.acquire('timers'),
      cancelled: false,
    };
    this.#timers.set(id, timer);
    return {
      id,
      dueAtMs: timer.dueAtMs,
      cancel: () => this.cancel(id),
    };
  }

  cancel(id: number): void {
    const timer = this.#timers.get(id);
    if (timer === undefined) return;
    timer.cancelled = true;
    timer.release();
    this.#timers.delete(id);
  }

  advanceBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('clock delta must be a finite non-negative number');
    }
    const targetMs = this.#nowMs + deltaMs;
    while (true) {
      const next = [...this.#timers.values()]
        .filter((timer) => !timer.cancelled && timer.dueAtMs <= targetMs)
        .sort((left, right) => left.dueAtMs - right.dueAtMs || left.id - right.id)[0];
      if (next === undefined) break;
      this.#nowMs = next.dueAtMs;
      this.#timers.delete(next.id);
      next.release();
      next.callback();
    }
    this.#nowMs = targetMs;
  }

  runUntilIdle(): void {
    while (this.#timers.size > 0) {
      const next = [...this.#timers.values()].sort(
        (left, right) => left.dueAtMs - right.dueAtMs || left.id - right.id,
      )[0];
      if (next === undefined) return;
      this.advanceBy(next.dueAtMs - this.#nowMs);
    }
  }
}
