import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
/** Frames without a change before a changed caster settles into the static layer. */
export const SHADOW_CASTER_SETTLE_FRAMES = 100;
/**
 * Settled casters join the static layer together on window boundaries, so a
 * retained static view pays at most one membership refresh per window instead
 * of one per caster. Promotion may lag: until then the caster draws as dynamic.
 * A created caster that has not changed since only waits one window: creation
 * is no evidence of motion, and short-lived spawns still never join.
 */
export const SHADOW_CASTER_PROMOTE_WINDOW = 16;
/** Upper bound of a periodic mover's backed-off settle threshold. */
export const SHADOW_CASTER_SETTLE_MAX = 1600;

export interface ShadowCasterClasses {
  readonly staticSlots: FrameSet;
  readonly dynamicSlots: FrameSet;
  /** Every caster, static or dynamic: a single-layer view draws all of them. */
  readonly casterSlots: FrameSet;
}

export interface ShadowCasterClassInspection {
  /** Existing casters that changed class in the last update, both directions. */
  readonly flips: number;
  /** Settled dynamic casters waiting for the next promotion window. */
  readonly pendingPromotions: number;
  /** GPU scene slots classified before per-view caster selection, not object/triangle counts. */
  readonly staticCount: number;
  readonly dynamicCount: number;
  readonly declaredStaticCount: number;
  readonly alwaysDynamicCount: number;
  /** Cumulative classification attempts, including preparations whose submit later aborts. */
  readonly updates: number;
  readonly promotions: number;
  readonly demotions: number;
  readonly creations: number;
  readonly removals: number;
  readonly replacements: number;
  readonly contentChanges: number;
  readonly historyGaps: number;
}

interface ShadowCasterSlot {
  readonly slot: number;
  /** Bumped when the slot is reused by another caster; absent reads as 0. */
  readonly generation?: number;
  readonly snapshot: {
    readonly shadowCaster?: false;
    readonly authorVisible?: boolean;
    readonly skinBinding?: unknown;
    readonly spriteInstances?: unknown;
    readonly mobility?: 'static';
  };
}

interface ShadowCasterScene {
  readonly contentRevision: number;
  changedSlotsSince(revision: number): readonly number[] | undefined;
}

interface CasterState {
  readonly slot: number;
  readonly generation: number;
  declared: boolean;
  alwaysDynamic: boolean;
  dynamic: boolean;
  created: boolean;
  threshold: number;
  promotedAt: number | undefined;
  timer: number | undefined;
  pending: boolean;
}

/** Known transitions copy one numeric path; snapshots borrow the fixed root. */
class SlotClass {
  private slots = new FrameSet();
  set(slot: number, present: boolean): void {
    this.slots = present ? this.slots.with(slot) : this.slots.without(slot);
  }
  snapshot(): FrameSet {
    return this.slots;
  }
}

/**
 * Object changes arrive from the scene journal, independently of material adoption.
 * Only initial attachment and explicit history loss enumerate the source roster.
 * Each settling caster owns one cancellable deadline; quiet frames inspect no
 * objects or pending movers. Promotion and backoff retain the existing windows.
 */
export class ShadowCasterClassifier {
  private frame = 0;
  private revision: number | undefined;
  private readonly rows = new Map<number, CasterState>();
  private readonly timers = new Map<number, Set<CasterState>>();
  private readonly staticSlots = new SlotClass();
  private readonly dynamicSlots = new SlotClass();
  private readonly casterSlots = new SlotClass();
  private declared = 0;
  private alwaysDynamic = 0;
  private flips = 0;
  private pendingPromotions = 0;
  private promotions = 0;
  private demotions = 0;
  private creations = 0;
  private removals = 0;
  private replacements = 0;
  private contentChanges = 0;
  private historyGaps = 0;
  private classes: ShadowCasterClasses = Object.freeze({
    staticSlots: this.staticSlots.snapshot(),
    dynamicSlots: this.dynamicSlots.snapshot(),
    casterSlots: this.casterSlots.snapshot(),
  });

  update(
    source: {
      readonly slots: FrameList<ShadowCasterSlot>;
      slotAt(slot: number): ShadowCasterSlot | undefined;
    },
    scene: ShadowCasterScene,
  ): ShadowCasterClasses {
    this.frame++;
    this.flips = 0;
    const previous = this.revision;
    const changed = previous === undefined ? undefined : scene.changedSlotsSince(previous);
    this.revision = scene.contentRevision;
    if (changed === undefined) {
      if (previous !== undefined) this.historyGaps++;
      const remaining = new Set(this.rows.keys());
      for (const row of source.slots) {
        remaining.delete(row.slot);
        this.accept(row, previous === undefined);
      }
      for (const slot of remaining) this.remove(slot);
    } else if (changed.length > 0) {
      for (const slot of new Set(changed)) {
        const row = source.slotAt(slot);
        if (row === undefined) this.remove(slot);
        else this.accept(row, false);
      }
    }
    const due = this.timers.get(this.frame);
    if (due !== undefined) {
      this.timers.delete(this.frame);
      for (const row of due) {
        row.timer = undefined;
        if (row.dynamic) {
          if (this.frame % SHADOW_CASTER_PROMOTE_WINDOW !== 0) {
            row.pending = true;
            this.pendingPromotions++;
            this.schedule(row, this.window(this.frame));
            continue;
          }
          this.clearPending(row);
          this.changeClass(row, false, true);
          if (!row.created) {
            row.promotedAt = this.frame;
            this.schedule(row, this.window(this.frame + row.threshold));
          }
          row.created = false;
        } else {
          if (row.threshold <= SHADOW_CASTER_SETTLE_FRAMES) row.promotedAt = undefined;
          else {
            row.threshold /= 2;
            row.promotedAt = this.frame;
            this.schedule(row, this.window(this.frame + row.threshold));
          }
        }
      }
    }
    const staticSlots = this.staticSlots.snapshot();
    const dynamicSlots = this.dynamicSlots.snapshot();
    const casterSlots = this.casterSlots.snapshot();
    if (
      staticSlots !== this.classes.staticSlots ||
      dynamicSlots !== this.classes.dynamicSlots ||
      casterSlots !== this.classes.casterSlots
    ) {
      this.classes = Object.freeze({ staticSlots, dynamicSlots, casterSlots });
    }
    return this.classes;
  }

  private accept(source: ShadowCasterSlot, initial: boolean): void {
    const { slot, generation = 0, snapshot } = source;
    if (snapshot.shadowCaster === false || snapshot.authorVisible === false) {
      this.remove(slot, true);
      return;
    }
    let row = this.rows.get(slot);
    const replaced = row !== undefined && row.generation !== generation;
    if (replaced) {
      this.remove(slot, false);
      this.replacements++;
      row = undefined;
    }
    const alwaysDynamic =
      snapshot.skinBinding !== undefined || snapshot.spriteInstances !== undefined;
    const declared = !alwaysDynamic && snapshot.mobility === 'static';
    if (row === undefined) {
      if (!replaced) this.creations++;
      row = {
        slot,
        generation,
        declared,
        alwaysDynamic,
        dynamic: alwaysDynamic || (!initial && !declared),
        created: true,
        threshold: SHADOW_CASTER_SETTLE_FRAMES,
        promotedAt: undefined,
        timer: undefined,
        pending: false,
      };
      this.rows.set(slot, row);
      this.declared += Number(declared);
      this.alwaysDynamic += Number(alwaysDynamic);
      this.changeClass(row, row.dynamic, false);
      if (row.dynamic && !alwaysDynamic)
        this.schedule(row, this.frame + SHADOW_CASTER_PROMOTE_WINDOW);
      return;
    }
    const newlyDeclared = declared && !row.declared;
    const newlySettleable = row.alwaysDynamic && !alwaysDynamic;
    this.declared += Number(declared) - Number(row.declared);
    this.alwaysDynamic += Number(alwaysDynamic) - Number(row.alwaysDynamic);
    row.declared = declared;
    row.alwaysDynamic = alwaysDynamic;
    this.cancel(row);
    if (newlyDeclared || alwaysDynamic) {
      row.threshold = SHADOW_CASTER_SETTLE_FRAMES;
      row.promotedAt = undefined;
      row.created = false;
      this.changeClass(row, alwaysDynamic, true);
      return;
    }
    if (newlySettleable) {
      row.created = true;
      row.threshold = SHADOW_CASTER_SETTLE_FRAMES;
      row.promotedAt = undefined;
    } else {
      this.contentChanges++;
      row.created = false;
      if (
        !row.dynamic &&
        row.promotedAt !== undefined &&
        this.frame - row.promotedAt < row.threshold
      )
        row.threshold = Math.min(SHADOW_CASTER_SETTLE_MAX, row.threshold * 2);
    }
    this.changeClass(row, true, true);
    this.schedule(row, this.frame + (row.created ? SHADOW_CASTER_PROMOTE_WINDOW : row.threshold));
  }

  private changeClass(row: CasterState, dynamic: boolean, count: boolean): void {
    if (count && dynamic !== row.dynamic) {
      this.flips++;
      if (dynamic) this.demotions++;
      else this.promotions++;
    }
    row.dynamic = dynamic;
    this.staticSlots.set(row.slot, !dynamic);
    this.dynamicSlots.set(row.slot, dynamic);
    this.casterSlots.set(row.slot, true);
  }

  private remove(slot: number, count = true): void {
    const row = this.rows.get(slot);
    if (row === undefined) return;
    this.cancel(row);
    this.rows.delete(slot);
    this.declared -= Number(row.declared);
    this.alwaysDynamic -= Number(row.alwaysDynamic);
    this.staticSlots.set(slot, false);
    this.dynamicSlots.set(slot, false);
    this.casterSlots.set(slot, false);
    if (count) this.removals++;
  }

  private clearPending(row: CasterState): void {
    if (row.pending) this.pendingPromotions--;
    row.pending = false;
  }

  private cancel(row: CasterState): void {
    this.clearPending(row);
    if (row.timer === undefined) return;
    const bucket = this.timers.get(row.timer);
    bucket?.delete(row);
    if (bucket?.size === 0) this.timers.delete(row.timer);
    row.timer = undefined;
  }

  private schedule(row: CasterState, frame: number): void {
    row.timer = frame;
    let bucket = this.timers.get(frame);
    if (bucket === undefined) {
      bucket = new Set();
      this.timers.set(frame, bucket);
    }
    bucket.add(row);
  }

  private window(frame: number): number {
    return Math.ceil(frame / SHADOW_CASTER_PROMOTE_WINDOW) * SHADOW_CASTER_PROMOTE_WINDOW;
  }

  inspect(): ShadowCasterClassInspection {
    return {
      flips: this.flips,
      pendingPromotions: this.pendingPromotions,
      staticCount: this.classes.staticSlots.size,
      dynamicCount: this.classes.dynamicSlots.size,
      declaredStaticCount: this.declared,
      alwaysDynamicCount: this.alwaysDynamic,
      updates: this.frame,
      promotions: this.promotions,
      demotions: this.demotions,
      creations: this.creations,
      removals: this.removals,
      replacements: this.replacements,
      contentChanges: this.contentChanges,
      historyGaps: this.historyGaps,
    };
  }
}

/** A view query reads both fixed roots; no intersection membership is maintained. */
export class ShadowSlotSelection {
  #members: FrameSet;
  #allowed: FrameSet | ShadowSlotSelection;
  constructor(members: FrameSet, allowed: FrameSet | ShadowSlotSelection) {
    if (
      !FrameSet.isFixed(members) ||
      (!FrameSet.isFixed(allowed) && !ShadowSlotSelection.isFixed(allowed))
    )
      throw new TypeError('Shadow selection requires intrinsic fixed numeric roots');
    this.#members = members;
    this.#allowed = allowed;
    Object.freeze(this);
  }
  static isFixed(value: unknown): value is ShadowSlotSelection {
    return (
      typeof value === 'object' &&
      value !== null &&
      #members in value &&
      Object.getPrototypeOf(value) === ShadowSlotSelection.prototype
    );
  }
  same(other: ShadowSlotSelection): boolean {
    return (
      this.#members === other.#members &&
      (this.#allowed === other.#allowed ||
        (ShadowSlotSelection.isFixed(this.#allowed) &&
          ShadowSlotSelection.isFixed(other.#allowed) &&
          this.#allowed.same(other.#allowed)))
    );
  }
  has(slot: number): boolean {
    return this.#members.has(slot) && this.#allowed.has(slot);
  }
}

/** Raw restrictions are observed at this actual query; native roots are borrowed. */
export function restrictShadowCasterClasses(
  classes: ShadowCasterClasses,
  candidates: readonly number[] | ReadonlySet<number> | ShadowSlotSelection | undefined,
) {
  if (candidates === undefined) return classes;
  let allowed: FrameSet | ShadowSlotSelection;
  if (FrameSet.isFixed(candidates) || ShadowSlotSelection.isFixed(candidates)) allowed = candidates;
  else {
    let root = new FrameSet();
    for (const slot of candidates)
      if (Number.isSafeInteger(slot) && slot >= 0) root = root.with(slot);
    allowed = root;
  }
  const dynamicSlots = new ShadowSlotSelection(classes.dynamicSlots, allowed);
  const casterSlots = new ShadowSlotSelection(classes.casterSlots, allowed);
  return Object.freeze({
    staticSlots: new ShadowSlotSelection(classes.staticSlots, allowed),
    dynamicSlots,
    casterSlots,
  });
}
