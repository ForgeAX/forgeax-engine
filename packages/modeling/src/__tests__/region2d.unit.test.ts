import { describe, expect, it } from 'vitest';
import type { Point2 } from '../primitives';
import { type Region2, region2d } from '../region2d';

const square = (x: number, y: number, s: number): Point2[] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
];

function value(result: ReturnType<typeof region2d.union>): Region2 {
  if (!result.ok) throw result.error;
  return result.value.region;
}

function close(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

describe('region booleans', () => {
  it('unions two overlapping squares into one outline', () => {
    const out = value(region2d.union(square(0, 0, 2), square(1, 1, 2)));
    expect(out).toHaveLength(1);
    expect(out[0]?.outer).toHaveLength(8);
    expect(region2d.area(out)).toBeCloseTo(7, 12);
    expect(out[0]?.outer[0]).toEqual([0, 0]);
  });

  it('differences produce holes and keep the outline counter-clockwise', () => {
    const out = value(region2d.difference(square(0, 0, 4), square(1, 1, 2)));
    expect(out).toHaveLength(1);
    expect(out[0]?.holes).toHaveLength(1);
    expect(region2d.area(out)).toBeCloseTo(12, 12);
    expect(region2d.contains(out, [0.5, 0.5])).toBe(true);
    expect(region2d.contains(out, [2, 2])).toBe(false);
  });

  it('intersects, xors and handles shared edges and touching corners', () => {
    expect(
      region2d.area(value(region2d.intersection(square(0, 0, 2), square(1, 1, 2)))),
    ).toBeCloseTo(1, 12);
    expect(region2d.area(value(region2d.xor(square(0, 0, 2), square(1, 1, 2))))).toBeCloseTo(6, 12);
    const shared = value(region2d.union(square(0, 0, 1), square(1, 0, 1)));
    expect(shared).toHaveLength(1);
    expect(region2d.area(shared)).toBeCloseTo(2, 12);
    const corner = value(region2d.union(square(0, 0, 1), square(1, 1, 1)));
    expect(corner).toHaveLength(2);
    expect(value(region2d.intersection(square(0, 0, 1), square(2, 2, 1)))).toEqual([]);
    expect(value(region2d.difference(square(0, 0, 1), square(0, 0, 1)))).toEqual([]);
  });

  it('keeps islands inside holes as separate shapes', () => {
    const frame = value(region2d.difference(square(0, 0, 6), square(1, 1, 4)));
    const out = value(region2d.union(frame, square(2, 2, 2)));
    expect(out).toHaveLength(2);
    expect(region2d.area(out)).toBeCloseTo(36 - 16 + 4, 12);
    expect(region2d.contains(out, [3, 3])).toBe(true);
    expect(region2d.contains(out, [1.5, 1.5])).toBe(false);
  });

  it('normalizes inputs in either orientation and resolves self-overlap', () => {
    const cw = [...square(0, 0, 2)].reverse();
    const out = value(region2d.union(cw, [{ outer: square(0.5, 0.5, 1) }]));
    expect(region2d.area(out)).toBeCloseTo(4, 12);
  });

  it('reports provenance per output edge and the job report', () => {
    const result = region2d.difference(square(0, 0, 4), square(1, 1, 2));
    if (!result.ok) throw result.error;
    expect(result.value.report.backend).toBe('ts');
    expect(result.value.provenance).toHaveLength(2);
    const hole = result.value.provenance[1];
    expect([...(hole?.operand ?? [])]).toEqual([1, 1, 1, 1]);
    expect(result.value.report.cacheKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic and reports native as unavailable', () => {
    const a = region2d.union(square(0, 0, 2), square(1, 0.5, 2));
    const b = region2d.union(square(0, 0, 2), square(1, 0.5, 2));
    if (!a.ok || !b.ok) throw new Error('union failed');
    expect(region2d.encode(a.value.region)).toEqual(region2d.encode(b.value.region));
    const native = region2d.union(square(0, 0, 1), square(1, 0, 1), {
      compute: { policy: 'native' },
    });
    expect(native.ok).toBe(false);
    if (!native.ok) expect(native.error.code).toBe('model-capability-unavailable');
  });
});

describe('region offsets and strokes', () => {
  it('grows a square with round corners to the exact area within the chord tolerance', () => {
    const out = value(region2d.offset(square(0, 0, 2), 0.5, { arcTolerance: 1e-4 }));
    expect(out).toHaveLength(1);
    const exact = 4 + 4 * 2 * 0.5 + Math.PI * 0.25;
    expect(region2d.area(out)).toBeLessThanOrEqual(exact);
    expect(region2d.area(out)).toBeGreaterThan(exact - 0.01);
  });

  it('miters and bevels corners, and shrinks with holes growing', () => {
    expect(
      region2d.area(value(region2d.offset(square(0, 0, 2), 0.5, { join: 'miter' }))),
    ).toBeCloseTo(9, 12);
    const bevel = region2d.area(value(region2d.offset(square(0, 0, 2), 0.5, { join: 'bevel' })));
    expect(bevel).toBeCloseTo(9 - 4 * 0.125, 12);
    const frame = value(region2d.difference(square(0, 0, 6), square(2, 2, 2)));
    const shrunk = value(region2d.offset(frame, -0.5, { join: 'miter' }));
    expect(region2d.area(shrunk)).toBeCloseTo(25 - 9, 12);
  });

  it('removes a shape that shrinks away and splits a dumbbell neck', () => {
    expect(value(region2d.offset(square(0, 0, 1), -0.6))).toEqual([]);
    const dumbbell: Point2[] = [
      [0, 0],
      [2, 0],
      [2, 0.9],
      [3, 0.9],
      [3, 0],
      [5, 0],
      [5, 2],
      [3, 2],
      [3, 1.1],
      [2, 1.1],
      [2, 2],
      [0, 2],
    ];
    expect(value(region2d.offset(dumbbell, -0.15))).toHaveLength(2);
  });

  it('strokes open polylines with round caps and unions crossing strokes', () => {
    const out = value(
      region2d.stroke(
        [
          [
            [0, 0],
            [2, 0],
          ],
          [
            [1, -1],
            [1, 1],
          ],
        ],
        0.1,
        { arcTolerance: 1e-5 },
      ),
    );
    expect(out).toHaveLength(1);
    const exact = 2 * (2 * 0.2 + Math.PI * 0.01) - 0.04;
    expect(close(region2d.area(out), exact, 2e-3)).toBe(true);
    const butt = value(
      region2d.stroke(
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
        0.1,
        { cap: 'butt', join: 'miter' },
      ),
    );
    expect(region2d.area(butt)).toBeCloseTo(0.2 * 2 + 0.01 * 0, 9);
  });

  it('rejects malformed input with structured errors', () => {
    const bad = region2d.offset(square(0, 0, 1), Number.NaN);
    expect(bad.ok).toBe(false);
    const short = region2d.stroke([[[0, 0]]], 0.1);
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.error.code).toBe('model-invalid-argument');
  });
});
