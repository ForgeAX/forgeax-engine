import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { CameraSnapshot } from '../../render-contract';
import type { DispatchEntry } from '../../render-system-extract';
import { FrameProjection } from '../../scene/frame-list';
import { TransparentSortCache, type TransparentSortSource } from '../transparent-dispatch';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../transparent-sort-config';

function scope(mode: number, yzAlpha = 1): RenderResourceScope {
  return {
    transparentSort: { mode, yzAlpha },
  } as unknown as RenderResourceScope;
}

function renderable(x: number, y: number, z: number): TransparentSortSource {
  const world = new Float32Array(16);
  world[0] = world[5] = world[10] = world[15] = 1;
  world[12] = x;
  world[13] = y;
  world[14] = z;
  return { transform: { world } } as unknown as TransparentSortSource;
}

/** Sprite-shaped slot: pivot from `pivotAndSize[1]`, height from the world Y column. */
function sprite(y: number, z: number, pivotY: number, scaleY: number): TransparentSortSource {
  const world = new Float32Array(16);
  world[0] = world[10] = world[15] = 1;
  world[5] = scaleY;
  world[13] = y;
  world[14] = z;
  return {
    transform: { world },
    material: { paramSnapshot: { pivotAndSize: [0.5, pivotY, 1, 1] } },
  } as unknown as TransparentSortSource;
}

function entry(renderableIndex: number, queue: number, layer = 0, material = 0): DispatchEntry {
  return {
    entityIndex: renderableIndex,
    materialHandle: material,
    renderableIndex,
    passIndex: 0,
    queue,
    layer,
    tags: {},
  } as unknown as DispatchEntry;
}

function camera(x: number, y: number, z: number): CameraSnapshot {
  return { position: new Float32Array([x, y, z]) } as unknown as CameraSnapshot;
}

/** Independent reference: stable sort of the transparent subset in place. */
function reference(
  dispatch: readonly DispatchEntry[],
  renderables: readonly TransparentSortSource[],
  mode: number,
  eye: CameraSnapshot,
): DispatchEntry[] {
  const slots = dispatch.flatMap((e, i) => (e.queue === RenderQueue.Transparent ? [i] : []));
  const value = (e: DispatchEntry) => {
    const w = renderables[e.renderableIndex]?.transform.world as Float32Array;
    if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return w[14] as number;
    const d = [0, 1, 2].map((k) => (w[12 + k] as number) - (eye.position[k] as number));
    return -d.reduce((sum, n) => sum + n * n, 0);
  };
  const sorted = slots
    .map((slot) => dispatch[slot] as DispatchEntry)
    .sort((a, b) =>
      mode === TRANSPARENT_SORT_MODE_DISTANCE
        ? value(a) - value(b)
        : a.layer - b.layer || value(a) - value(b) || a.materialHandle - b.materialHandle,
    );
  const result = dispatch.slice();
  slots.forEach((slot, k) => {
    result[slot] = sorted[k] as DispatchEntry;
  });
  return result;
}

describe('TransparentSortCache', () => {
  it('matches a fresh stable sort every frame under an orbiting camera and moving slots', () => {
    let seed = 0x7a11;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    for (const mode of [TRANSPARENT_SORT_MODE_DISTANCE, TRANSPARENT_SORT_MODE_LAYER_Z]) {
      const cache = new TransparentSortCache();
      const positions = Array.from({ length: 40 }, () => [
        random() * 40 - 20,
        random() * 4,
        // Integer depths create exact key ties that must keep dispatch order.
        Math.floor(random() * 6),
      ]);
      const dispatch = positions.map((_, i) =>
        entry(i, i % 3 === 0 ? RenderQueue.Geometry : RenderQueue.Transparent, i % 2, i % 4),
      );
      for (let frame = 0; frame < 240; frame++) {
        if (frame % 50 === 49) {
          const moved = positions[frame % positions.length] as number[];
          moved[0] = (moved[0] as number) + 3;
        }
        const renderables = positions.map(([x, y, z]) => renderable(x ?? 0, y ?? 0, z ?? 0));
        const angle = frame * 0.02;
        const eye = camera(Math.cos(angle) * 60, 10, Math.sin(angle) * 60);
        const sorted = cache.sort(dispatch, scope(mode), [eye], renderables);
        expect(sorted, `mode=${mode} frame=${frame}`).toEqual(
          reference(dispatch, renderables, mode, eye),
        );
      }
      const { hits, misses } = cache.inspect();
      expect(hits + misses).toBe(240);
      // Layer order is camera-independent: only the five moves (and the
      // first frame) re-sort. Distance order is camera-dependent: every
      // pair crossing under the orbit re-sorts, so only exactness is gated.
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) expect(misses).toBeLessThanOrEqual(6);
      else expect(hits).toBeGreaterThan(0);
    }
  });

  it('sorts blended Geometry-queue work while retaining opaque slots and lazy reads', () => {
    const read: number[] = [];
    const renderables = new FrameProjection(
      [renderable(0, 0, 1), renderable(0, 0, 100), renderable(0, 0, 3)],
      (source, index) => {
        read.push(index);
        return source;
      },
    );
    const blend = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    } as const;
    const opaque = entry(1, RenderQueue.Geometry);
    const dispatch = [
      { ...entry(0, RenderQueue.Geometry), renderState: { blend } },
      opaque,
      { ...entry(2, RenderQueue.Geometry), renderState: { blend } },
    ];
    const sorted = new TransparentSortCache().sort(
      dispatch,
      scope(TRANSPARENT_SORT_MODE_DISTANCE),
      [camera(0, 0, 0)],
      renderables,
    );
    expect(sorted.map((draw) => draw.renderableIndex)).toEqual([2, 1, 0]);
    expect(sorted.at(1)).toBe(opaque);
    expect(read).toEqual([0, 2]);
  });

  it('reads only selected transparent rows from a retained frame projection', () => {
    const read: number[] = [];
    const renderables = new FrameProjection(
      [renderable(0, 0, 3), renderable(0, 0, 100), renderable(0, 0, 1)],
      (source, index) => {
        read.push(index);
        return source;
      },
    );
    const dispatch = [
      entry(0, RenderQueue.Transparent),
      entry(1, RenderQueue.Geometry),
      entry(2, RenderQueue.Transparent),
    ];
    const sorted = new TransparentSortCache().sort(
      dispatch,
      scope(TRANSPARENT_SORT_MODE_LAYER_Z),
      [],
      renderables,
    );
    expect(sorted.map((item) => item.renderableIndex)).toEqual([2, 1, 0]);
    expect(read).toEqual([0, 2]);
  });

  it('returns the previous array when the source and verified order are unchanged', () => {
    const cache = new TransparentSortCache();
    const renderables = [renderable(0, 0, 3), renderable(0, 0, 1), renderable(0, 0, 2)];
    const dispatch = renderables.map((_, i) => entry(i, RenderQueue.Transparent));
    const first = cache.sort(dispatch, scope(TRANSPARENT_SORT_MODE_LAYER_Z), [], renderables);
    const second = cache.sort(dispatch, scope(TRANSPARENT_SORT_MODE_LAYER_Z), [], renderables);
    expect(second).toBe(first);
    expect(first.map((e) => e.renderableIndex)).toEqual([1, 2, 0]);
    expect(cache.inspect()).toEqual({ hits: 1, misses: 1 });
  });

  it('never allocates or counts when no reorder is possible', () => {
    const cache = new TransparentSortCache();
    const renderables = [renderable(0, 0, 1), renderable(0, 0, 2)];
    const opaque = renderables.map((_, i) => entry(i, RenderQueue.Geometry));
    expect(cache.sort(opaque, scope(TRANSPARENT_SORT_MODE_DISTANCE), [], renderables)).toBe(opaque);
    const transparent = renderables.map((_, i) => entry(i, RenderQueue.Transparent));
    expect(cache.sort(transparent, scope(TRANSPARENT_SORT_MODE_DISTANCE), [], renderables)).toBe(
      transparent,
    );
    expect(cache.inspect()).toEqual({ hits: 0, misses: 0 });
  });
});

describe('TransparentSortCache mode formulas', () => {
  const order = (
    mode: number,
    renderables: readonly TransparentSortSource[],
    layers: readonly number[] = [],
    yzAlpha = 1,
    world: RenderResourceScope = scope(mode, yzAlpha),
  ) =>
    new TransparentSortCache()
      .sort(
        renderables.map((_, i) => entry(i, RenderQueue.Transparent, layers[i] ?? 0)),
        world,
        [],
        renderables,
      )
      .map((e) => e.renderableIndex);

  it('LAYER_Z is layer-major across signed layers, then posZ ascending', () => {
    const renderables = [
      renderable(0, 0, 1),
      renderable(0, 0, 2),
      renderable(0, 0, 1),
      renderable(0, 0, 0),
    ];
    expect(order(TRANSPARENT_SORT_MODE_LAYER_Z, renderables, [100, 0, -100, 0])).toEqual([
      2, 3, 1, 0,
    ]);
  });

  it('a world without TransparentSortConfig sorts as LAYER_Z', () => {
    const missing = {
      transparentSort: { mode: TRANSPARENT_SORT_MODE_LAYER_Z, yzAlpha: 1 },
    } as unknown as RenderResourceScope;
    const renderables = [renderable(0, 0, 3), renderable(0, 0, 1), renderable(0, 0, 2)];
    expect(order(TRANSPARENT_SORT_MODE_LAYER_Y, renderables, [], 1, missing)).toEqual([1, 2, 0]);
  });

  it('LAYER_Y sorts by -(posY - pivotY * |scaleY|): higher feet draw first', () => {
    // feet: 0, 1.5, -0.5
    const renderables = [sprite(1, 0, 1, 1), sprite(2, 0, 0.5, 1), sprite(0, 0, 0.5, 1)];
    expect(order(TRANSPARENT_SORT_MODE_LAYER_Y, renderables)).toEqual([1, 0, 2]);
    // pivotY=0 makes footY === posY: 10/20/30 draw as 30/20/10.
    const flat = [sprite(10, 0, 0, 1), sprite(20, 0, 0, 1), sprite(30, 0, 0, 1)];
    expect(order(TRANSPARENT_SORT_MODE_LAYER_Y, flat)).toEqual([2, 1, 0]);
  });

  it('LAYER_Y interleaves sprites and taller tilemap cells by foot, using |scaleY|', () => {
    // Sprites (pivot 0.5, height 32): feet 4, 64. Tilemap cells (pivot 0.2,
    // height 64, one V-flipped with a negative scale): feet 17.2, 37.2, 57.2.
    const renderables = [
      sprite(20, 0, 0.5, 32),
      sprite(80, 0, 0.5, 32),
      sprite(30, 0, 0.2, 64),
      sprite(50, 0, 0.2, 64),
      sprite(70, 0, 0.2, -64),
    ];
    expect(order(TRANSPARENT_SORT_MODE_LAYER_Y, renderables)).toEqual([1, 4, 3, 2, 0]);
  });

  it('LAYER_YZ sorts by footY + yzAlpha * posZ with stable ties', () => {
    // values: -0.5, 2, -0.5 (tie keeps dispatch order)
    const renderables = [sprite(0, 0, 0.5, 1), sprite(2, 1, 1, 1), sprite(1, -1, 0.5, 1)];
    expect(order(TRANSPARENT_SORT_MODE_LAYER_YZ, renderables)).toEqual([0, 2, 1]);
    // yzAlpha=0.5 halves the Z term: 1.5 + 1 = 2.5 vs -0.5 + 2 = 1.5.
    const tilted = [sprite(2, 2, 0.5, 1), sprite(0, 4, 0.5, 1)];
    expect(order(TRANSPARENT_SORT_MODE_LAYER_YZ, tilted, [], 0.5)).toEqual([1, 0]);
  });
});

describe('TransparentSortCache retained phase', () => {
  /** mulberry32 */
  function rng(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
  }

  interface Row {
    entityKey: number;
    pose: Float32Array;
    layer: number;
    materials: number[];
    queue: number;
  }

  function pose(x: number, y: number, z: number, scaleY = 1): Float32Array {
    const world = new Float32Array(16);
    world[0] = world[10] = world[15] = 1;
    world[5] = scaleY;
    world[12] = x;
    world[13] = y;
    world[14] = z;
    return world;
  }

  /** One frame's dispatch: each row emits one entry per material, rows in roster order. */
  function frame(rows: readonly Row[]) {
    const renderables: TransparentSortSource[] = rows.map((row) => ({
      transform: { world: row.pose },
      material: { paramSnapshot: { pivotAndSize: [0.5, 0.25, 1, 1] } } as never,
      worldId: 0,
      entityKey: row.entityKey,
    }));
    const dispatch: DispatchEntry[] = [];
    rows.forEach((row, index) => {
      for (const material of row.materials) {
        dispatch.push({ ...entry(index, row.queue, row.layer, material) });
      }
    });
    return { renderables, dispatch };
  }

  /** Independent reference: the engine's stable sort over the selected slots. */
  function stableReference(
    dispatch: readonly DispatchEntry[],
    renderables: readonly TransparentSortSource[],
    mode: number,
    eye: CameraSnapshot,
    sortAll: boolean,
  ): DispatchEntry[] {
    const slots = dispatch.flatMap((e, i) =>
      sortAll || e.queue === RenderQueue.Transparent ? [i] : [],
    );
    if (slots.length <= 1) return dispatch.slice();
    const value = (e: DispatchEntry) => {
      const w = renderables[e.renderableIndex]?.transform.world as Float32Array;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Z) return w[14] as number;
      if (mode === TRANSPARENT_SORT_MODE_LAYER_Y || mode === TRANSPARENT_SORT_MODE_LAYER_YZ) {
        const foot = (w[13] as number) - 0.25 * Math.abs(w[5] as number);
        return mode === TRANSPARENT_SORT_MODE_LAYER_Y ? -foot : foot + 0.5 * (w[14] as number);
      }
      const d = [0, 1, 2].map((k) => (w[12 + k] as number) - (eye.position[k] as number));
      return -d.reduce((sum, n) => sum + n * n, 0);
    };
    const sorted = slots
      .map((slot) => dispatch[slot] as DispatchEntry)
      .sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (mode === TRANSPARENT_SORT_MODE_DISTANCE) return va < vb ? -1 : va > vb ? 1 : 0;
        if (a.layer !== b.layer) return a.layer - b.layer;
        if (va !== vb) return va < vb ? -1 : 1;
        return a.materialHandle - b.materialHandle;
      });
    const result = dispatch.slice();
    slots.forEach((slot, k) => {
      result[slot] = sorted[k] as DispatchEntry;
    });
    return result;
  }

  it('equals a fresh stable sort over random edit sequences in every mode', () => {
    const modes = [
      TRANSPARENT_SORT_MODE_LAYER_Z,
      TRANSPARENT_SORT_MODE_LAYER_Y,
      TRANSPARENT_SORT_MODE_LAYER_YZ,
      TRANSPARENT_SORT_MODE_DISTANCE,
    ];
    for (const mode of modes) {
      for (const sortAll of [false, true]) {
        for (let trial = 0; trial < 6; trial++) {
          const random = rng(0x1000 * mode + trial * 31 + (sortAll ? 7 : 0));
          // Mutable sources keep their arrays; only re-evaluation can see an edit.
          const immutableSources = trial % 2 === 0;
          const cache = new TransparentSortCache();
          let nextEntity = 1;
          // Integer coordinates create exact value ties carried by dispatch order.
          const coordinate = () => Math.floor(random() * 5);
          const spawn = (): Row => ({
            entityKey: nextEntity++,
            pose: pose(coordinate(), coordinate(), coordinate(), random() < 0.5 ? 1 : -2),
            layer: Math.floor(random() * 3) - 1,
            materials: random() < 0.2 ? [3, 1] : [Math.floor(random() * 3)],
            queue: random() < 0.25 ? RenderQueue.Geometry : RenderQueue.Transparent,
          });
          let rows = Array.from({ length: 24 }, spawn);
          let eye = camera(10, 4, 10);
          for (let step = 0; step < 150; step++) {
            const roll = random();
            if (roll < 0.15) rows.splice(Math.floor(random() * (rows.length + 1)), 0, spawn());
            else if (roll < 0.28 && rows.length > 0)
              rows.splice(Math.floor(random() * rows.length), 1);
            else if (roll < 0.33 && rows.length > 2) {
              // A survivor reorders upstream: every dispatch tie is reassigned.
              const [moved] = rows.splice(Math.floor(random() * rows.length), 1);
              rows.splice(Math.floor(random() * rows.length), 0, moved as Row);
            } else if (roll < 0.36) rows = [];
            else if (roll < 0.45) eye = camera(random() * 20, random() * 8, random() * 20);
            for (let edit = Math.floor(random() * 4); edit > 0 && rows.length > 0; edit--) {
              const row = rows[Math.floor(random() * rows.length)] as Row;
              const kind = random();
              if (kind < 0.6 && immutableSources)
                row.pose = pose(coordinate(), coordinate(), coordinate());
              else if (kind < 0.6) row.pose.set([coordinate(), coordinate(), coordinate()], 12);
              else if (kind < 0.8) row.layer = Math.floor(random() * 3) - 1;
              else row.materials = [Math.floor(random() * 3)];
            }
            if (rows.length > 0 && random() < 0.03)
              (rows[0] as Row).pose = pose(Number.NaN, Number.NaN, Number.NaN);
            const { renderables, dispatch } = frame(rows);
            const sorted = cache.sort(dispatch, scope(mode, 0.5), [eye], renderables, {
              sortAll,
              immutableSources,
            });
            const expected = stableReference(dispatch, renderables, mode, eye, sortAll);
            const nan = renderables.some((r) => Number.isNaN(r.transform.world[12]));
            // NaN slots take the engine sort; only finite frames have one reference order.
            if (!nan)
              expect(sorted, `mode=${mode} sortAll=${sortAll} trial=${trial} step=${step}`).toEqual(
                expected,
              );
            if (nan) (rows[0] as Row).pose = pose(0, 0, 0);
          }
        }
      }
    }
  });

  /** Static camera, D changed rows per frame, one population T. */
  function steady(t: number, d: number, moving: boolean) {
    const random = rng(0xfeed + t);
    // Constant density: a camera step causes the same inversions per row at every scale.
    const side = 10 * Math.cbrt(t);
    const rows: Row[] = Array.from({ length: t }, (_, i) => ({
      entityKey: i + 1,
      pose: pose(random() * side, random() * side, random() * side),
      layer: 0,
      materials: [1],
      queue: RenderQueue.Transparent,
    }));
    const cache = new TransparentSortCache();
    const sort = (eye: CameraSnapshot) => {
      const { renderables, dispatch } = frame(rows);
      return cache.sort(dispatch, scope(TRANSPARENT_SORT_MODE_DISTANCE), [eye], renderables, {
        immutableSources: true,
      });
    };
    sort(camera(side / 2, side / 2, -2 * side));
    const before = cache.work();
    const frames = 16;
    for (let f = 0; f < frames; f++) {
      for (let edit = 0; edit < d; edit++) {
        const row = rows[Math.floor(random() * t)] as Row;
        const w = row.pose;
        row.pose = pose((w[12] as number) + random() - 0.5, w[13] as number, w[14] as number);
      }
      sort(camera(side / 2 + (moving ? (f + 1) * 0.25 : 0), side / 2, -2 * side));
    }
    const after = cache.work();
    const per = (key: keyof typeof after) => (after[key] - before[key]) / frames;
    return {
      visited: per('visited'),
      evaluated: per('evaluated'),
      compared: per('compared'),
      moved: per('moved'),
      sorts: after.sorts - before.sorts,
    };
  }

  it('static camera: sort work is O(changes) at two scales', () => {
    const small = steady(1_000, 8, false);
    const large = steady(32_000, 8, false);
    // The upstream dispatch is a full list, so every slot is visited.
    expect(large.visited).toBe(32_000);
    // Only the changed rows evaluate a sort key or reach the phase.
    expect(large.evaluated).toBe(8);
    expect(small.evaluated).toBe(8);
    expect(large.compared).toBeLessThan(8 * 2 * 16);
    // 32x population: comparisons grow only with the binary-search depth.
    expect(large.compared / small.compared).toBeLessThan(3);
    expect(large.sorts).toBe(0);
  });

  it('moving camera: every key changes and the near-sorted repair is O(T + inversions)', () => {
    for (const t of [1_000, 32_000]) {
      const moving = steady(t, 8, true);
      expect(moving.evaluated).toBe(t);
      expect(moving.sorts).toBe(0);
      // One verification comparison per row plus one per inversion repaired.
      expect(moving.compared).toBeLessThanOrEqual(2 * (t + moving.moved) + 256);
    }
  });
});
