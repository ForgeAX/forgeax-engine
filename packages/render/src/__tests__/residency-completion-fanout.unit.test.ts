import { describe, expect, it, vi } from 'vitest';
import { ResidencyLifetime } from '../device/residency-lifetime';

describe('shared residency submission completion', () => {
  it.each([
    ['resolve', false],
    ['reject', false],
    ['resolve', true],
    ['reject', true],
  ] as const)('completes a released lease after its existing fences %s while later submissions stay live (evict: %s)', async (outcome, shouldEvict) => {
    let finishExisting!: () => void, finishLater!: () => void;
    const existing = new Promise<void>((resolve, reject) => {
      finishExisting = outcome === 'resolve' ? resolve : () => reject(new Error('device lost'));
    });
    const later = new Promise<void>((resolve) => {
      finishLater = resolve;
    });
    const destroy = vi.fn(),
      evict = vi.fn();
    const lifetime = new ResidencyLifetime(destroy);
    const released = lifetime.retain(evict);
    lifetime.track(existing);
    const completion = released.release(shouldEvict);
    expect(released.release(true)).toBe(completion);
    const finished = vi.fn();
    void completion?.then(finished);
    lifetime.track(later);
    lifetime.retire();
    try {
      expect(finished).not.toHaveBeenCalled();
      finishExisting();
      await existing.catch(() => undefined);
      await vi.waitFor(() => expect(finished).toHaveBeenCalledTimes(1), { timeout: 100 });
      expect(lifetime.inUse).toBe(true);
      expect(destroy).not.toHaveBeenCalled();
      expect(evict).toHaveBeenCalledTimes(shouldEvict ? 1 : 0);
    } finally {
      finishLater();
      await later;
    }
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledTimes(shouldEvict ? 1 : 0);
  });

  it('cancels a pending eviction when a new lease retains the allocation', async () => {
    let finishExisting!: () => void, finishLater!: () => void;
    const existing = new Promise<void>((resolve) => {
      finishExisting = resolve;
    });
    const later = new Promise<void>((resolve) => {
      finishLater = resolve;
    });
    const destroy = vi.fn(),
      evict = vi.fn();
    const lifetime = new ResidencyLifetime(destroy);
    const original = lifetime.retain(evict);
    lifetime.track(existing);
    const released = original.release(true);
    const replacement = lifetime.retain(evict);
    lifetime.track(later);
    finishExisting();
    await existing;
    await released;
    expect(evict).not.toHaveBeenCalled();
    expect(lifetime.owners).toBe(1);
    expect(destroy).not.toHaveBeenCalled();
    const replacementRelease = replacement.release(false);
    lifetime.retire();
    expect(destroy).not.toHaveBeenCalled();
    finishLater();
    await later;
    await replacementRelease;
    expect(evict).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('observes one submission once while retaining every allocation until completion', async () => {
    let resolve!: () => void;
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const observer = vi.spyOn(completed, 'then');
    const destroys = Array.from({ length: 128 }, () => vi.fn());
    const lifetimes = destroys.map((destroy) => new ResidencyLifetime(destroy));
    try {
      for (const lifetime of lifetimes) {
        lifetime.track(completed);
        lifetime.track(completed);
        lifetime.retire();
      }
      expect(observer).toHaveBeenCalledTimes(1);
      for (const destroy of destroys) expect(destroy).not.toHaveBeenCalled();
    } finally {
      resolve();
      await completed;
    }
    for (const destroy of destroys) expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps overlapping submissions and leases live after a rejected completion', async () => {
    let resolve!: () => void, reject!: (error: Error) => void;
    const a = new Promise<void>((done) => {
      resolve = done;
    });
    const b = new Promise<void>((_done, fail) => {
      reject = fail;
    });
    const destroy = vi.fn(),
      evict = vi.fn();
    const lifetime = new ResidencyLifetime(destroy),
      lease = lifetime.retain(evict);
    lifetime.track(a);
    lease.track(b);
    lifetime.retire();
    const release = lease.release(true);
    reject(new Error('device lost'));
    await b.catch(() => undefined);
    expect(lifetime.inUse).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
    resolve();
    await a;
    await release;
    expect(lifetime.inUse).toBe(false);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(evict).toHaveBeenCalledTimes(1);
  });

  it('drains allocations registered later against an already completed submission', async () => {
    const completed = Promise.resolve();
    const first = new ResidencyLifetime(vi.fn());
    first.track(completed);
    await completed;
    const destroy = vi.fn(),
      late = new ResidencyLifetime(destroy);
    late.track(completed);
    late.retire();
    expect(destroy).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('drains the other allocations before preserving a cleanup exception', async () => {
    let resolve!: () => void;
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const then = completed.then.bind(completed);
    const observed: Promise<unknown>[] = [];
    vi.spyOn(completed, 'then').mockImplementation((fulfilled, rejected) => {
      const observer = then(fulfilled, rejected);
      observed.push(observer.catch((error: unknown) => error));
      return observer;
    });
    const failure = new Error('cleanup failure'),
      destroy = vi.fn();
    const bad = new ResidencyLifetime(() => {
      throw failure;
    });
    const other = new ResidencyLifetime(destroy);
    bad.track(completed);
    other.track(completed);
    bad.retire();
    other.retire();
    resolve();
    await Promise.resolve();
    const outcomes = await Promise.all(observed);
    expect(outcomes).toContain(failure);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(other.inUse).toBe(false);
  });

  it('drains a reentrant registration made by allocation cleanup', async () => {
    let resolve!: () => void;
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const destroy = vi.fn(),
      late = new ResidencyLifetime(destroy);
    const first = new ResidencyLifetime(() => {
      late.track(completed);
      late.retire();
    });
    first.track(completed);
    first.retire();
    resolve();
    await completed;
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(late.inUse).toBe(false);
  });

  it('preserves every cleanup failure when multiple allocations fail', async () => {
    let resolve!: () => void;
    const completed = new Promise<void>((done) => {
      resolve = done;
    });
    const then = completed.then.bind(completed);
    let observed: Promise<unknown> | undefined;
    vi.spyOn(completed, 'then').mockImplementation((fulfilled, rejected) => {
      const observer = then(fulfilled, rejected);
      observed = observer.catch((error: unknown) => error);
      return observer;
    });
    const failures = [new Error('first cleanup'), new Error('second cleanup')];
    for (const failure of failures) {
      const lifetime = new ResidencyLifetime(() => {
        throw failure;
      });
      lifetime.track(completed);
      lifetime.retire();
    }
    resolve();
    await Promise.resolve();
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(failures);
  });
});
