import type { StandardCardCapture } from '../pipeline/standard-profile';

/** Private Card-space producer layout. Surface capture resolution is never changed. */
export interface CardRadiosityPlan {
  readonly cardResolution: number;
  readonly tileCapacity: number;
  readonly probeSpacing: number;
  readonly probesPerCardAxis: number;
  readonly probesPerCard: number;
  readonly probeCount: number;
  readonly hemisphereResolution: number;
  readonly raysPerProbe: number;
  readonly traceBytes: number;
  readonly shBytes: number;
  readonly metaBytes: number;
  readonly visibilityBytes: number;
}

/** Trace records retain radiance, distance, direction and availability separately.
 * SH stores two bands (four coefficients) for each RGB channel. Zero meta means
 * unavailable, not a proven black surface or a miss. */
export function planCardRadiosity(
  cardResolution: number,
  atlasWidth: number,
  atlasHeight: number,
  quality?: StandardCardCapture['radiosity'],
): CardRadiosityPlan {
  if (
    ![cardResolution, atlasWidth, atlasHeight].every((n) => Number.isSafeInteger(n) && n > 0) ||
    atlasWidth % cardResolution !== 0 ||
    atlasHeight % cardResolution !== 0
  )
    throw new RangeError('Card radiosity requires a whole-tile surface atlas');
  const probeSpacing = quality?.probeSpacing ?? 4;
  const hemisphereResolution = quality?.hemisphereResolution ?? 4;
  const tileCapacity = (atlasWidth / cardResolution) * (atlasHeight / cardResolution);
  const probesPerCardAxis = Math.ceil(cardResolution / probeSpacing);
  const probesPerCard = probesPerCardAxis ** 2;
  const probeCount = tileCapacity * probesPerCard;
  const raysPerProbe = hemisphereResolution ** 2;
  const traceBytes = probeCount * raysPerProbe * 32;
  const visibilityBytes = (tileCapacity * cardResolution ** 2 + probeCount + tileCapacity) * 16;
  if (!Number.isSafeInteger(traceBytes) || !Number.isSafeInteger(visibilityBytes))
    throw new RangeError('Card radiosity atlas exceeds integer range');
  return Object.freeze({
    cardResolution,
    tileCapacity,
    probeSpacing,
    probesPerCardAxis,
    probesPerCard,
    probeCount,
    hemisphereResolution,
    raysPerProbe,
    traceBytes,
    shBytes: probeCount * 48,
    metaBytes: probeCount * 16,
    visibilityBytes,
  });
}

/** Resource ownership is the field's existing allocation/lifetime, including
 * partial-creation failure and outstanding-submission retirement. Never create
 * another scene registry or independently retire a shared field buffer. */
export function allocateCardRadiosity<T>(
  plan: CardRadiosityPlan,
  allocate: (label: string, size: number, usage?: number) => T,
) {
  return {
    frame: allocate('card-radiosity-frame', 64, 64 | 8),
    pages: allocate('card-radiosity-pages', plan.tileCapacity * 4),
    // Persistent world origins followed by this frame's compact trace roster.
    origins: allocate('card-radiosity-origins', plan.probeCount * 64),
    bounce: allocate('card-radiosity-bounce', plan.tileCapacity * plan.cardResolution ** 2 * 16),
    indirect: allocate(
      'card-radiosity-indirect',
      plan.tileCapacity * plan.cardResolution ** 2 * 16,
    ),
    trace: allocate('card-radiosity-trace', plan.traceBytes),
    filtered: allocate('card-radiosity-filtered', plan.traceBytes),
    sh: allocate('card-radiosity-sh', plan.shBytes),
    meta: allocate('card-radiosity-meta', plan.metaBytes),
    visibility: allocate('card-radiosity-visibility', plan.visibilityBytes),
  };
}

export function packCardRadiosityFrame(
  plan: CardRadiosityPlan,
  update: CardRadiosityUpdate,
  frame: number,
  tileCount: number,
  atlasWidth: number,
): Uint32Array {
  return Uint32Array.of(
    plan.probesPerCardAxis,
    plan.probeSpacing,
    plan.raysPerProbe,
    update.epoch,
    update.tiles.length,
    frame,
    tileCount,
    0,
    atlasWidth,
    plan.probeCount,
    atlasWidth / plan.cardResolution,
    plan.cardResolution,
    0,
    0,
    0,
    0,
  );
}

export interface CardRadiosityUpdate {
  readonly epoch: number;
  readonly tiles: readonly number[];
}

/** Submission authority only. Per-probe GPU availability remains in meta;
 * selecting/committing a page cannot certify all of its trace samples. */
export class CardRadiositySchedule {
  readonly #epochs: Uint32Array;
  readonly #ages: Float64Array;
  readonly #budget: number;
  #epoch = 0;
  #frame = 0;
  #invalidation = 0;
  #pending: CardRadiosityUpdate | undefined;

  constructor(
    readonly capacity: number,
    budget = Math.max(1, Math.ceil(capacity / 64)),
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(budget) ||
      budget < 1
    )
      throw new RangeError('Card radiosity requires positive page capacity and update budget');
    this.#epochs = new Uint32Array(capacity);
    this.#ages = new Float64Array(capacity);
    this.#budget = Math.min(capacity, budget);
  }

  invalidate(runs: readonly { readonly first: number; readonly end: number }[]): void {
    for (const run of runs) {
      if (
        !Number.isSafeInteger(run.first) ||
        !Number.isSafeInteger(run.end) ||
        run.first < 0 ||
        run.end > this.capacity ||
        run.end < run.first
      )
        throw new RangeError('Card radiosity invalidation is outside its allocation');
    }
    for (const run of runs) this.#epochs.fill(0, run.first, run.end);
    this.#invalidation++;
    this.#pending = undefined;
  }

  /** The field upload observes this authority before reusing GPU history. */
  get invalidation(): number {
    return this.#invalidation;
  }

  select(epoch: number, count = this.capacity): CardRadiosityUpdate {
    if (
      !Number.isSafeInteger(epoch) ||
      epoch < 1 ||
      epoch > 0xffffffff ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > this.capacity
    )
      throw new RangeError('Card radiosity requires a current source epoch and bounded page count');
    if (epoch !== this.#epoch) {
      this.#epochs.fill(0);
      this.#epoch = epoch;
      this.#pending = undefined;
    }
    if (this.#pending?.tiles.every((tile) => tile < count)) return this.#pending;
    const tiles = Array.from({ length: count }, (_, i) => i);
    tiles.sort(
      (a, b) =>
        Number(this.#epochs[a] === epoch) - Number(this.#epochs[b] === epoch) ||
        Number(this.#ages[a]) - Number(this.#ages[b]) ||
        a - b,
    );
    this.#pending = Object.freeze({ epoch, tiles: Object.freeze(tiles.slice(0, this.#budget)) });
    return this.#pending;
  }

  valid(tile: number, epoch: number): boolean {
    return epoch === this.#epoch && epoch > 0 && this.#epochs[tile] === epoch;
  }

  commit(update: CardRadiosityUpdate): boolean {
    if (update !== this.#pending || update.epoch !== this.#epoch) return false;
    this.#frame++;
    for (const tile of update.tiles) {
      this.#epochs[tile] = update.epoch;
      this.#ages[tile] = this.#frame;
    }
    this.#pending = undefined;
    return true;
  }
}
