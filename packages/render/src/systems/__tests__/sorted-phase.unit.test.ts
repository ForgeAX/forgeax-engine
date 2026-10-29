import { describe, expect, it } from 'vitest';
import { SortedPhase, type SortedPhaseOrder } from '../sorted-phase';

interface Item {
  layer: number;
  value: number;
  material: number;
  tie: number;
}

/** mulberry32: full-period, no short-cycle duplicates at 64k draws. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Independent reference: a full sort of every live item. */
function reference(items: ReadonlyMap<number, Item>, order: SortedPhaseOrder): number[] {
  return [...items.keys()].sort((a, b) => {
    const x = items.get(a) as Item;
    const y = items.get(b) as Item;
    if (order === 'layered' && x.layer !== y.layer) return x.layer - y.layer;
    if (x.value !== y.value) return x.value < y.value ? -1 : 1;
    if (order === 'layered' && x.material !== y.material) return x.material - y.material;
    if (x.tie !== y.tie) return x.tie < y.tie ? -1 : 1;
    return a - b;
  });
}

function keys(phase: SortedPhase): number[] {
  const result: number[] = [];
  for (let position = 0; position < phase.length; position++)
    result.push(phase.keyOf(phase.at(position)));
  return result;
}

function work(phase: SortedPhase) {
  return { ...phase.work };
}

describe('SortedPhase', () => {
  it('equals a full sort after every random edit sequence', () => {
    for (const order of ['layered', 'distance'] as const) {
      for (let trial = 0; trial < 12; trial++) {
        const random = rng(0x5eed + trial * 977 + (order === 'layered' ? 1 : 0));
        const phase = new SortedPhase(order);
        const items = new Map<number, Item>();
        let nextKey = 0;
        let nextTie = 0;
        // Few distinct values make value ties common, so ties carry the order.
        const value = () => Math.floor(random() * 8) - (random() < 0.3 ? 0.5 : 0);
        for (let frame = 0; frame < 120; frame++) {
          const edits = Math.floor(random() * 12);
          if (random() < 0.1) {
            // Camera move: every value changes in one deferred repair.
            phase.invalidate();
            for (const [key, item] of items) {
              item.value += (random() - 0.5) * 2;
              phase.update(phase.idOf(key), item.layer, item.value, item.material, item.tie);
            }
          }
          for (let edit = 0; edit < edits; edit++) {
            const roll = random();
            const live = [...items.keys()];
            if (roll < 0.4 || live.length === 0) {
              const item = {
                layer: Math.floor(random() * 3) - 1,
                value: value(),
                material: Math.floor(random() * 3),
                tie: nextTie++ * 3 + random(),
              };
              const key = nextKey++;
              items.set(key, item);
              phase.enter(key, item.layer, item.value, item.material, item.tie);
            } else {
              const key = live[Math.floor(random() * live.length)] as number;
              const id = phase.idOf(key);
              if (roll < 0.65) {
                items.delete(key);
                phase.leave(id);
              } else {
                const item = items.get(key) as Item;
                if (roll < 0.9) item.value = value();
                else item.layer = Math.floor(random() * 3) - 1;
                if (random() < 0.2) item.material = Math.floor(random() * 3);
                phase.update(id, item.layer, item.value, item.material, item.tie);
              }
            }
          }
          phase.commit();
          expect(keys(phase), `${order} trial=${trial} frame=${frame}`).toEqual(
            reference(items, order),
          );
        }
      }
    }
  });

  it('holds no order while a NaN member exists and repairs when it leaves', () => {
    const phase = new SortedPhase('distance');
    phase.enter(1, 0, 3, 0, 0);
    phase.enter(2, 0, 1, 0, 1);
    const nan = phase.enter(3, 0, Number.NaN, 0, 2);
    phase.commit();
    expect(phase.ordered).toBe(false);
    phase.enter(4, 0, 2, 0, 3);
    phase.leave(nan);
    phase.commit();
    expect(phase.ordered).toBe(true);
    expect(keys(phase)).toEqual([2, 4, 1]);
  });

  it('reports no order change for an unchanged or bracketed update', () => {
    const phase = new SortedPhase('layered');
    for (let key = 0; key < 8; key++) phase.enter(key, 0, key * 10, 0, key);
    expect(phase.commit()).toBe(true);
    const revision = phase.revision;
    phase.update(phase.idOf(3), 0, 31, 0, 3);
    expect(phase.commit()).toBe(false);
    expect(phase.revision).toBe(revision);
    phase.update(phase.idOf(3), 0, 75, 0, 3);
    expect(phase.commit()).toBe(true);
    expect(keys(phase)).toEqual([0, 1, 2, 4, 5, 6, 7, 3]);
  });

  /** Steady frames: D bounded value edits per frame, measured at one population. */
  function steady(n: number, d: number, moving: boolean) {
    const random = rng(0xabc + n);
    const phase = new SortedPhase('distance');
    const values = new Float64Array(n);
    for (let key = 0; key < n; key++) {
      values[key] = random() * n;
      phase.enter(key, 0, values[key] as number, 0, key);
    }
    phase.commit();
    const before = work(phase);
    const frames = 32;
    for (let frame = 0; frame < frames; frame++) {
      if (moving) {
        // A camera step changes every value by a small, smooth amount.
        phase.invalidate();
        for (let key = 0; key < n; key++) {
          values[key] = (values[key] as number) + Math.sin(key * 0.37 + frame) * 0.5;
          phase.update(phase.idOf(key), 0, values[key] as number, 0, key);
        }
      }
      for (let edit = 0; edit < d; edit++) {
        const key = Math.floor(random() * n);
        values[key] = (values[key] as number) + (random() - 0.5) * 4;
        phase.update(phase.idOf(key), 0, values[key] as number, 0, key);
      }
      phase.commit();
    }
    const after = work(phase);
    return {
      compared: (after.compared - before.compared) / frames,
      moved: (after.moved - before.moved) / frames,
      sorts: after.sorts - before.sorts,
    };
  }

  it('costs O(changes) per frame with a static camera, independent of population', () => {
    const small = steady(1_000, 8, false);
    const large = steady(64_000, 8, false);
    // 64x population: comparisons grow only by the binary-search depth.
    expect(large.compared).toBeLessThan(8 * 2 * 20);
    expect(large.compared / small.compared).toBeLessThan(2);
    expect(large.moved).toBeLessThan(8 * 8);
  });

  it('costs O(T) per frame with a moving camera, never a full sort', () => {
    const small = steady(1_000, 8, true);
    const large = steady(64_000, 8, true);
    expect(large.sorts + small.sorts).toBe(0);
    expect(large.compared).toBeLessThan(64_000 * 3);
    expect(large.compared / small.compared).toBeGreaterThan(32);
    expect(large.compared / small.compared).toBeLessThan(96);
  });
});
