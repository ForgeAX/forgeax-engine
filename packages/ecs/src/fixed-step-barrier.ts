import { FixedTime } from './time';
import type { World } from './world';

type Barrier = { settled: boolean; rejected: boolean; failure?: unknown; ready?: () => void };
const barriers = new WeakMap<World, Barrier>();
const fixedScopes = new WeakSet<World>();

/** Scheduling owner only. A deferred completion may only originate in a fixed substep. */
export function withFixedStepDeferral<T>(world: World, run: () => T): T {
  fixedScopes.add(world);
  try {
    return run();
  } finally {
    fixedScopes.delete(world);
  }
}

/** Suspend the current FixedUpdate after this system, retaining its remaining systems and time debt.
 * The completion must adopt the solver state before it resolves. Never retain a Query row or arena view. */
export function deferFixedStep(world: World, completion: Promise<void>): void {
  if (!fixedScopes.has(world) || world.getResource(FixedTime).catchUp !== 'substeps')
    throw new Error('Fixed-step deferral requires a running FixedUpdate substep');
  if (barriers.has(world)) throw new Error('A fixed step already has an outstanding completion');
  const barrier: Barrier = { settled: false, rejected: false };
  barriers.set(world, barrier);
  void completion.then(
    () => {
      barrier.settled = true;
      barrier.ready?.();
    },
    (failure: unknown) => {
      barrier.failure = failure;
      barrier.rejected = true;
      barrier.settled = true;
      barrier.ready?.();
    },
  );
}

export function discardDeferredFixedStep(world: World): void {
  barriers.delete(world);
}

/** Scheduling owner only. Continue fixed work between render updates once the worker acknowledges. */
export function onDeferredFixedStepReady(world: World, ready: () => void): void {
  const barrier = barriers.get(world);
  if (!barrier) throw new Error('No deferred fixed step exists');
  barrier.ready = ready;
  if (barrier.settled) queueMicrotask(ready);
}

export function fixedStepIsDeferred(world: World): boolean {
  return barriers.has(world);
}

/** Scheduling owner only. Rejection is surfaced through the ordinary system failure boundary. */
export function resumeDeferredFixedStep(world: World): boolean {
  const barrier = barriers.get(world);
  if (!barrier) return true;
  if (!barrier.settled) return false;
  barriers.delete(world);
  if (barrier.rejected) throw barrier.failure;
  return true;
}
