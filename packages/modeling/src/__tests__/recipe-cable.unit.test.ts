import { describe, expect, it } from 'vitest';
import { length, sub, type Tuple3 } from '../geom';
import { massProperties } from '../mass';
import { regionGroups } from '../ops';
import { CABLE_RANGES, type CableOptions, cable, catenary } from '../recipes/cable';
import { sel } from '../selectors';
import { expectClean } from './recipe-contract';

function must<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: Error },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function codeOf(result: {
  readonly ok: boolean;
  readonly error?: { readonly code: string };
}): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function analyticArcLength(parameter: number, x0: number, x: number): number {
  const u0 = -x0 / parameter;
  const u = (x - x0) / parameter;
  return parameter * (Math.sinh(u) - Math.sinh(u0));
}

describe('catenary', () => {
  it('matches the symmetric closed form, endpoint sag, length and small-sag estimate', () => {
    const span = 4;
    const sag = 0.5;
    const result = must(catenary([0, 2, 0], [span, 2, 0], { sag }));
    expect(result.lowest[0]).toBeCloseTo(span / 2, 9);
    expect(result.lowest[1]).toBeCloseTo(2 - sag, 9);
    expect(result.sag).toBeCloseTo(sag, 9);
    const expectedLength = 2 * result.parameter * Math.sinh(span / (2 * result.parameter));
    expect(result.length).toBeCloseTo(expectedLength, 9);

    const shallow = must(catenary([0, 0, 0], [span, 0, 0], { sag: 0.02 }));
    const parabola = span + (8 * 0.02 ** 2) / (3 * span);
    expect(Math.abs(shallow.length - parabola) / parabola).toBeLessThan(0.01);
  });

  it('round trips between prescribed sag and length and uses equal analytic arc stations', () => {
    const options = { samples: 41 };
    const sag = must(catenary([0, 0, 0], [3, 0, 0], { sag: 0.7 }, options));
    const fromLength = must(catenary([0, 0, 0], [3, 0, 0], { length: sag.length }, options));
    expect(fromLength.parameter).toBeCloseTo(sag.parameter, 9);
    expect(fromLength.sag).toBeCloseTo(sag.sag, 9);
    fromLength.points.forEach((point, i) => {
      expect(length(sub(point, sag.points[i] as Tuple3))).toBeLessThan(1e-9);
    });
    const halfSpan = 3 / 2;
    const x0 = halfSpan;
    const stations = sag.points.map((point) => analyticArcLength(sag.parameter, x0, point[0]));
    const step = sag.length / (options.samples - 1);
    for (let i = 1; i < stations.length; i++) {
      expect(
        Math.abs((stations[i] as number) - (stations[i - 1] as number) - step) / step,
      ).toBeLessThan(1e-6);
    }
  });

  it('hits unequal-height supports and places the minimum below the lower support when slack allows', () => {
    const a: Tuple3 = [0, 1, 0];
    const b: Tuple3 = [4, 0.5, 0];
    const result = must(catenary(a, b, { length: 5.5 }, { samples: 35 }));
    expect(result.points[0]).toEqual(a);
    expect(result.points.at(-1)).toEqual(b);
    expect(result.lowest[1]).toBeLessThan(b[1]);
    expect(result.points).toHaveLength(35);
  });

  it('rejects invalid, degenerate and unsupported inputs with structured errors', () => {
    const start: Tuple3 = [0, 0, 0];
    const end: Tuple3 = [2, 0, 0];
    expect(codeOf(catenary(start, end, { sag: 0 }))).toBe('model-invalid-argument');
    expect(codeOf(catenary(start, end, { sag: -1 }))).toBe('model-invalid-argument');
    expect(codeOf(catenary(start, end, { length: 2 }))).toBe('model-precondition');
    expect(codeOf(catenary(start, end, { length: 1 }))).toBe('model-precondition');
    expect(codeOf(catenary(start, start, { sag: 1 }))).toBe('model-precondition');
    expect(codeOf(catenary(start, [0, 2, 0], { sag: 1 }))).toBe('model-precondition');
    expect(codeOf(catenary(start, end, { sag: 1 }, { samples: 1 }))).toBe('model-invalid-argument');
    expect(codeOf(catenary(start, end, { sag: 1 }, { samples: 3.5 }))).toBe(
      'model-invalid-argument',
    );
    expect(codeOf(catenary(start, end, { sag: 1 }, { down: [0, 0, 0] }))).toBe(
      'model-invalid-argument',
    );
    expect(codeOf(catenary(start, end, {} as never))).toBe('model-invalid-argument');
    expect(codeOf(catenary(start, end, { sag: 1, length: 3 } as never))).toBe(
      'model-invalid-argument',
    );
    expect(codeOf(catenary([Number.NaN, 0, 0], end, { sag: 1 }))).toBe('model-invalid-argument');
  });
});

describe('cable', () => {
  it('builds a closed round cylinder for a single strand with polygonal volume', () => {
    const radius = 0.02;
    const span = 0.8;
    const part = expectClean(
      'plain cable',
      cable({
        path: [
          [0, 0, 0],
          [span, 0, 0],
        ],
        radius,
        segments: 24,
      }),
    );
    const measured = massProperties(part.model, { density: 1 });
    const polygonVolume = (24 * Math.sin((2 * Math.PI) / 24) * radius * radius * span) / 2;
    expect(must(measured).volume).toBeCloseTo(polygonVolume, 10);
    expect(part.model.validate().closed).toBe(true);
    expect(part.dimensions.length).toBeCloseTo(span, 12);
    expect(part.dimensions.radius).toBe(radius);
  });

  it.each([
    3, 7,
  ])('keeps %i strands on the prescribed tangent ring and controls their turns', (count) => {
    const radius = 0.03;
    const pitch = 0.31;
    const endX = 1;
    const part = must(
      cable({
        name: `cable-${count}`,
        path: [
          [0, 0, 0],
          [endX, 0, 0],
        ],
        radius,
        strands: { count, pitch },
        segments: 16,
      }),
    );
    const strandRadius = (radius * Math.sin(Math.PI / count)) / (1 + Math.sin(Math.PI / count));
    expect(part.dimensions.strandRadius).toBeCloseTo(strandRadius, 14);
    expect(part.dimensions.turns).toBeCloseTo(endX / pitch, 12);
    expect(part.model.validate().closed).toBe(true);
    const tagFaces = sel.tag(`cable-${count}-strand`).evaluate(part.model.editMesh);
    expect(tagFaces.length).toBeGreaterThan(0);
    const shells = regionGroups(part.model.editMesh, tagFaces, 'perIsland');
    expect(shells).toHaveLength(count);
    // Each strand's end caps are its two 16-gons (the sides are quads); a cap's vertex centroid is the
    // strand centre line's end point. The caps are tilted by the helix angle, so slicing by x would not do.
    const centers = shells.map((faces) => {
      const caps = faces
        .map((face) => part.model.editMesh.faceVertices(face))
        .filter((ring) => ring.length === 16)
        .map((ring) => {
          const points = ring.map((vertex) => part.model.editMesh.position(vertex));
          const mean = (axis: number) =>
            points.reduce((sum, point) => sum + (point[axis] as number), 0) / points.length;
          return [mean(0), mean(1), mean(2)] as const;
        })
        .sort((a, b) => a[0] - b[0]);
      expect(caps).toHaveLength(2);
      return caps.map(([x, y, z], end) => {
        expect(x).toBeCloseTo(end * endX, 9);
        expect(Math.hypot(y, z)).toBeCloseTo(radius - strandRadius, 9);
        return [y, z] as const;
      });
    });
    const startAngle = Math.atan2(centers[0]?.[0]?.[1] as number, centers[0]?.[0]?.[0] as number);
    const endAngle = Math.atan2(centers[0]?.[1]?.[1] as number, centers[0]?.[1]?.[0] as number);
    const expected = (2 * Math.PI * endX) / pitch;
    const wrapped =
      ((((endAngle - startAngle - expected + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) %
        (2 * Math.PI)) -
      Math.PI;
    expect(Math.abs(wrapped)).toBeLessThan(1e-6);
  });

  it('adds a tagged wrap and ferrule/boot fittings, and sweeps a catenary path', () => {
    const hanging = must(catenary([0, 0.5, 0], [0.8, 0.5, 0], { sag: 0.12 }, { samples: 17 }));
    const part = must(
      cable({
        name: 'detailed',
        path: hanging.points,
        radius: 0.012,
        strands: { count: 3, pitch: 0.22 },
        wrap: { width: 0.002, pitch: 0.04, thickness: 0.0005 },
        fittings: {
          start: { kind: 'ferrule', length: 0.02, radius: 0.02 },
          end: { kind: 'boot', length: 0.03, radius: 0.021 },
        },
        segments: 12,
      }),
    );
    const report = part.model.validate();
    expect(report.closed).toBe(true);
    expect(part.model.count(sel.tag('detailed-fitting'))).toBeGreaterThan(0);
    expect(part.model.count(sel.tag('detailed-strand'))).toBeGreaterThan(0);
    expect(part.anchors.lowest?.[1]).toBeCloseTo(hanging.lowest[1], 12);
    expect(part.model.validate().closed).toBe(true);
  });

  it('rejects bends below the minimum, malformed paths and out-of-range options', () => {
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [0.1, 0, 0],
            [0.1, 0.1, 0],
          ],
          radius: 0.04,
        }),
      ),
    ).toBe('model-precondition');
    expect(codeOf(cable({ path: [[0, 0, 0]], radius: 0.01 }))).toBe('model-invalid-argument');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [0, 0, 0],
          ],
          radius: 0.01,
        }),
      ),
    ).toBe('model-degenerate');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0,
        }),
      ),
    ).toBe('model-invalid-argument');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0.01,
          segments: 7,
        }),
      ),
    ).toBe('model-invalid-argument');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0.01,
          strands: { count: 20, pitch: 0.1 },
        }),
      ),
    ).toBe('model-invalid-argument');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0.01,
          strands: { count: 3, pitch: 0.002 },
        }),
      ),
    ).toBe('model-precondition');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0.01,
          wrap: { width: 0.05, pitch: 0.04, thickness: 0.001 },
        }),
      ),
    ).toBe('model-precondition');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0.01,
          wrap: { width: 0.002, pitch: 0.001, thickness: 0.001 },
        }),
      ),
    ).toBe('model-invalid-argument');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0.01,
          fittings: { start: { kind: 'ferrule', length: 0.0001 } },
        }),
      ),
    ).toBe('model-invalid-argument');
    expect(
      codeOf(
        cable({
          path: [
            [0, 0, 0],
            [1, 0, 0],
          ],
          radius: 0.01,
          fittings: { start: { kind: 'other' } as never },
        }),
      ),
    ).toBe('model-invalid-argument');
  });

  it('builds identical snapshots and declares the expected parameter ranges', () => {
    const options: CableOptions = {
      path: [
        [0, 0, 0],
        [0.3, 0.04, 0],
      ],
      radius: 0.01,
      strands: { count: 3, pitch: 0.12 },
      segments: 12,
    };
    const a = must(cable(options));
    const b = must(cable(options));
    expect(a.model.snapshot()).toEqual(b.model.snapshot());
    expect(CABLE_RANGES.strands).toEqual([1, 19]);
  });
});
