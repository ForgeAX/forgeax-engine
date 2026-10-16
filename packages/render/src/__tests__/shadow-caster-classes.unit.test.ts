import { describe, expect, it } from 'vitest';
import {
  SHADOW_CASTER_PROMOTE_WINDOW,
  SHADOW_CASTER_SETTLE_FRAMES,
  SHADOW_CASTER_SETTLE_MAX,
  ShadowCasterClassifier,
} from '../gpu-driven/shadow-caster-classes';

function fakeScene() {
  const state = { revision: 0, changed: [] as readonly number[] | undefined };
  return {
    state,
    scene: {
      get contentRevision() {
        return state.revision;
      },
      changedSlotsSince: () => state.changed,
    },
    change(slots: readonly number[] | undefined): void {
      state.revision += 1;
      state.changed = slots;
    },
    quiet(): void {
      state.changed = [];
    },
  };
}

const rigid = (slot: number) => ({ slot, snapshot: {} });

/** Runs quiet frames so a later change is not a periodic mover's. */
function rest(
  classifier: ShadowCasterClassifier,
  slots: readonly { slot: number; snapshot: object }[],
  scene: ReturnType<typeof fakeScene>['scene'],
): void {
  for (let frame = 0; frame < SHADOW_CASTER_SETTLE_FRAMES; frame += 1)
    classifier.update(slots, scene);
}

/** Updates until the given slots are static; returns the frames it took. */
function framesUntilStatic(
  classifier: ShadowCasterClassifier,
  slots: readonly { slot: number; snapshot: object }[],
  scene: ReturnType<typeof fakeScene>['scene'],
  slot: number,
  limit = 4 * SHADOW_CASTER_SETTLE_MAX,
): number {
  for (let frame = 1; frame <= limit; frame += 1) {
    if (classifier.update(slots, scene).staticSlots.includes(slot)) return frame;
  }
  return Number.POSITIVE_INFINITY;
}

describe('ShadowCasterClassifier', () => {
  it('starts the first population static and promotes later casters after one window', () => {
    const fake = fakeScene();
    const slots = [rigid(0), rigid(1), { slot: 2, snapshot: { skin: {} } }];
    const classifier = new ShadowCasterClassifier();
    const first = classifier.update(slots, fake.scene);
    expect(first.staticSlots).toEqual([0, 1]);
    expect(first.dynamicSlots).toEqual([2]);
    expect(classifier.inspect().pendingPromotions).toBe(0);
    // A caster created after the first update waits one window.
    const later = [...slots, rigid(3)];
    fake.change([3]);
    let frame = 1;
    let promotedAt = 0;
    for (; frame < 4 * SHADOW_CASTER_SETTLE_FRAMES; ) {
      frame += 1;
      const classes = classifier.update(later, fake.scene);
      fake.quiet();
      if (classes.staticSlots.includes(3)) {
        promotedAt = frame;
        expect(classes.staticSlots).toEqual([0, 1, 3]);
        expect(classifier.inspect().flips).toBe(1);
        break;
      }
      expect(classes.staticSlots).toEqual([0, 1]);
    }
    expect(promotedAt % SHADOW_CASTER_PROMOTE_WINDOW).toBe(0);
    expect(promotedAt - 2).toBeGreaterThanOrEqual(SHADOW_CASTER_PROMOTE_WINDOW);
    expect(promotedAt - 2).toBeLessThan(2 * SHADOW_CASTER_PROMOTE_WINDOW);
    const settled = classifier.update(later, fake.scene);
    expect(classifier.inspect()).toMatchObject({ flips: 0, pendingPromotions: 0 });
    expect(classifier.update(later, fake.scene)).toBe(settled);
  });

  it('keeps created casters dynamic so spawns never touch the static layer', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    const slots = [rigid(0)];
    expect(framesUntilStatic(classifier, slots, fake.scene, 0)).toBeLessThan(Infinity);
    const settled = classifier.update(slots, fake.scene);
    // A spawn storm: a fresh caster every frame, each despawned the next frame.
    for (let spawn = 1; spawn <= 3 * SHADOW_CASTER_SETTLE_FRAMES; spawn += 1) {
      const slot = 1000 + spawn;
      fake.change([slot, slot - 1]);
      const classes = classifier.update([rigid(0), rigid(slot)], fake.scene);
      expect(classes.staticSlots).toBe(settled.staticSlots);
      expect(classifier.inspect().flips).toBe(0);
    }
  });

  it('moves a changed caster to the dynamic layer at once and back after settling', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    const slots = [rigid(0), rigid(1)];
    framesUntilStatic(classifier, slots, fake.scene, 1);
    rest(classifier, slots, fake.scene);
    fake.change([1]);
    const moved = classifier.update(slots, fake.scene);
    expect(moved.staticSlots).toEqual([0]);
    expect(moved.dynamicSet.has(1)).toBe(true);
    expect(classifier.inspect().flips).toBe(1);
    fake.quiet();
    const frames = framesUntilStatic(classifier, slots, fake.scene, 1);
    expect(frames).toBeGreaterThanOrEqual(SHADOW_CASTER_SETTLE_FRAMES - 1);
    expect(frames).toBeLessThan(SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW);
  });

  it('treats every caster as changed when the change history cannot prove otherwise', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    const slots = [rigid(0), rigid(1), { slot: 2, snapshot: { skin: {} } }];
    framesUntilStatic(classifier, slots, fake.scene, 1);
    rest(classifier, slots, fake.scene);
    // A history gap or resync: a moved caster must never stay in the static layer.
    fake.change(undefined);
    const unproven = classifier.update(slots, fake.scene);
    expect(unproven.staticSlots).toEqual([]);
    expect(unproven.dynamicSlots).toEqual([0, 1, 2]);
    fake.quiet();
    expect(framesUntilStatic(classifier, slots, fake.scene, 0)).toBeLessThan(
      SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW,
    );
  });

  it('backs off a periodic mover and recovers once it stays still', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    const slots = [rigid(0)];
    framesUntilStatic(classifier, slots, fake.scene, 0);
    // Moving 150 frames apart: every move lands within one threshold of the
    // previous promotion, so the threshold doubles past the period.
    let flips = 0;
    for (let frame = 1; frame <= 150 * 20; frame += 1) {
      if (frame % 150 === 0) fake.change([0]);
      else fake.quiet();
      classifier.update(slots, fake.scene);
      flips += classifier.inspect().flips;
    }
    // Without backoff a 150-frame mover flips twice per period (40 times here).
    expect(flips).toBeLessThanOrEqual(4);
    fake.quiet();
    const recovery = framesUntilStatic(classifier, slots, fake.scene, 0);
    expect(recovery).toBeGreaterThan(SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW);
    expect(recovery).toBeLessThanOrEqual(SHADOW_CASTER_SETTLE_MAX + SHADOW_CASTER_PROMOTE_WINDOW);
    // Staying static halves the threshold back to the base.
    for (let frame = 0; frame < 2 * SHADOW_CASTER_SETTLE_MAX; frame += 1) {
      classifier.update(slots, fake.scene);
    }
    fake.change([0]);
    classifier.update(slots, fake.scene);
    fake.quiet();
    expect(framesUntilStatic(classifier, slots, fake.scene, 0)).toBeLessThan(
      SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW,
    );
  });

  it('places Mobility static casters in the static layer from their first update', () => {
    const fake = fakeScene();
    const declared = (slot: number) => ({ slot, snapshot: { mobility: 'static' as const } });
    const skinned = { slot: 2, snapshot: { skin: {}, mobility: 'static' as const } };
    const slots = [declared(0), skinned];
    const classifier = new ShadowCasterClassifier();
    const first = classifier.update(slots, fake.scene);
    expect(first.staticSlots).toEqual([0]);
    expect(first.dynamicSlots).toEqual([2]);
    expect(classifier.inspect().flips).toBe(0);

    // A declared caster created mid-run joins at once, without a window wait;
    // an undeclared one waits.
    fake.change([1, 3]);
    const created = classifier.update([declared(0), rigid(1), skinned, declared(3)], fake.scene);
    expect(created.staticSlots).toEqual([0, 3]);
    expect(created.dynamicSlots).toEqual([1, 2]);
  });

  it('settles a caster at once when it gains the declaration', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    classifier.update([rigid(0)], fake.scene);
    fake.change([0]);
    expect(
      classifier.update([{ slot: 0, snapshot: { mobility: 'static' } }], fake.scene).staticSlots,
    ).toEqual([0]);
  });

  it('derives a declared caster that changes anyway, so a broken promise stays correct', () => {
    const fake = fakeScene();
    const slots = [{ slot: 0, snapshot: { mobility: 'static' as const } }];
    const classifier = new ShadowCasterClassifier();
    classifier.update(slots, fake.scene);
    fake.change([0]);
    expect(classifier.update(slots, fake.scene).dynamicSlots).toEqual([0]);
    fake.quiet();
    const frames = framesUntilStatic(classifier, slots, fake.scene, 0);
    expect(frames).toBeGreaterThanOrEqual(SHADOW_CASTER_SETTLE_FRAMES - 1);
    expect(frames).toBeLessThan(SHADOW_CASTER_SETTLE_FRAMES + SHADOW_CASTER_PROMOTE_WINDOW);
  });

  it('treats a caster in a reused slot as created, not as its predecessor changing', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    const declared = { slot: 0, generation: 0, snapshot: { mobility: 'static' as const } };
    classifier.update([declared, rigid(1)], fake.scene);
    // Both occupants leave and new casters take their slots before the next update.
    fake.change([0, 1]);
    const successors = [
      { slot: 0, generation: 1, snapshot: { mobility: 'static' as const } },
      { slot: 1, generation: 1, snapshot: {} },
    ];
    const replaced = classifier.update(successors, fake.scene);
    // The declared newcomer keeps its promise; neither replacement is a flip.
    expect(replaced.staticSlots).toEqual([0]);
    expect(replaced.dynamicSlots).toEqual([1]);
    expect(classifier.inspect().flips).toBe(0);
    fake.quiet();
    // The undeclared newcomer waits one creation window, not a settle threshold.
    const frames = framesUntilStatic(classifier, successors, fake.scene, 1);
    expect(frames).toBeLessThanOrEqual(2 * SHADOW_CASTER_PROMOTE_WINDOW);
  });
});

it('counts classification attempts, transitions and population without exposing mutable state', () => {
  const fake = fakeScene();
  const classifier = new ShadowCasterClassifier();
  const slots = [rigid(0), rigid(1), { slot: 2, snapshot: { skin: {} } }];
  classifier.update(slots, fake.scene);
  const first = classifier.inspect();
  expect(first).toMatchObject({
    staticCount: 2,
    dynamicCount: 1,
    alwaysDynamicCount: 1,
    creations: 3,
    updates: 1,
    promotions: 0,
    demotions: 0,
  });
  fake.change([1]);
  classifier.update(slots, fake.scene);
  expect(classifier.inspect()).toMatchObject({
    staticCount: 1,
    dynamicCount: 2,
    demotions: 1,
    contentChanges: 1,
  });
  fake.quiet();
  framesUntilStatic(classifier, slots, fake.scene, 1);
  expect(classifier.inspect()).toMatchObject({ promotions: 1, demotions: 1 });
  const replaced = [{ ...rigid(1), generation: 2 }];
  fake.change([1]);
  classifier.update(replaced, fake.scene);
  expect(classifier.inspect()).toMatchObject({
    replacements: 1,
    removals: 2,
    promotions: 1,
    demotions: 1,
  });
  expect(first).toMatchObject({ staticCount: 2, updates: 1, promotions: 0, demotions: 0 });
});
