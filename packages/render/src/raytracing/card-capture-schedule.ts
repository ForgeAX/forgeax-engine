import type { IndexRun } from './index-allocator';
import { mergeRuns } from './irradiance-field-edit';

/** One frame's contiguous atlas tile slice; `clear` recaptures already captured tiles. */
export interface CardCaptureSlice {
  readonly first: number;
  readonly count: number;
  readonly clear: boolean;
}

/** Card atlas capture this frame: absent, the first slice (clears the atlas and
 * builds material mips) or a later slice that loads the retained atlas. */
export type CardAtlasCapture = 'clear' | 'load' | undefined;

/**
 * The single progressive Card capture scheduler of a native Card atlas. Tiles
 * `[0, captured)` hold submitted capture; the rest stay cleared (invalid). Each
 * frame captures at most `limit` tiles (the configured `budget`, or a smaller share
 * when views share it): the frontier first, then edited (dirty)
 * runs, which clear their slice before recapture. It only advances on
 * {@link commit} of a submitted slice, so a failed submit replays the same work.
 */
export class CardCaptureScheduler {
  readonly budget: number;
  #limit: number;
  #tiles: number;
  #captured = 0;
  #dirty: IndexRun[] = [];

  constructor(tiles: number, budget: number) {
    if (!Number.isSafeInteger(budget) || budget < 1)
      throw new Error('Card capture requires a positive per-frame tile budget');
    this.budget = budget;
    this.#limit = budget;
    this.#tiles = Math.max(1, tiles);
  }

  /** This frame's tile limit, within `[1, budget]`. */
  get limit(): number {
    return this.#limit;
  }

  set limit(value: number) {
    this.#limit = Math.max(1, Math.min(this.budget, Math.floor(value)));
  }

  get tiles(): number {
    return this.#tiles;
  }

  get captured(): number {
    return this.#captured;
  }

  /** Every tile holds a submitted capture and no edit is pending. */
  get done(): boolean {
    return this.#captured >= this.#tiles && this.#dirty.length === 0;
  }

  get pendingTiles(): number {
    return this.#dirty.reduce((n, run) => n + run.end - run.first, 0);
  }

  slice(): CardCaptureSlice | undefined {
    if (this.#captured < this.#tiles)
      return {
        first: this.#captured,
        count: Math.min(this.#limit, this.#tiles - this.#captured),
        clear: false,
      };
    const run = this.#dirty[0];
    return run === undefined
      ? undefined
      : { first: run.first, count: Math.min(this.#limit, run.end - run.first), clear: true };
  }

  /** Whether every tile of `run` holds a submitted capture with no recapture pending. */
  covers(run: IndexRun): boolean {
    return (
      run.end <= this.#captured &&
      this.#dirty.every((dirty) => dirty.end <= run.first || dirty.first >= run.end)
    );
  }

  mode(): CardAtlasCapture {
    return this.slice() === undefined ? undefined : this.#captured === 0 ? 'clear' : 'load';
  }

  /** Raises the tile count (in-place adds); tiles past the frontier are captured fresh. */
  grow(tiles: number): void {
    this.#tiles = Math.max(this.#tiles, tiles);
  }

  /**
   * Queues edited tile runs for recapture. Runs at or past the frontier are captured
   * fresh anyway, so only the already captured part is queued; returns its tile count.
   */
  queue(runs: readonly IndexRun[]): number {
    const queued = runs
      .map((run) => ({ first: run.first, end: Math.min(run.end, this.#captured) }))
      .filter((run) => run.end > run.first);
    this.#dirty = mergeRuns([...this.#dirty, ...queued]);
    return queued.reduce((n, run) => n + run.end - run.first, 0);
  }

  /** Advance past a submitted slice. */
  commit(slice: CardCaptureSlice): void {
    if (!slice.clear) {
      this.#captured = Math.max(this.#captured, slice.first + slice.count);
      return;
    }
    const run = this.#dirty[0];
    if (run === undefined || run.first !== slice.first) return;
    const rest = { first: run.first + slice.count, end: run.end };
    this.#dirty = rest.end > rest.first ? [rest, ...this.#dirty.slice(1)] : this.#dirty.slice(1);
  }
}
