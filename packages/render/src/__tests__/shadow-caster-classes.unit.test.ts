import { describe, expect, it, vi } from 'vitest';
import {
  restrictShadowCasterClasses,
  ShadowCasterClassifier,
  ShadowSlotSelection,
} from '../gpu-driven/shadow-caster-classes';
import type { SceneContentCursor } from '../gpu-scene-content-boxes';
import { FrameSet } from '../scene/frame-set';
import { RowChangeLog } from '../scene/row-change-log';

function fakeScene() {
  const state = { revision: 0, changed: [] as readonly number[] | undefined };
  const journal = new RowChangeLog();
  let cursor: SceneContentCursor = { journal, position: 0 };
  return {
    state,
    scene: {
      get contentCursor() {
        if (cursor.position !== state.revision) cursor = { journal, position: state.revision };
        return cursor;
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

function classify(
  classifier: ShadowCasterClassifier,
  slots: Parameters<ShadowCasterClassifier['update']>[0]['slots'],
  scene: ReturnType<typeof fakeScene>['scene'],
) {
  const rows = new Map(slots.map((row) => [row.slot, row]));
  return classifier.update({ slots, slotAt: (slot) => rows.get(slot) }, scene);
}

const rigid = (slot: number) => ({ slot, snapshot: {} });
const stationary = (slot: number) => ({ slot, snapshot: { mobility: 'static' as const } });

it('keeps a preparation current after its exact prepared caster layout is accepted', () => {
  const classifier = new ShadowCasterClassifier();
  const scene = fakeScene();
  const previous = [rigid(0)];
  classify(classifier, previous, scene.scene);
  const fixed = (slot: number) => ({ slot, snapshot: { mobility: 'static' as const } });
  const slots = [...previous, fixed(1)];
  scene.change([1]);
  const expected = classifier.preview({ slots, slotAt: (slot) => slots[slot] }, scene.scene);
  const current = classifier.preparationCurrent(expected);
  expect(current()).toBe(true);
  expect(classify(classifier, slots, scene.scene).staticSlots.has(1)).toBe(true);
  expect(current()).toBe(true);

  scene.change([1, 2]);
  classify(classifier, [...previous, fixed(2)], scene.scene);
  expect(current()).toBe(false);
});

it('previews the next real classification without modifying the accepted caster classes', () => {
  const classifier = new ShadowCasterClassifier(),
    scene = fakeScene();
  let slots = [rigid(0)];
  const input = () => ({ slots, slotAt: (slot: number) => slots.find((row) => row.slot === slot) });
  for (let frame = 0; frame < 132; frame++) {
    if (frame === 2) {
      slots = [...slots, rigid(1)];
      scene.change([1]);
    }
    if (frame === 5) scene.change([0]);
    const before = classifier.inspect();
    const projected = classifier.preview(input(), scene.scene);
    expect(classifier.inspect()).toEqual(before);
    const second = classifier.preview(input(), scene.scene);
    const actual = classifier.update(input(), scene.scene);
    for (const slot of [0, 1]) {
      expect(projected.staticSlots.has(slot)).toBe(actual.staticSlots.has(slot));
      expect(second.dynamicSlots.has(slot)).toBe(actual.dynamicSlots.has(slot));
    }
    scene.quiet();
  }
});

describe('ShadowCasterClassifier', () => {
  it('updates one known caster without enumerating clean class membership', () => {
    const fake = fakeScene();
    const slots = Array.from({ length: 1000 }, (_, slot) => stationary(slot));
    const classifier = new ShadowCasterClassifier();
    const source = { slots, slotAt: (slot: number) => slots[slot] };
    const before = classifier.update(source, fake.scene);
    fake.change([500]);
    const iterate = Set.prototype[Symbol.iterator];
    let after: ReturnType<ShadowCasterClassifier['update']>;
    Set.prototype[Symbol.iterator] = function () {
      if (this.size > 16)
        throw new Error('Unchanged caster class enumerated during one transition');
      return iterate.call(this);
    };
    try {
      after = classifier.update(source, fake.scene);
    } finally {
      Set.prototype[Symbol.iterator] = iterate;
    }
    expect([...before.staticSlots]).toHaveLength(1000);
    expect([...after.staticSlots]).toHaveLength(999);
    expect([...after.dynamicSlots]).toEqual([500]);
    expect([...before.staticSlots]).toContain(500);
  });

  it('keeps undeclared and periodically moving casters dynamic throughout 6400 frames', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    const rows = [stationary(0), rigid(1), stationary(2)];
    for (let frame = 0; frame < 6400; frame++) {
      if (frame % 100 === 1) fake.change([2]);
      else fake.quiet();
      const classes = classify(classifier, rows, fake.scene);
      expect(classes.dynamicSlots.has(1)).toBe(true);
      expect(classes.staticSlots.has(2)).toBe(frame === 0);
      expect(classes.staticSlots.has(0)).toBe(true);
    }
    expect(classifier.inspect()).toMatchObject({
      promotions: 0,
      demotions: 1,
      pendingPromotions: 0,
    });
  });

  it('keeps the static population fixed during continuous spawn and despawn', () => {
    const fake = fakeScene(),
      classifier = new ShadowCasterClassifier();
    const initial = classify(classifier, [stationary(0)], fake.scene);
    for (let frame = 1; frame <= 300; frame++) {
      const slot = frame + 1000;
      fake.change([slot, slot - 1, slot]);
      const classes = classify(classifier, [stationary(0), rigid(slot)], fake.scene);
      expect(classes.staticSlots).toBe(initial.staticSlots);
      expect([...classes.dynamicSlots]).toEqual([slot]);
    }
  });

  it('demotes unproven survivors after journal loss and honors new generations', () => {
    const fake = fakeScene(),
      classifier = new ShadowCasterClassifier();
    const initial = [stationary(0), stationary(1), rigid(2)];
    classify(classifier, initial, fake.scene);
    fake.change(undefined);
    const changed = classify(
      classifier,
      [stationary(0), { ...stationary(1), generation: 1 }],
      fake.scene,
    );
    expect([...changed.staticSlots]).toEqual([1]);
    expect([...changed.dynamicSlots]).toEqual([0]);
    expect(classifier.inspect()).toMatchObject({ replacements: 1, removals: 1, historyGaps: 1 });
  });

  it.each([
    'skinBinding',
    'spriteInstances',
    'gpuVertexSource',
    'instances',
    'morph',
  ])('keeps deforming %s draws dynamic even with an explicit static declaration', (field) => {
    const fake = fakeScene(),
      classifier = new ShadowCasterClassifier();
    const classes = classify(
      classifier,
      [{ slot: 1, snapshot: { mobility: 'static', [field]: {} } }],
      fake.scene,
    );
    expect([...classes.dynamicSlots]).toEqual([1]);
    expect(classifier.inspect().alwaysDynamicCount).toBe(1);
  });

  it('places Mobility static casters in the static layer from their first update', () => {
    const fake = fakeScene();
    const declared = (slot: number) => ({ slot, snapshot: { mobility: 'static' as const } });
    const skinned = {
      slot: 2,
      snapshot: { skinBinding: { skeleton: 1, joints: [2] }, mobility: 'static' as const },
    };
    const slots = [declared(0), skinned];
    const classifier = new ShadowCasterClassifier();
    const first = classify(classifier, slots, fake.scene);
    expect([...first.staticSlots]).toEqual([0]);
    expect([...first.dynamicSlots]).toEqual([2]);
    expect(classifier.inspect().flips).toBe(0);

    // A declared caster created mid-run joins at once, without a window wait;
    // an undeclared one stays dynamic.
    fake.change([1, 3]);
    const created = classify(classifier, [declared(0), rigid(1), skinned, declared(3)], fake.scene);
    expect([...created.staticSlots]).toEqual([0, 3]);
    expect([...created.dynamicSlots]).toEqual([1, 2]);
  });

  it('settles a caster at once when it gains the declaration', () => {
    const fake = fakeScene();
    const classifier = new ShadowCasterClassifier();
    classify(classifier, [rigid(0)], fake.scene);
    fake.change([0]);
    expect([
      ...classify(classifier, [{ slot: 0, snapshot: { mobility: 'static' } }], fake.scene)
        .staticSlots,
    ]).toEqual([0]);
  });

  it('derives a declared caster that changes anyway, so a broken promise stays correct', () => {
    const fake = fakeScene();
    const slots = [{ slot: 0, snapshot: { mobility: 'static' as const } }];
    const classifier = new ShadowCasterClassifier();
    classify(classifier, slots, fake.scene);
    fake.change([0]);
    expect([...classify(classifier, slots, fake.scene).dynamicSlots]).toEqual([0]);
    fake.quiet();
    fake.change([0]);
    classify(classifier, [rigid(0)], fake.scene);
    fake.change([0]);
    expect([...classify(classifier, slots, fake.scene).staticSlots]).toEqual([0]);
    expect(classifier.inspect()).toMatchObject({
      promotions: 1,
      demotions: 1,
      pendingPromotions: 0,
    });
  });
});

it('does no population reads for material-only revisions and visits only a changed slot', () => {
  const fake = fakeScene();
  const rows = new Map(Array.from({ length: 50_000 }, (_, slot) => [slot, stationary(slot)]));
  let rosterReads = 0,
    slotReads = 0;
  const source = {
    get slots() {
      rosterReads++;
      return [...rows.values()];
    },
    slotAt(slot: number) {
      slotReads++;
      return rows.get(slot);
    },
  };
  const classifier = new ShadowCasterClassifier();
  classifier.update(source, fake.scene);
  rosterReads = slotReads = 0;
  fake.change([]);
  const stable = classifier.update(source, fake.scene);
  expect({ rosterReads, slotReads }).toEqual({ rosterReads: 0, slotReads: 0 });
  fake.change([11]);
  const moved = classifier.update(source, fake.scene);
  expect({ rosterReads, slotReads }).toEqual({ rosterReads: 0, slotReads: 1 });
  expect([...moved.dynamicSlots]).toEqual([11]);
  fake.change([]);
  expect(classifier.update(source, fake.scene)).toBe(moved);
  expect({ rosterReads, slotReads }).toEqual({ rosterReads: 0, slotReads: 1 });
  fake.quiet();
  for (let index = 0; index < 116; index++) classifier.update(source, fake.scene);
  expect(classifier.inspect().staticCount).toBe(stable.staticSlots.size - 1);
  expect({ rosterReads, slotReads }).toEqual({ rosterReads: 0, slotReads: 1 });
});

it('routes cast and visibility changes through the slot journal and retires removed sources', () => {
  const fake = fakeScene();
  const classifier = new ShadowCasterClassifier();
  for (const snapshot of [
    { mobility: 'static' as const, shadowCaster: false as const },
    { mobility: 'static' as const },
    { mobility: 'static' as const, authorVisible: false },
    { mobility: 'static' as const, authorVisible: true },
    { mobility: 'static' as const, shadowCaster: false as const },
  ]) {
    const visible = snapshot.shadowCaster !== false && snapshot.authorVisible !== false;
    fake.change([0]);
    const classes = classify(classifier, [{ slot: 0, snapshot }], fake.scene);
    expect([...classes.staticSlots]).toEqual(visible ? [0] : []);
    expect([...classes.dynamicSlots]).toEqual([]);
    expect(classifier.inspect().pendingPromotions).toBe(0);
  }
});

it('intersects fixed caster roots only in actual membership reads and observes raw restrictions', () => {
  const fake = fakeScene();
  const slots = Array.from({ length: 1000 }, (_, slot) => stationary(slot));
  const classifier = new ShadowCasterClassifier();
  const source = { slots, slotAt: (slot: number) => slots[slot] };
  const initial = classifier.update(source, fake.scene);
  const allowed = new FrameSet().with(1).with(999);
  const iterate = FrameSet.prototype[Symbol.iterator];
  let selected: ReturnType<typeof restrictShadowCasterClasses>;
  FrameSet.prototype[Symbol.iterator] = () => {
    throw new Error('Fixed membership enumerated for a restriction update');
  };
  try {
    selected = restrictShadowCasterClasses(initial, allowed);
    fake.change([1]);
    const moved = classifier.update(source, fake.scene);
    const next = restrictShadowCasterClasses(moved, allowed);
    if (next.staticSlots.has(1) || !next.dynamicSlots.has(1) || !next.staticSlots.has(999))
      throw new Error('Wrong class restriction after one known transition');
  } finally {
    FrameSet.prototype[Symbol.iterator] = iterate;
  }
  expect(selected.staticSlots.has(1)).toBe(true);
  expect(selected.staticSlots.has(0)).toBe(false);
  const equal = restrictShadowCasterClasses(initial, allowed);
  expect(ShadowSlotSelection.isFixed(selected.staticSlots)).toBe(true);
  expect(ShadowSlotSelection.isFixed(equal.staticSlots)).toBe(true);
  if (
    !ShadowSlotSelection.isFixed(selected.staticSlots) ||
    !ShadowSlotSelection.isFixed(equal.staticSlots)
  )
    throw new Error('Missing fixed selection');
  expect(selected.staticSlots.same(equal.staticSlots)).toBe(true);
  const raw = [0];
  const before = restrictShadowCasterClasses(initial, raw);
  raw[0] = 999;
  const after = restrictShadowCasterClasses(initial, raw);
  expect(before.staticSlots.has(0)).toBe(true);
  expect(before.staticSlots.has(999)).toBe(false);
  expect(after.staticSlots.has(0)).toBe(false);
  expect(after.staticSlots.has(999)).toBe(true);
});

it('derives the caster set as the static/dynamic union without a third tree', () => {
  const of = (...slots: number[]) => slots.reduce((set, slot) => set.with(slot), new FrameSet());
  const statics = of(0, 2, 4);
  const dynamics = of(1, 5);
  const casters = new ShadowSlotSelection([statics, dynamics]);
  expect([...casters]).toEqual([0, 1, 2, 4, 5]);
  expect(casters.size).toBe(5);
  expect(casters.has(1) && casters.has(4) && !casters.has(3)).toBe(true);
  // A caster flipping class keeps the union: equal, and no slot changes.
  const flipped = new ShadowSlotSelection([statics.without(4), dynamics.with(4)]);
  expect(flipped.same(casters)).toBe(true);
  const visited: number[] = [];
  expect(flipped.changesSince(casters, (slot) => visited.push(slot))).toBe(true);
  expect(visited).toEqual([]);
  // A created caster changes the union and is visited once.
  const created = new ShadowSlotSelection([statics, dynamics.with(3)]);
  expect(created.same(casters)).toBe(false);
  expect(created.changesSince(casters, (slot) => visited.push(slot))).toBe(true);
  expect(visited).toEqual([3]);
  const restricted = new ShadowSlotSelection([statics, dynamics], of(1, 2, 3));
  expect([...restricted]).toEqual([1, 2]);
  expect(restricted.size).toBe(2);
});

it('enumerates the smaller fixed shadow domain and retains its exact count', () => {
  const staticSlots = FrameSet.from(Array.from({ length: 4096 }, (_, index) => index * 2));
  const dynamicSlots = FrameSet.from(Array.from({ length: 4096 }, (_, index) => index * 2 + 1));
  const allowed = FrameSet.from([0, 17, 202, 7777, 9000]);
  const selected = new ShadowSlotSelection([staticSlots, dynamicSlots], allowed);
  const has = vi.spyOn(FrameSet.prototype, 'has');
  try {
    expect([...selected]).toEqual([0, 17, 202, 7777]);
    expect(has.mock.calls.length).toBeLessThanOrEqual(allowed.size * 2);
    has.mockClear();
    expect(selected.size).toBe(4);
    expect(has.mock.calls.length).toBeLessThanOrEqual(allowed.size * 2);
    has.mockClear();
    expect(selected.size).toBe(4);
    expect(has).not.toHaveBeenCalled();
    const nested = new ShadowSlotSelection([FrameSet.from([0, 17]), FrameSet.from([202, 9000])]);
    const nestedSelection = new ShadowSlotSelection([staticSlots, dynamicSlots], nested);
    has.mockClear();
    expect([...nestedSelection]).toEqual([0, 17, 202]);
    expect(has.mock.calls.length).toBeLessThanOrEqual(8);
  } finally {
    has.mockRestore();
  }
});

it('preserves member multiplicity and held iterators through nested restrictions', () => {
  const left = FrameSet.from([1, 3, 5]);
  const right = FrameSet.from([3, 4, 7]);
  const allowed = new ShadowSlotSelection([FrameSet.from([3]), FrameSet.from([3, 100])]);
  const selected = new ShadowSlotSelection([left, right], allowed);
  const walk = selected[Symbol.iterator]();
  const first = walk.next();
  expect(first).toEqual({ value: 3, done: false });
  const changed = new ShadowSlotSelection([left.without(3), right.without(3)], allowed);
  expect([...changed]).toEqual([]);
  expect(walk.next()).toEqual({ value: 3, done: false });
  expect(walk.next().done).toBe(true);
  expect(first).toEqual({ value: 3, done: false });
  expect([...selected]).toEqual([3, 3]);
  expect(selected.size).toBe(2);
});
