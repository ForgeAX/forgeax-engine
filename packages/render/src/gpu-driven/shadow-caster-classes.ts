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
  /**
   * Every caster, static or dynamic: a single-layer view draws all of them.
   * The disjoint union of the two classes, not a third membership tree.
   */
  readonly casterSlots: ShadowSlotSelection;
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

const DECLARED = 1;
const ALWAYS_DYNAMIC = 2;
const DYNAMIC = 4;
const CREATED = 8;
const PENDING = 16;
const PRESENT = 32;

/**
 * Caster facts as slot-indexed numeric columns: flag bits, generation,
 * settle threshold, last promotion frame and pending deadline (NaN = none).
 */
class CasterColumns {
  flags = new Uint8Array(64);
  generation = new Uint32Array(64);
  threshold = new Float64Array(64);
  promotedAt = new Float64Array(64);
  timer = new Float64Array(64);

  ensure(slot: number): void {
    if (slot < this.flags.length) return;
    let capacity = this.flags.length;
    while (capacity <= slot) capacity *= 2;
    const flags = new Uint8Array(capacity);
    flags.set(this.flags);
    this.flags = flags;
    const generation = new Uint32Array(capacity);
    generation.set(this.generation);
    this.generation = generation;
    const threshold = new Float64Array(capacity);
    threshold.set(this.threshold);
    this.threshold = threshold;
    const promotedAt = new Float64Array(capacity);
    promotedAt.set(this.promotedAt);
    this.promotedAt = promotedAt;
    const timer = new Float64Array(capacity);
    timer.set(this.timer);
    this.timer = timer;
  }

  has(slot: number): boolean {
    return ((this.flags[slot] ?? 0) & PRESENT) !== 0;
  }

  is(slot: number, bit: number): boolean {
    return ((this.flags[slot] ?? 0) & bit) !== 0;
  }

  set(slot: number, bit: number, value: boolean): void {
    const flags = this.flags[slot] ?? 0;
    this.flags[slot] = value ? flags | bit : flags & ~bit;
  }
}

function casterClasses(staticSlots: FrameSet, dynamicSlots: FrameSet): ShadowCasterClasses {
  return Object.freeze({
    staticSlots,
    dynamicSlots,
    casterSlots: new ShadowSlotSelection([staticSlots, dynamicSlots]),
  });
}

/**
 * Known transitions are batched until the next snapshot, which copies each
 * touched numeric page once; snapshots borrow the fixed root.
 */
class SlotClass {
  private slots = new FrameSet();
  private readonly pending = new Map<number, boolean>();
  set(slot: number, present: boolean): void {
    this.pending.set(slot, present);
  }
  snapshot(): FrameSet {
    if (this.pending.size > 0) {
      this.slots = this.slots.edit(this.pending);
      this.pending.clear();
    }
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
  private readonly rows = new CasterColumns();
  private readonly timers = new Map<number, Set<number>>();
  private readonly staticSlots = new SlotClass();
  private readonly dynamicSlots = new SlotClass();
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
  private classes: ShadowCasterClasses = casterClasses(
    this.staticSlots.snapshot(),
    this.dynamicSlots.snapshot(),
  );

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
    const rows = this.rows;
    if (changed === undefined) {
      if (previous !== undefined) this.historyGaps++;
      const seen = new Set<number>();
      for (const row of source.slots) {
        seen.add(row.slot);
        this.accept(row, previous === undefined);
      }
      for (let slot = 0; slot < rows.flags.length; slot++)
        if (rows.has(slot) && !seen.has(slot)) this.remove(slot);
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
      for (const slot of due) {
        rows.timer[slot] = Number.NaN;
        if (rows.is(slot, DYNAMIC)) {
          if (this.frame % SHADOW_CASTER_PROMOTE_WINDOW !== 0) {
            rows.set(slot, PENDING, true);
            this.pendingPromotions++;
            this.schedule(slot, this.window(this.frame));
            continue;
          }
          this.clearPending(slot);
          this.changeClass(slot, false, true);
          if (!rows.is(slot, CREATED)) {
            rows.promotedAt[slot] = this.frame;
            this.schedule(slot, this.window(this.frame + (rows.threshold[slot] ?? 0)));
          }
          rows.set(slot, CREATED, false);
        } else {
          const threshold = rows.threshold[slot] ?? 0;
          if (threshold <= SHADOW_CASTER_SETTLE_FRAMES) rows.promotedAt[slot] = Number.NaN;
          else {
            rows.threshold[slot] = threshold / 2;
            rows.promotedAt[slot] = this.frame;
            this.schedule(slot, this.window(this.frame + threshold / 2));
          }
        }
      }
    }
    const staticSlots = this.staticSlots.snapshot();
    const dynamicSlots = this.dynamicSlots.snapshot();
    if (staticSlots !== this.classes.staticSlots || dynamicSlots !== this.classes.dynamicSlots)
      this.classes = casterClasses(staticSlots, dynamicSlots);
    return this.classes;
  }

  private accept(source: ShadowCasterSlot, initial: boolean): void {
    const { slot, generation = 0, snapshot } = source;
    if (snapshot.shadowCaster === false || snapshot.authorVisible === false) {
      this.remove(slot, true);
      return;
    }
    const rows = this.rows;
    let present = rows.has(slot);
    const replaced = present && rows.generation[slot] !== generation;
    if (replaced) {
      this.remove(slot, false);
      this.replacements++;
      present = false;
    }
    const alwaysDynamic =
      snapshot.skinBinding !== undefined || snapshot.spriteInstances !== undefined;
    const declared = !alwaysDynamic && snapshot.mobility === 'static';
    if (!present) {
      if (!replaced) this.creations++;
      const dynamic = alwaysDynamic || (!initial && !declared);
      rows.ensure(slot);
      rows.generation[slot] = generation;
      rows.flags[slot] =
        PRESENT |
        CREATED |
        (declared ? DECLARED : 0) |
        (alwaysDynamic ? ALWAYS_DYNAMIC : 0) |
        (dynamic ? DYNAMIC : 0);
      rows.threshold[slot] = SHADOW_CASTER_SETTLE_FRAMES;
      rows.promotedAt[slot] = Number.NaN;
      rows.timer[slot] = Number.NaN;
      this.declared += Number(declared);
      this.alwaysDynamic += Number(alwaysDynamic);
      this.changeClass(slot, dynamic, false);
      if (dynamic && !alwaysDynamic) this.schedule(slot, this.frame + SHADOW_CASTER_PROMOTE_WINDOW);
      return;
    }
    const wasDeclared = rows.is(slot, DECLARED);
    const wasAlwaysDynamic = rows.is(slot, ALWAYS_DYNAMIC);
    const newlyDeclared = declared && !wasDeclared;
    const newlySettleable = wasAlwaysDynamic && !alwaysDynamic;
    this.declared += Number(declared) - Number(wasDeclared);
    this.alwaysDynamic += Number(alwaysDynamic) - Number(wasAlwaysDynamic);
    rows.set(slot, DECLARED, declared);
    rows.set(slot, ALWAYS_DYNAMIC, alwaysDynamic);
    this.cancel(slot);
    if (newlyDeclared || alwaysDynamic) {
      rows.threshold[slot] = SHADOW_CASTER_SETTLE_FRAMES;
      rows.promotedAt[slot] = Number.NaN;
      rows.set(slot, CREATED, false);
      this.changeClass(slot, alwaysDynamic, true);
      return;
    }
    if (newlySettleable) {
      rows.set(slot, CREATED, true);
      rows.threshold[slot] = SHADOW_CASTER_SETTLE_FRAMES;
      rows.promotedAt[slot] = Number.NaN;
    } else {
      this.contentChanges++;
      rows.set(slot, CREATED, false);
      const promotedAt = rows.promotedAt[slot] ?? Number.NaN;
      const threshold = rows.threshold[slot] ?? 0;
      if (
        !rows.is(slot, DYNAMIC) &&
        !Number.isNaN(promotedAt) &&
        this.frame - promotedAt < threshold
      )
        rows.threshold[slot] = Math.min(SHADOW_CASTER_SETTLE_MAX, threshold * 2);
    }
    this.changeClass(slot, true, true);
    this.schedule(
      slot,
      this.frame +
        (rows.is(slot, CREATED) ? SHADOW_CASTER_PROMOTE_WINDOW : (rows.threshold[slot] ?? 0)),
    );
  }

  private changeClass(slot: number, dynamic: boolean, count: boolean): void {
    if (count && dynamic !== this.rows.is(slot, DYNAMIC)) {
      this.flips++;
      if (dynamic) this.demotions++;
      else this.promotions++;
    }
    this.rows.set(slot, DYNAMIC, dynamic);
    this.staticSlots.set(slot, !dynamic);
    this.dynamicSlots.set(slot, dynamic);
  }

  private remove(slot: number, count = true): void {
    const rows = this.rows;
    if (!rows.has(slot)) return;
    this.cancel(slot);
    this.declared -= Number(rows.is(slot, DECLARED));
    this.alwaysDynamic -= Number(rows.is(slot, ALWAYS_DYNAMIC));
    rows.flags[slot] = 0;
    this.staticSlots.set(slot, false);
    this.dynamicSlots.set(slot, false);
    if (count) this.removals++;
  }

  private clearPending(slot: number): void {
    if (this.rows.is(slot, PENDING)) this.pendingPromotions--;
    this.rows.set(slot, PENDING, false);
  }

  private cancel(slot: number): void {
    this.clearPending(slot);
    const timer = this.rows.timer[slot] ?? Number.NaN;
    if (Number.isNaN(timer)) return;
    const bucket = this.timers.get(timer);
    bucket?.delete(slot);
    if (bucket?.size === 0) this.timers.delete(timer);
    this.rows.timer[slot] = Number.NaN;
  }

  private schedule(slot: number, frame: number): void {
    this.rows.timer[slot] = frame;
    let bucket = this.timers.get(frame);
    if (bucket === undefined) {
      bucket = new Set();
      this.timers.set(frame, bucket);
    }
    bucket.add(slot);
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

/**
 * The union of disjoint fixed roots, optionally restricted by an allowed root.
 * A view query reads the roots directly; no union or intersection membership
 * is materialized, so the caster set costs no tree beside its static and
 * dynamic classes.
 */
export class ShadowSlotSelection implements Iterable<number> {
  #members: readonly FrameSet[];
  #allowed: FrameSet | ShadowSlotSelection | undefined;
  constructor(members: FrameSet | readonly FrameSet[], allowed?: FrameSet | ShadowSlotSelection) {
    const roots = FrameSet.isFixed(members) ? [members] : [...members];
    if (
      roots.length === 0 ||
      !roots.every((root) => FrameSet.isFixed(root)) ||
      (allowed !== undefined && !FrameSet.isFixed(allowed) && !ShadowSlotSelection.isFixed(allowed))
    )
      throw new TypeError('Shadow selection requires intrinsic fixed numeric roots');
    this.#members = Object.freeze(roots);
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
  /**
   * Equal admitted sets. Distinct member roots still compare equal when their
   * union is unchanged (a caster moving between classes), found by walking
   * only the copied tree paths.
   */
  same(other: ShadowSlotSelection): boolean {
    const allowed = this.#allowed;
    const previous = other.#allowed;
    if (
      allowed !== previous &&
      !(
        ShadowSlotSelection.isFixed(allowed) &&
        ShadowSlotSelection.isFixed(previous) &&
        allowed.same(previous)
      )
    )
      return false;
    const members = this.#members;
    const others = other.#members;
    if (members.length !== others.length) return false;
    let identical = true;
    for (let index = 0; index < members.length; index++)
      if (members[index] !== others[index]) identical = false;
    if (identical) return true;
    if (members.length === 1) return false;
    let differs = false;
    const visit = (slot: number) => {
      if (!differs && this.#member(slot) !== other.#member(slot)) differs = true;
    };
    for (let index = 0; index < members.length && !differs; index++)
      (members[index] as FrameSet).changesSince(others[index] as FrameSet, visit);
    return !differs;
  }
  #member(slot: number): boolean {
    for (const root of this.#members) if (root.has(slot)) return true;
    return false;
  }
  has(slot: number): boolean {
    return this.#member(slot) && (this.#allowed === undefined || this.#allowed.has(slot));
  }
  get size(): number {
    if (this.#allowed === undefined) {
      let size = 0;
      for (const root of this.#members) size += root.size;
      return size;
    }
    let size = 0;
    for (const _slot of this) size++;
    return size;
  }
  /** Admitted slots in ascending order, merged across the disjoint roots. */
  *[Symbol.iterator](): Iterator<number> {
    const iterators = this.#members.map((root) => root.values());
    const heads = iterators.map((iterator) => iterator.next());
    const allowed = this.#allowed;
    for (;;) {
      let lowest = -1;
      for (let index = 0; index < heads.length; index++) {
        const head = heads[index] as IteratorResult<number>;
        if (head.done !== true && (lowest < 0 || head.value < (heads[lowest]?.value as number)))
          lowest = index;
      }
      if (lowest < 0) return;
      const slot = (heads[lowest] as IteratorYieldResult<number>).value;
      heads[lowest] = (iterators[lowest] as Iterator<number>).next();
      if (allowed === undefined || allowed.has(slot)) yield slot;
    }
  }
  /**
   * Visit every slot whose admission may differ from `before`; `false` when
   * the two selections are not built from comparable roots. A slot moving
   * between two member roots keeps its union membership and is not visited.
   */
  changesSince(before: ShadowSlotSelection, visit: (slot: number) => void): boolean {
    const members = this.#members;
    const previousMembers = before.#members;
    if (members.length !== previousMembers.length) return false;
    const allowed = this.#allowed;
    const previous = before.#allowed;
    if ((allowed === undefined) !== (previous === undefined)) return false;
    if (allowed !== undefined && previous !== undefined) {
      if (FrameSet.isFixed(allowed) !== FrameSet.isFixed(previous)) return false;
      if (FrameSet.isFixed(allowed) && FrameSet.isFixed(previous))
        allowed.changesSince(previous, visit);
      else if (
        !(allowed as ShadowSlotSelection).changesSince(previous as ShadowSlotSelection, visit)
      )
        return false;
    }
    const single = members.length === 1;
    const visitMember = single
      ? visit
      : (slot: number) => {
          if (this.#member(slot) !== before.#member(slot)) visit(slot);
        };
    for (let index = 0; index < members.length; index++)
      (members[index] as FrameSet).changesSince(previousMembers[index] as FrameSet, visitMember);
    return true;
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
    allowed = FrameSet.from(
      (function* () {
        for (const slot of candidates) if (Number.isSafeInteger(slot) && slot >= 0) yield slot;
      })(),
    );
  }
  const dynamicSlots = new ShadowSlotSelection(classes.dynamicSlots, allowed);
  const casterSlots = new ShadowSlotSelection([classes.staticSlots, classes.dynamicSlots], allowed);
  return Object.freeze({
    staticSlots: new ShadowSlotSelection(classes.staticSlots, allowed),
    dynamicSlots,
    casterSlots,
  });
}
