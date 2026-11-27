import { type Buffer, err, ok, type Result, type RhiDevice, RhiError } from '@forgeax/engine-rhi';
import type {
  GpuResourceAllocationLedger,
  GpuResourceAllocationToken,
} from './resource-allocation';

interface Retirement {
  readonly buffer: Buffer;
  readonly report: (failure: RhiError) => void;
}

/** Exact buffer responsibility of one View; a fence only admits bounded cleanup. */
export class ViewBufferRetirement {
  private readonly accepted = new WeakSet<Buffer>();
  private readonly pending = new Map<Buffer, Retirement>();
  private ready: Retirement[] = [];
  private cursor = 0;
  private fences = 0;
  private creations = 0;
  private draining = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private causes: AggregateError | undefined;
  private failure: RhiError | undefined;
  private readonly waiters: ((result: Result<void, RhiError>) => void)[] = [];

  constructor(
    private readonly device: RhiDevice,
    private readonly ledger: GpuResourceAllocationLedger,
    private readonly tokens: WeakMap<Buffer, GpuResourceAllocationToken>,
  ) {}

  /** Covers a synchronous native call whose callback can dispose before its receipt returns. */
  beginCreation(): () => void {
    this.creations++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.creations--;
      this.settleWaiters();
    };
  }

  retire(buffers: readonly Buffer[], report: Retirement['report']): void {
    const entries: Retirement[] = [];
    for (const buffer of buffers) {
      if (this.accepted.has(buffer)) continue;
      this.accepted.add(buffer);
      const entry = { buffer, report };
      this.pending.set(buffer, entry);
      const token = this.tokens.get(buffer);
      if (token !== undefined) this.ledger.retire(token);
      entries.push(entry);
    }
    if (entries.length === 0) return;
    this.fences++;
    try {
      void this.device.queue.onSubmittedWorkDone().then(
        () => {
          this.fences--;
          this.ready.push(...entries);
          this.schedule();
        },
        (cause) => {
          this.fences--;
          this.fail(cause, report);
          this.settleWaiters();
        },
      );
    } catch (cause) {
      this.fences--;
      this.fail(cause, report);
      this.settleWaiters();
    }
  }

  assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  /** No future frame is required, and an unconfirmed receipt settles as failure. */
  settle(): Promise<Result<void, RhiError>> {
    if (
      !this.draining &&
      this.creations === 0 &&
      this.fences === 0 &&
      this.timer === undefined &&
      this.cursor === this.ready.length
    )
      return Promise.resolve(this.result());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private result(): Result<void, RhiError> {
    return this.failure === undefined ? ok(undefined) : err(this.failure);
  }

  private fail(cause: unknown, report: Retirement['report']): void {
    this.causes ??= new AggregateError([], 'View buffer retirement failed');
    const causes = this.causes;
    causes.errors.push(cause);
    this.failure ??= Object.assign(
      new RhiError({
        code: 'internal-error',
        expected: 'confirmed retirement of every exact View buffer',
        hint: 'retain the failed receipts and rebuild the owning View/device; do not retry unknown destruction',
      }),
      { cause: causes },
    );
    try {
      report(this.failure);
    } catch (reported) {
      causes.errors.push(reported);
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.cursor === this.ready.length) return;
    this.timer = setTimeout(() => this.drainOne(), 0);
  }

  private drainOne(): void {
    this.timer = undefined;
    const entry = this.ready[this.cursor++];
    this.draining = true;
    if (entry !== undefined) {
      try {
        this.device.destroyBuffer(entry.buffer).unwrap();
        this.pending.delete(entry.buffer);
        const token = this.tokens.get(entry.buffer);
        if (token !== undefined) this.ledger.release(token);
      } catch (cause) {
        this.fail(cause, entry.report);
      }
    }
    this.draining = false;
    if (this.cursor === this.ready.length) {
      this.ready = [];
      this.cursor = 0;
    }
    this.schedule();
    this.settleWaiters();
  }

  private settleWaiters(): void {
    if (
      this.draining ||
      this.creations !== 0 ||
      this.fences !== 0 ||
      this.timer !== undefined ||
      this.cursor !== this.ready.length
    )
      return;
    const result = this.result();
    for (const resolve of this.waiters.splice(0)) resolve(result);
  }
}
