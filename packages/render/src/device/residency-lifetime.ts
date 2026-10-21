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
  private readonly waiters = new Map<() => void, Set<Promise<unknown>>>();

  constructor(private destroy: (() => void) | undefined) {}

  get owners(): number {
    return this.leases;
  }

  get inUse(): boolean {
    return this.leases > 0 || this.submissions.size > 0;
  }

  retain(evict: () => void): ResidencyLease {
    this.leases += 1;
    this.eviction = undefined;
    let released = false;
    let completion: Promise<void> | undefined;
    return {
      track: (submitted) => this.track(submitted),
      release: (shouldEvict) => {
        if (released) return completion;
        released = true;
        this.leases -= 1;
        if (this.leases === 0 && shouldEvict) this.eviction = evict;
        completion =
          this.submissions.size === 0
            ? undefined
            : new Promise<void>((resolve) => {
                this.waiters.set(() => {
                  if (shouldEvict && this.leases === 0 && this.eviction === evict) {
                    this.eviction = undefined;
                    evict();
                  }
                  resolve();
                }, new Set(this.submissions));
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
      let failures: unknown[] | undefined;
      for (const owner of owners) {
        owner.submissions.delete(completed);
        for (const pending of owner.waiters.values()) pending.delete(completed);
        try {
          owner.flush();
        } catch (error) {
          failures ??= [];
          failures.push(error);
        }
      }
      owners.clear();
      if (failures?.length === 1) throw failures[0];
      if (failures !== undefined)
        throw new AggregateError(failures, 'residency submission cleanup failed');
    };
    void completed.then(finish, finish);
  }

  retire(): void {
    this.retired = true;
    this.flush();
  }

  private flush(): void {
    if (this.submissions.size === 0) {
      if (this.leases === 0 && this.eviction !== undefined) {
        const evict = this.eviction;
        this.eviction = undefined;
        evict();
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
        destroy();
      }
    }
    // A released lease waits for work already submitted, while the allocation
    // still covers later frames that reuse its remaining live bindings.
    for (const [resolve, pending] of this.waiters) {
      if (pending.size !== 0) continue;
      this.waiters.delete(resolve);
      resolve();
    }
  }
}
