/** A lease captures one GPU allocation, never a reusable World handle slot. */
export interface ResidencyLease {
  track(completed: Promise<unknown>): void;
  release(evict: boolean): Promise<void> | undefined;
}

const submissionOwners = new WeakMap<Promise<unknown>, Set<ResidencyLifetime>>();

/** Shared candidates and queue submissions have one allocation lifetime owner. */
export class ResidencyLifetime {
  private leases = 0;
  private retired = false;
  private eviction: (() => void) | undefined;
  private readonly submissions = new Set<Promise<unknown>>();
  private readonly waiters = new Map<
    () => void,
    { pending: Set<Promise<unknown>>; reject(cause: unknown): void }
  >();
  private fault: { readonly cause: unknown; readonly effect?: () => void } | undefined;
  get retirementFailure(): unknown {
    return this.fault?.cause;
  }

  constructor(private destroy: (() => void) | undefined) {}

  get owners(): number {
    return this.leases;
  }

  get inUse(): boolean {
    return this.leases > 0 || this.submissions.size > 0;
  }

  retain(evict: () => void): ResidencyLease {
    if (this.fault !== undefined) throw this.fault.cause;
    this.leases += 1;
    this.eviction = undefined;
    let released = false;
    let completion: Promise<void> | undefined;
    return {
      track: (submitted) => this.track(submitted),
      release: (shouldEvict) => {
        if (released) {
          if (completion === undefined && this.fault !== undefined) throw this.fault.cause;
          return completion;
        }
        released = true;
        this.leases -= 1;
        if (this.leases === 0 && shouldEvict) this.eviction = evict;
        completion =
          this.submissions.size === 0
            ? undefined
            : new Promise<void>((resolve, reject) => {
                this.waiters.set(
                  () => {
                    try {
                      if (shouldEvict && this.leases === 0 && this.eviction === evict) {
                        this.eviction = undefined;
                        this.runEffect(evict);
                      }
                      resolve();
                    } catch (cause) {
                      reject(cause);
                      throw cause;
                    }
                  },
                  { pending: new Set(this.submissions), reject },
                );
              });
        this.flush();
        return completion;
      },
    };
  }

  track(completed: Promise<unknown>): void {
    if (this.submissions.has(completed)) return;
    this.submissions.add(completed);
    const pending = submissionOwners.get(completed);
    if (pending !== undefined) {
      pending.add(this);
      return;
    }
    const owners = new Set([this]);
    submissionOwners.set(completed, owners);
    const finish = (): void => {
      // Cleanup may register a new allocation against this settled submission.
      submissionOwners.delete(completed);
      const failures: unknown[] = [];
      for (const owner of owners) {
        const observed = owner.waiters.size > 0;
        owner.submissions.delete(completed);
        for (const waiter of owner.waiters.values()) waiter.pending.delete(completed);
        try {
          owner.flush();
        } catch (cause) {
          // Released leases receive their own rejection; preserve unobserved owner failures.
          if (!observed) failures.push(cause);
        }
      }
      owners.clear();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'residency submission cleanup failed');
    };
    void completed.then(finish, finish);
  }

  retire(): void {
    this.retired = true;
    this.flush();
  }

  private runEffect(effect: () => void): void {
    try {
      effect();
    } catch (cause) {
      this.fault ??= { cause, effect };
      throw cause;
    }
  }
  private flush(): void {
    if (this.fault !== undefined) throw this.fault.cause;
    try {
      this.flushCurrent();
    } catch (cause) {
      this.fault ??= { cause };
      for (const waiter of this.waiters.values()) waiter.reject(this.fault.cause);
      this.waiters.clear();
      throw this.fault.cause;
    }
  }
  private flushCurrent(): void {
    if (this.submissions.size === 0) {
      if (this.leases === 0 && this.eviction !== undefined) {
        const evict = this.eviction;
        this.eviction = undefined;
        this.runEffect(evict);
      }
      // Eviction may attach queue work before retiring this allocation.
      if (
        this.submissions.size === 0 &&
        this.retired &&
        this.leases === 0 &&
        this.destroy !== undefined
      ) {
        const destroy = this.destroy;
        this.destroy = undefined;
        this.runEffect(destroy);
      }
    }
    // A released lease waits for work already submitted, while the allocation
    // still covers later frames that reuse its remaining live bindings.
    for (const [resolve, waiter] of this.waiters) {
      if (waiter.pending.size !== 0) continue;
      this.waiters.delete(resolve);
      resolve();
    }
  }
}
