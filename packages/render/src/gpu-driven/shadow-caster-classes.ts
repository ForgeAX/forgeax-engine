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
  readonly staticSlots: readonly number[];
  readonly dynamicSlots: readonly number[];
  readonly dynamicSet: ReadonlySet<number>;
  /** Dynamic casters left in directional views once capsule-ready casters leave. */
  readonly directionalDynamicSlots: readonly number[];
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
    readonly skin?: unknown;
    readonly spriteInstances?: unknown;
    readonly capsuleShadow?: { readonly status: string };
    readonly mobility?: 'static';
  };
}

interface ShadowCasterScene {
  readonly contentRevision: number;
  changedSlotsSince(revision: number): readonly number[] | undefined;
}

/**
 * Splits shadow casters into a settled static class and a dynamic class.
 * Skinned and sprite casters are always dynamic. A rigid caster declared
 * `Mobility static` is static from the update it first appears (or gains the
 * declaration) in, skipping observation; a later change of that caster takes
 * the derived path below, so a broken promise still renders correctly. Every
 * caster present at the first update is the level and starts static; a later
 * created caster stays dynamic for one {@link SHADOW_CASTER_PROMOTE_WINDOW};
 * a changed caster stays dynamic until it has been unchanged for its settle
 * threshold ({@link SHADOW_CASTER_SETTLE_FRAMES}). Either then joins the static
 * class on the next window boundary. A caster that changes
 * again within one threshold of its promotion is a periodic mover: its
 * threshold doubles up to {@link SHADOW_CASTER_SETTLE_MAX}, and halves back
 * for every threshold it then stays static. When the scene cannot prove which
 * slots changed, every caster counts as changed. With capsule shadows on,
 * capsule-ready (always skinned, so dynamic) casters are dropped from the
 * directional dynamic class; other views keep them. A slot reused by another
 * caster since the previous update holds a created caster, not a changed one.
 * Unchanged classes keep their array identities so cached views stay hits.
 */
export class ShadowCasterClassifier {
  private frame = 0;
  private revision: number | undefined;
  private readonly changedAt = new Map<number, number>();
  /** Settle threshold and last promotion frame of recently promoted casters. */
  private readonly settled = new Map<number, { threshold: number; promotedAt: number }>();
  /** Rigid casters declared `Mobility static` at the previous update. */
  private declared = new Set<number>();
  /** Settleable casters at the previous update. */
  private known = new Set<number>();
  /** Pending casters whose only observation is their creation. */
  private readonly created = new Set<number>();
  /** Slot generations at the previous update. */
  private generations = new Map<number, number>();
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
    staticSlots: Object.freeze([]),
    dynamicSlots: Object.freeze([]),
    dynamicSet: new Set<number>(),
    directionalDynamicSlots: Object.freeze([]),
  });

  update(
    slots: readonly ShadowCasterSlot[],
    scene: ShadowCasterScene,
    capsuleShadowDirectional = false,
  ): ShadowCasterClasses {
    this.frame += 1;
    const frame = this.frame;
    const previousRevision = this.revision;
    this.revision = scene.contentRevision;
    const changed =
      previousRevision === undefined ? undefined : scene.changedSlotsSince(previousRevision);
    // A reused slot's bookkeeping belongs to its previous occupant.
    const generations = new Map<number, number>();
    const replaced = new Set<number>();
    for (const { slot, generation = 0 } of slots) {
      generations.set(slot, generation);
      const previous = this.generations.get(slot);
      if (previous === undefined) this.creations += 1;
      else if (previous !== generation) replaced.add(slot);
    }
    for (const slot of this.generations.keys()) if (!generations.has(slot)) this.removals += 1;
    this.replacements += replaced.size;
    this.generations = generations;
    for (const slot of replaced) {
      this.known.delete(slot);
      this.declared.delete(slot);
      this.changedAt.delete(slot);
      this.settled.delete(slot);
      this.created.delete(slot);
    }
    // Only casters that can settle are tracked: skinned and sprite casters are
    // always dynamic, and removed casters leave the bookkeeping.
    const settleable = new Set<number>();
    const declared = new Set<number>();
    for (const { slot, snapshot } of slots) {
      if (snapshot.skin !== undefined || snapshot.spriteInstances !== undefined) continue;
      settleable.add(slot);
      if (snapshot.mobility === 'static') declared.add(slot);
    }
    // A caster that appears with, or gains, the declaration is settled by
    // promise; its creation or declaration change is not a move.
    const newlyDeclared = new Set<number>();
    for (const slot of declared) if (!this.declared.has(slot)) newlyDeclared.add(slot);
    this.declared = declared;
    for (const slot of this.changedAt.keys())
      if (!settleable.has(slot)) this.changedAt.delete(slot);
    for (const slot of this.settled.keys()) if (!settleable.has(slot)) this.settled.delete(slot);
    for (const slot of this.created) if (!settleable.has(slot)) this.created.delete(slot);
    const known = this.known;
    this.known = settleable;
    // The first population is the level itself and starts static.
    for (const slot of previousRevision === undefined ? [] : settleable) {
      if (known.has(slot) || newlyDeclared.has(slot)) continue;
      this.changedAt.set(slot, frame);
      this.created.add(slot);
    }
    if (previousRevision !== undefined && changed === undefined) this.historyGaps += 1;
    // A history gap cannot prove any known caster settled.
    for (const slot of changed ?? (previousRevision === undefined ? [] : settleable)) {
      if (!known.has(slot) || !settleable.has(slot) || newlyDeclared.has(slot)) continue;
      this.contentChanges += 1;
      this.created.delete(slot);
      this.noteChanged(slot, frame);
    }
    for (const slot of newlyDeclared) {
      this.changedAt.delete(slot);
      this.settled.delete(slot);
      this.created.delete(slot);
    }
    const promote = frame % SHADOW_CASTER_PROMOTE_WINDOW === 0;
    let pending = 0;
    for (const [slot, at] of this.changedAt) {
      const created = this.created.has(slot);
      const threshold = created
        ? SHADOW_CASTER_PROMOTE_WINDOW
        : (this.settled.get(slot)?.threshold ?? SHADOW_CASTER_SETTLE_FRAMES);
      if (frame - at < threshold) continue;
      if (!promote) {
        pending += 1;
        continue;
      }
      this.changedAt.delete(slot);
      // A creation promotion is no periodic-mover evidence.
      if (created) this.created.delete(slot);
      else this.settled.set(slot, { threshold, promotedAt: frame });
    }
    if (promote) {
      for (const [slot, entry] of this.settled) {
        if (this.changedAt.has(slot) || frame - entry.promotedAt < entry.threshold) continue;
        if (entry.threshold <= SHADOW_CASTER_SETTLE_FRAMES) {
          this.settled.delete(slot);
          continue;
        }
        entry.threshold /= 2;
        entry.promotedAt = frame;
      }
    }
    this.pendingPromotions = pending;
    const staticSlots: number[] = [];
    const dynamicSlots: number[] = [];
    const directionalDynamicSlots: number[] = [];
    for (const { slot, snapshot } of slots) {
      const dynamic = !settleable.has(slot) || this.changedAt.has(slot);
      (dynamic ? dynamicSlots : staticSlots).push(slot);
      if (dynamic && !(capsuleShadowDirectional && snapshot.capsuleShadow?.status === 'ready')) {
        directionalDynamicSlots.push(slot);
      }
    }
    const previous = this.classes;
    const sameStatic = sameSlots(previous.staticSlots, staticSlots);
    const sameDynamic = sameSlots(previous.dynamicSlots, dynamicSlots);
    const sameDirectional = sameSlots(previous.directionalDynamicSlots, directionalDynamicSlots);
    const flips = sameStatic
      ? { promotions: 0, demotions: 0 }
      : countFlips(previous, dynamicSlots, staticSlots, replaced);
    this.flips = flips.promotions + flips.demotions;
    this.promotions += flips.promotions;
    this.demotions += flips.demotions;
    if (sameStatic && sameDynamic && sameDirectional) return previous;
    const nextDynamic = sameDynamic ? previous.dynamicSlots : Object.freeze(dynamicSlots);
    this.classes = Object.freeze({
      staticSlots: sameStatic ? previous.staticSlots : Object.freeze(staticSlots),
      dynamicSlots: nextDynamic,
      dynamicSet: sameDynamic ? previous.dynamicSet : new Set(dynamicSlots),
      directionalDynamicSlots: sameDirectional
        ? previous.directionalDynamicSlots
        : sameSlots(nextDynamic, directionalDynamicSlots)
          ? nextDynamic
          : Object.freeze(directionalDynamicSlots),
    });
    return this.classes;
  }

  inspect(): ShadowCasterClassInspection {
    return {
      flips: this.flips,
      pendingPromotions: this.pendingPromotions,
      staticCount: this.classes.staticSlots.length,
      dynamicCount: this.classes.dynamicSlots.length,
      declaredStaticCount: this.declared.size,
      alwaysDynamicCount: this.generations.size - this.known.size,
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

  /** A change within one threshold of a promotion marks a periodic mover. */
  private noteChanged(slot: number, frame: number): void {
    const entry = this.settled.get(slot);
    if (
      entry !== undefined &&
      !this.changedAt.has(slot) &&
      frame - entry.promotedAt < entry.threshold
    ) {
      entry.threshold = Math.min(SHADOW_CASTER_SETTLE_MAX, entry.threshold * 2);
    }
    this.changedAt.set(slot, frame);
  }
}

/** Existing casters that changed class; created and removed casters are not flips. */
function countFlips(
  previous: ShadowCasterClasses,
  dynamicSlots: readonly number[],
  staticSlots: readonly number[],
  replaced: ReadonlySet<number>,
): { promotions: number; demotions: number } {
  const previousStatic = new Set(previous.staticSlots);
  let demotions = 0;
  let promotions = 0;
  for (const slot of dynamicSlots)
    if (previousStatic.has(slot) && !replaced.has(slot)) demotions += 1;
  for (const slot of staticSlots)
    if (previous.dynamicSet.has(slot) && !replaced.has(slot)) promotions += 1;
  return { promotions, demotions };
}

const restrictedClasses = new WeakMap<
  readonly number[] | ReadonlySet<number>,
  { readonly source: ShadowCasterClasses; readonly restricted: ShadowCasterClasses }
>();

/** Restricts caster classes to a view's own candidate subset, stable per pair. */
export function restrictShadowCasterClasses(
  classes: ShadowCasterClasses,
  candidates: readonly number[] | ReadonlySet<number> | undefined,
): ShadowCasterClasses {
  if (candidates === undefined) return classes;
  const cached = restrictedClasses.get(candidates);
  if (cached?.source === classes) return cached.restricted;
  const allowed = new Set(candidates);
  const dynamicSlots = Object.freeze(classes.dynamicSlots.filter((slot) => allowed.has(slot)));
  const restricted = Object.freeze({
    staticSlots: Object.freeze(classes.staticSlots.filter((slot) => allowed.has(slot))),
    dynamicSlots,
    dynamicSet: classes.dynamicSet,
    directionalDynamicSlots:
      classes.directionalDynamicSlots === classes.dynamicSlots
        ? dynamicSlots
        : Object.freeze(classes.directionalDynamicSlots.filter((slot) => allowed.has(slot))),
  });
  restrictedClasses.set(candidates, { source: classes, restricted });
  return restricted;
}

function sameSlots(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
