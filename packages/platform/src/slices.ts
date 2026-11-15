/**
 * Same-frame parallel slices. A slice job is a fixed number of indices that
 * the calling realm and the pool Workers claim from one shared cursor; each
 * index runs exactly once, on whichever side claimed it first.
 *
 * Control layout (Int32Array over a SharedArrayBuffer):
 * - `[0]` next unclaimed index,
 * - `[1]` finished index count,
 * - `[2 + i]` state of index `i`: 0 unclaimed, an owner id while running,
 *   {@link SLICE_DONE} or {@link SLICE_FAILED} once finished.
 */

/** A slice kind served by pool Workers. `run` is synchronous. */
export interface SliceModule<I = unknown, P = unknown> {
  /** Ready this Worker for later jobs; announced once per value by `prepareSlices`. */
  prepare?(value: P): Promise<void> | void;
  /** False while `prepare` has not completed for what `input` needs; the Worker then claims nothing. */
  ready?(input: I): boolean;
  run(input: I, index: number): void;
}

// biome-ignore lint/suspicious/noExplicitAny: kinds are heterogeneous.
export type SliceRegistry = Readonly<Record<string, SliceModule<any, any>>>;

export const SLICE_NEXT = 0;
export const SLICE_FINISHED = 1;
export const SLICE_STATE = 2;
export const SLICE_DONE = -1;
export const SLICE_FAILED = -2;
/** Owner id of the calling realm; pool Workers use their slot id plus two. */
export const SLICE_CALLER = 1;

export function createSliceControl(count: number): Int32Array {
  return new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * (SLICE_STATE + count)),
  );
}

/**
 * Claim and run indices until none remain. The finisher of the last index
 * wakes the waiting caller. Returns the first error this side raised.
 */
export function drainSlices(
  control: Int32Array,
  owner: number,
  run: (index: number) => void,
): unknown {
  const count = control.length - SLICE_STATE;
  let failure: unknown;
  for (;;) {
    const index = Atomics.add(control, SLICE_NEXT, 1);
    if (index >= count) return failure;
    Atomics.store(control, SLICE_STATE + index, owner);
    let state = SLICE_DONE;
    try {
      run(index);
    } catch (cause) {
      state = SLICE_FAILED;
      failure ??= cause;
    }
    Atomics.store(control, SLICE_STATE + index, state);
    if (Atomics.add(control, SLICE_FINISHED, 1) === count - 1) {
      Atomics.notify(control, SLICE_FINISHED);
    }
  }
}

/** Block until every index finished or `deadline` passed; true when all finished. */
export function awaitSlices(control: Int32Array, deadline: number, now: () => number): boolean {
  const count = control.length - SLICE_STATE;
  for (;;) {
    // Check and wait share one observation: a second load could see the
    // final value, which no later finisher will notify.
    const finished = Atomics.load(control, SLICE_FINISHED);
    if (finished >= count) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    Atomics.wait(control, SLICE_FINISHED, finished, left);
  }
}

export interface SliceTally {
  readonly completed: number;
  readonly failed: number;
  /** Owner ids still running an index. */
  readonly running: ReadonlySet<number>;
}

export function tallySlices(control: Int32Array): SliceTally {
  const count = control.length - SLICE_STATE;
  const running = new Set<number>();
  let completed = 0;
  let failed = 0;
  for (let index = 0; index < count; index++) {
    const state = Atomics.load(control, SLICE_STATE + index);
    if (state === SLICE_DONE) completed++;
    else if (state === SLICE_FAILED) failed++;
    else if (state > 0) running.add(state);
  }
  return { completed, failed, running };
}
