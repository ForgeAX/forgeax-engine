import type { SceneContentCursor } from '../gpu-scene-content-boxes';
import type { FrameList } from '../scene/frame-list';
import { FrameSet } from '../scene/frame-set';
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
  /** Retained diagnostic field. Authored mobility has no pending deadlines. */
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
    readonly gpuVertexSource?: unknown;
    readonly instances?: unknown;
    readonly morph?: unknown;
  };
}

interface ShadowCasterScene {
  readonly contentCursor: SceneContentCursor;
  changedSlotsSince(since: SceneContentCursor): readonly number[] | undefined;
}

const PRESENT = 1;
const DECLARED = 2;
const DEFORMING = 4;
const STATIC = 8;
type ShadowCasterSource = {
  readonly slots: FrameList<ShadowCasterSlot>;
  slotAt(slot: number): ShadowCasterSlot | undefined;
};

function casterClasses(staticSlots: FrameSet, dynamicSlots: FrameSet): ShadowCasterClasses {
  return Object.freeze({
    staticSlots,
    dynamicSlots,
    casterSlots: new ShadowSlotSelection([staticSlots, dynamicSlots]),
  });
}

function sameCasterSlots(left: FrameSet, right: FrameSet): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  let same = true;
  left.changesSince(right, () => {
    same = false;
  });
  return same;
}

/** A static layer admits explicitly stationary rigid casters. A change to a
 * declared caster invalidates its promise until a new declaration or generation.
 * Published membership is immutable. Preview edits only touched membership pages. */
export class ShadowCasterClassifier {
  private content: SceneContentCursor | undefined;
  private flags = new Uint8Array(0);
  private generations = new Uint32Array(0);
  private classes = casterClasses(new FrameSet(), new FrameSet());
  private updates = 0;
  private flips = 0;
  private declared = 0;
  private deforming = 0;
  private promotions = 0;
  private demotions = 0;
  private creations = 0;
  private removals = 0;
  private replacements = 0;
  private contentChanges = 0;
  private historyGaps = 0;

  preview(source: ShadowCasterSource, scene: ShadowCasterScene): ShadowCasterClasses {
    return this.project(source, scene, false);
  }

  preparationCurrent(prepared: ShadowCasterClasses): () => boolean {
    const before = this.classes;
    return () =>
      this.classes === before ||
      this.classes === prepared ||
      (sameCasterSlots(this.classes.staticSlots, prepared.staticSlots) &&
        sameCasterSlots(this.classes.dynamicSlots, prepared.dynamicSlots));
  }

  update(source: ShadowCasterSource, scene: ShadowCasterScene): ShadowCasterClasses {
    this.flips = 0;
    this.updates++;
    this.classes = this.project(source, scene, true);
    this.content = scene.contentCursor;
    return this.classes;
  }

  private project(
    source: ShadowCasterSource,
    scene: ShadowCasterScene,
    publish: boolean,
  ): ShadowCasterClasses {
    const changes = this.content === undefined ? undefined : scene.changedSlotsSince(this.content);
    if (changes?.length === 0) return this.classes;
    const statics = new Map<number, boolean>();
    const dynamics = new Map<number, boolean>();
    const visit = (slot: number, row: ShadowCasterSlot | undefined) => {
      const before = this.flags[slot] ?? 0;
      const snapshot = row?.snapshot;
      let flags = 0;
      const generation = row?.generation ?? 0;
      const replaced = before !== 0 && this.generations[slot] !== generation;
      if (
        snapshot !== undefined &&
        snapshot.shadowCaster !== false &&
        snapshot.authorVisible !== false
      ) {
        flags = PRESENT;
        if (
          snapshot.skinBinding !== undefined ||
          snapshot.spriteInstances !== undefined ||
          snapshot.instances !== undefined ||
          snapshot.gpuVertexSource !== undefined ||
          snapshot.morph !== undefined
        )
          flags |= DEFORMING;
        else if (snapshot.mobility === 'static') {
          flags |= DECLARED;
          if ((before & DECLARED) === 0 || replaced) flags |= STATIC;
        }
      }
      const wasStatic = (before & STATIC) !== 0;
      const isStatic = (flags & STATIC) !== 0;
      if (wasStatic !== isStatic) statics.set(slot, isStatic);
      const wasDynamic = before !== 0 && !wasStatic;
      const isDynamic = flags !== 0 && !isStatic;
      if (wasDynamic !== isDynamic) dynamics.set(slot, isDynamic);
      if (!publish) return;
      if (flags === 0 && before === 0) return;
      if (before === 0) this.creations++;
      else if (flags === 0) this.removals++;
      else if (replaced) this.replacements++;
      else {
        this.contentChanges++;
        if (wasStatic !== isStatic) {
          this.flips++;
          if (isStatic) this.promotions++;
          else this.demotions++;
        }
      }
      this.declared += Number((flags & DECLARED) !== 0) - Number((before & DECLARED) !== 0);
      this.deforming += Number((flags & DEFORMING) !== 0) - Number((before & DEFORMING) !== 0);
      if (slot >= this.flags.length) {
        const size = Math.max(slot + 1, this.flags.length * 2, 64);
        const grown = new Uint8Array(size);
        grown.set(this.flags);
        this.flags = grown;
        const generations = new Uint32Array(size);
        generations.set(this.generations);
        this.generations = generations;
      }
      this.flags[slot] = flags;
      this.generations[slot] = generation;
    };
    if (changes === undefined) {
      if (publish && this.content !== undefined) this.historyGaps++;
      for (const slot of this.classes.casterSlots)
        if (source.slotAt(slot) === undefined) visit(slot, undefined);
      for (const row of source.slots) visit(row.slot, row);
    } else {
      // A journal may mention a slot more than once, including replacement.
      for (const slot of new Set(changes)) visit(slot, source.slotAt(slot));
    }
    if (statics.size === 0 && dynamics.size === 0) return this.classes;
    return casterClasses(
      this.classes.staticSlots.edit(statics),
      this.classes.dynamicSlots.edit(dynamics),
    );
  }

  release(): void {
    if (this.content === undefined) return;
    this.content = undefined;
    this.flags = new Uint8Array(0);
    this.generations = new Uint32Array(0);
    this.classes = casterClasses(new FrameSet(), new FrameSet());
    this.declared = this.deforming = this.flips = 0;
  }

  inspect(): ShadowCasterClassInspection {
    return {
      flips: this.flips,
      pendingPromotions: 0,
      staticCount: this.classes.staticSlots.size,
      dynamicCount: this.classes.dynamicSlots.size,
      declaredStaticCount: this.declared,
      alwaysDynamicCount: this.deforming,
      updates: this.updates,
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
  /** A fixed upper bound, derived once from the existing source membership. */
  readonly #boundSize: number;
  readonly #memberSize: number;
  readonly #domain: FrameSet | ShadowSlotSelection | undefined;
  #size: number | undefined;
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
    let memberSize = 0;
    for (const root of roots) memberSize += root.size;
    const allowedBound =
      allowed === undefined
        ? memberSize
        : FrameSet.isFixed(allowed)
          ? allowed.size
          : allowed.#boundSize;
    this.#memberSize = memberSize;
    this.#boundSize = Math.min(memberSize, allowedBound);
    this.#domain = allowedBound < memberSize ? allowed : undefined;
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
    if (this.#allowed === undefined) return this.#memberSize;
    if (this.#boundSize === 0) return 0;
    if (this.#size !== undefined) return this.#size;
    let size = 0;
    for (const _slot of this) size++;
    this.#size = size;
    return size;
  }
  /** Admitted slots in ascending order, starting at the smaller fixed domain. */
  *[Symbol.iterator](): Iterator<number> {
    if (this.#boundSize === 0) return;
    const domain = this.#domain;
    if (domain !== undefined) {
      const keys = FrameSet.isFixed(domain) ? domain.borrowKeys() : domain;
      let previous = -1;
      for (const slot of keys) {
        if (slot === previous) continue;
        previous = slot;
        // Restriction membership is boolean; preserve the members' multiplicity.
        for (const root of this.#members) if (root.has(slot)) yield slot;
      }
      return;
    }
    const iterators = this.#members.map((root) => root.borrowKeys());
    try {
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
    } finally {
      for (const iterator of iterators) iterator.return?.();
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
