import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { region2d } from '../region2d';
import { type Stamp, stamp } from '../stamp';
import { textRegion } from '../text';
import { bakeTrimSheet, type TrimRegion, trimSheet } from '../trim';

const SLOW = { timeout: 120_000 };

type Pt = readonly [number, number];

function must<T>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

function errorOf(r: { ok: true } | { ok: false; error: unknown }): { code: string } {
  if (r.ok) throw new Error('expected an error');
  return r.error as { code: string };
}

function circle(cx: number, cy: number, r: number, n = 48): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt;
  });
}

/** A 0.1 m square with a round hole centred on it (outer CCW, hole CW). */
const SQUARE: Pt[] = [
  [0, 0],
  [0.1, 0],
  [0.1, 0.1],
  [0, 0.1],
];
const HOLE = circle(0.05, 0.05, 0.02).reverse();

/** Height at a region point x, y (meters) of a stamp built with `margin`. */
function heightAt(s: Stamp, x: number, y: number, margin: number): number {
  return s.source.height(x + margin, y + margin);
}

describe('stamp.outline geometry', () => {
  const depth = 0.001;
  const built = must(
    stamp.outline({ region: [{ outer: SQUARE, holes: [HOLE] }], depth, margin: 0.01 }),
  );

  it('raises the ring, leaves the round hole at plane, and keeps the size of the outline plus margin', () => {
    expect(built.size[0]).toBeCloseTo(0.12, 9);
    expect(built.size[1]).toBeCloseTo(0.12, 9);
    expect(heightAt(built, 0.01, 0.05, 0.01)).toBeCloseTo(depth, 6);
    expect(heightAt(built, 0.05, 0.05, 0.01)).toBeCloseTo(0, 6);
    expect(heightAt(built, -0.005, 0.05, 0.01)).toBeCloseTo(0, 6);
  });

  it('rises monotonically across the outer edge', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const x = -0.01 + (0.03 * i) / 200;
      const h = heightAt(built, x, 0.05, 0.01);
      expect(h).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = h;
    }
    expect(previous).toBeGreaterThanOrEqual(depth - 1e-9);
  });

  it('engraves with a negative depth', () => {
    const engraved = must(
      stamp.outline({ region: [{ outer: SQUARE, holes: [HOLE] }], depth: -0.001, margin: 0.01 }),
    );
    expect(heightAt(engraved, 0.01, 0.05, 0.01)).toBeCloseTo(-0.001, 6);
    expect(engraved.signature.id).toBe('stamp.outline');
  });

  it('keys the signature on the geometry, depth and material', () => {
    const again = must(
      stamp.outline({ region: [{ outer: SQUARE, holes: [HOLE] }], depth, margin: 0.01 }),
    );
    expect(again.signature).toEqual(built.signature);
    const moved = must(
      stamp.outline({
        region: [{ outer: SQUARE, holes: [circle(0.05, 0.05, 0.021).reverse()] }],
        depth,
        margin: 0.01,
      }),
    );
    expect(moved.signature).not.toEqual(built.signature);
  });
});

describe('stamp.outline shares its raster with stamp.text', () => {
  it('reproduces textRegion heights sample for sample', () => {
    const height = 0.08;
    const text = must(stamp.text({ text: 'A', height, depth: -0.002 }));
    const region = must(textRegion('A', { height })).region;
    const outline = must(
      stamp.outline({
        region,
        depth: -0.002,
        margin: 0.25 * height,
        samplesPerMeter: 64 / height,
      }),
    );
    expect(outline.size).toEqual(text.size);
    const [w, h] = text.size;
    for (let j = 0; j <= 24; j++) {
      for (let i = 0; i <= 24; i++) {
        const s = (w * i) / 24;
        const t = (h * j) / 24;
        expect(outline.source.height(s, t)).toBe(text.source.height(s, t));
      }
    }
  });
});

describe('stamp.outline errors', () => {
  const base = { region: [{ outer: SQUARE }], depth: 0.001 };

  it('rejects an empty region', () => {
    expect(errorOf(stamp.outline({ ...base, region: [] })).code).toBe('model-invalid-argument');
  });

  it('rejects a ring with fewer than three points', () => {
    const r = stamp.outline({
      ...base,
      region: [
        {
          outer: [
            [0, 0],
            [1, 0],
          ],
        },
      ],
    });
    expect(errorOf(r).code).toBe('model-invalid-argument');
  });

  it('rejects non-finite coordinates', () => {
    const r = stamp.outline({
      ...base,
      region: [
        {
          outer: [
            [0, 0],
            [Number.NaN, 0],
            [0, 1],
          ],
        },
      ],
    });
    expect(errorOf(r).code).toBe('model-invalid-argument');
  });

  it('rejects zero and non-finite depth', () => {
    expect(errorOf(stamp.outline({ ...base, depth: 0 })).code).toBe('model-invalid-argument');
    expect(errorOf(stamp.outline({ ...base, depth: Number.NaN })).code).toBe(
      'model-invalid-argument',
    );
  });

  it('rejects a region with zero extent', () => {
    const line = {
      outer: [
        [0, 0],
        [0, 1],
        [0, 2],
      ] as Pt[],
    };
    expect(errorOf(stamp.outline({ ...base, region: [line] })).code).toBe('model-invalid-argument');
  });

  it('rejects a hole outside its outer loop', () => {
    const far = { outer: SQUARE, holes: [circle(0.5, 0.5, 0.02)] };
    expect(errorOf(stamp.outline({ ...base, region: [far] })).code).toBe('model-invalid-argument');
  });
});

describe('stamp.outline falsifiers', () => {
  it('accepts a reversed hole winding: coverage is even-odd, so the hole stays a hole', () => {
    const forward = must(
      stamp.outline({ region: [{ outer: SQUARE, holes: [HOLE] }], depth: 0.001, margin: 0.01 }),
    );
    const reversed = must(
      stamp.outline({
        region: [{ outer: SQUARE, holes: [[...HOLE].reverse()] }],
        depth: 0.001,
        margin: 0.01,
      }),
    );
    expect(heightAt(reversed, 0.05, 0.05, 0.01)).toBeCloseTo(0, 6);
    expect(heightAt(reversed, 0.01, 0.05, 0.01)).toBeCloseTo(0.001, 6);
    expect(reversed.source.height(0.06, 0.06)).toBe(forward.source.height(0.06, 0.06));
  });

  it('a hole outside its outer loop is rejected rather than filled as an island', () => {
    const r = stamp.outline({
      region: [{ outer: SQUARE, holes: [circle(0.5, 0.5, 0.02)] }],
      depth: 0.001,
    });
    expect(r.ok).toBe(false);
  });
});

describe('stamp.outline bakes into a trim normal/height map', () => {
  it('raised area fraction matches region area within 2 %', SLOW, () => {
    const disc = circle(0.06, 0.06, 0.05, 64);
    const bar: Pt[] = [
      [0.02, 0.045],
      [0.1, 0.045],
      [0.1, 0.075],
      [0.02, 0.075],
    ];
    const joined = must(region2d.union({ outer: disc }, { outer: bar }));
    const region = must(
      region2d.difference(joined.region, { outer: circle(0.06, 0.06, 0.012) }),
    ).region;
    const plate = must(stamp.outline({ region, depth: 0.002, margin: 0.01, material: 'paint' }));
    const sheet = must(
      trimSheet({
        key: 'gear',
        size: 1024,
        density: 2000,
        padding: 4,
        modules: [{ id: 'plate', ...plate }],
      }),
    );
    const baked = must(bakeTrimSheet(sheet, { maps: ['normal', 'height'], samples: 1 }));
    const height = baked.textures.height as TextureAsset;
    const r = sheet.regions.plate as TrimRegion;
    const [x0, y0, w, h] = r.rect;
    const data = height.data as Uint8Array;
    const size = height.shape.extent.width;
    let lo = 255;
    let hi = 0;
    const values: number[] = [];
    for (let j = y0; j < y0 + h; j++) {
      for (let i = x0; i < x0 + w; i++) {
        const v = data[(j * size + i) * 4] as number;
        values.push(v);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const threshold = (lo + hi) / 2;
    const raised = values.filter((v) => v > threshold).length / values.length;
    const expected = region2d.area(region) / (plate.size[0] * plate.size[1]);
    expect(hi).toBeGreaterThan(lo);
    expect(Math.abs(raised - expected) / expected).toBeLessThanOrEqual(0.02);
  });
});
