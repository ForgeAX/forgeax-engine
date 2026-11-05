import { RenderQueue } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type DispatchEntry, defaultMaterialSnapshot } from '../../render-system-extract';
import {
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Z,
} from '../../systems/transparent-sort-config';
import { computeFoldBuckets } from '../fold-buckets';
import { buildFoldDispatchPlan, type FoldRenderableLike, foldDispatchBuckets } from '../mesh-ssbo';

function entry(renderableIndex: number, materialHandle = 1): DispatchEntry {
  return {
    renderableIndex,
    entityIndex: renderableIndex,
    materialHandle,
    layer: 0,
    passIndex: 0,
    queue: RenderQueue.Transparent,
    tags: {},
  } as DispatchEntry;
}

function row(sprite: boolean, z = 0): FoldRenderableLike {
  const world = new Float32Array(16);
  world[0] = world[5] = world[10] = world[15] = 1;
  world[14] = z;
  return {
    transform: { world },
    material: {
      ...defaultMaterialSnapshot(),
      transparent: true,
      passes: [
        {
          name: 'Forward',
          program: { module: sprite ? 'forgeax::sprite' : 'forgeax::default-standard-pbr' },
        },
      ],
    },
  };
}

describe('fold work follows actual multi-draw runs', () => {
  it.each([
    129, 256, 257, 10000,
  ])('pages %i ordered sprites without dropping or reordering a member', (count) => {
    const rows = Array.from({ length: count }, (_, index) => {
      const source = row(true);
      source.transform.world[12] = index;
      return source;
    });
    const buckets = foldDispatchBuckets(
      rows.map((_, index) => entry(index)),
      TRANSPARENT_SORT_MODE_LAYER_Z,
      rows,
    );
    const indices = new Map(rows.map((_, index) => [index, index]));
    const plan = buildFoldDispatchPlan(buckets, indices, 128);
    const consumed: number[] = [];
    for (let index = 0; index < count; index++) {
      if (plan.skipIndices.has(index)) continue;
      const page = plan.headBuckets.get(index);
      if (page === undefined) {
        consumed.push(index);
        continue;
      }
      expect(page.bucketSize).toBeLessThanOrEqual(128);
      for (let member = 0; member < page.bucketSize; member++) {
        const original = page.entries.at(member)?.renderableIndex;
        consumed.push(original as number);
        expect(page.transforms[member * 16 + 12]).toBe(original);
      }
    }
    expect(consumed).toEqual(Array.from({ length: count }, (_, index) => index));
    expect(plan.foldedBucketCount).toBe(Math.floor(count / 128) + Number(count % 128 > 1));
    expect(
      [...plan.headBuckets.values()].every((page) => page.entries.length === page.bucketSize),
    ).toBe(true);
  });

  it.each([
    'instances',
    'spriteInstances',
  ] as const)('keeps explicit %s collections outside automatic folding', (field) => {
    const rows = [row(true), { ...row(true), [field]: {} }, row(true)];
    expect(
      foldDispatchBuckets(
        rows.map((_, index) => entry(index)),
        TRANSPARENT_SORT_MODE_LAYER_Z,
        rows,
      ),
    ).toEqual([]);
  });

  it('does not read any input in a mode without folding', () => {
    const entries = new Proxy([entry(0)], {
      get() {
        throw new Error('inert dispatch read');
      },
    });
    expect(foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_DISTANCE, [])).toEqual([]);
  });

  it('does not read or copy transforms of non-sprite transparent draws', () => {
    for (const count of [16, 4096]) {
      const source = row(false);
      Object.defineProperty(source, 'transform', {
        get() {
          throw new Error('inert transform read');
        },
      });
      expect(
        foldDispatchBuckets(
          Array.from({ length: count }, (_, i) => entry(i)),
          TRANSPARENT_SORT_MODE_LAYER_Z,
          Array(count).fill(source),
        ),
      ).toEqual([]);
    }
  });

  it('omits isolated sprites and retains only consecutive compatible runs', () => {
    const rows = [row(true), row(true), row(false), row(true), row(true), row(true, 1)];
    const buckets = foldDispatchBuckets(
      rows.map((_, i) => entry(i)),
      TRANSPARENT_SORT_MODE_LAYER_Z,
      rows,
    );
    expect(buckets.map((b) => b.entries.map((e) => e.renderableIndex))).toEqual([
      [0, 1],
      [3, 4],
    ]);
    const captured = buckets[0]?.transforms.slice();
    const first = rows[0];
    if (first === undefined) throw new Error('missing first source');
    first.transform.world[12] = 9;
    expect(buckets[0]?.transforms).toEqual(captured);
  });

  it('keeps region, values, material and layer boundaries without singleton work', () => {
    const rows = Array.from({ length: 8 }, () => row(true));
    const entries = rows.map((_, i) => entry(i));
    const a = [0, 0, 0.5, 0.5] as const;
    const b = [0.5, 0, 0.5, 0.5] as const;
    const regions = [a, a, b, a, a, a, a, a];
    const inputs = rows.map((r, i) => ({ ...r, spriteRegion: regions[i] }));
    entries[5] = entry(5, 2);
    entries[6] = { ...entry(6), layer: 1 };
    entries[7] = { ...entry(7), layer: 1 };
    expect(
      foldDispatchBuckets(entries, TRANSPARENT_SORT_MODE_LAYER_Z, inputs).map((bucket) =>
        bucket.entries.map((e) => e.renderableIndex),
      ),
    ).toEqual([
      [0, 1],
      [3, 4],
      [6, 7],
    ]);
  });

  it('production reports zero buckets for standard transparency and multi-pass sprites', () => {
    const world = { transparentSort: { mode: TRANSPARENT_SORT_MODE_LAYER_Z } } as never;
    const frame = { lastFoldBucketCount: -1 } as never;
    expect(
      computeFoldBuckets(world, frame, [entry(0), entry(1)], [row(false), row(false)]),
    ).toEqual([]);
    expect(computeFoldBuckets(world, frame, [entry(0), entry(0)], [row(true)])).toEqual([]);
    expect(frame).toEqual({ lastFoldBucketCount: 0 });
  });
});
