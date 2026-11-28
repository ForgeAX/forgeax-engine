import { describe, expect, it } from 'vitest';
import { interpolate } from '../../nurbs';
import { loft } from '../loft';
import { measure } from '../measure';
import { sweep } from '../sweep';
import { tessellate } from '../tessellate';
import { transformShape } from '../transform';
import type { Shape, Surface } from '../types';
import { validate } from '../validate';
import {
  deviation,
  must,
  nurbsSurfaceCount,
  skewPlacement,
  tessellationGap,
  zTurn,
} from './placement-support';

const SQUARE = [
  [-0.25, -0.25],
  [0.25, -0.25],
  [0.25, 0.25],
  [-0.25, 0.25],
] as const;

const curvedPath = () =>
  must(
    interpolate(
      [
        [0, 0, 0],
        [1, 0.5, 1],
        [0.5, 1.5, 2],
        [-0.5, 1, 3],
      ],
      { degree: 3 },
    ),
  );

function sweptPart(): Shape {
  return must(
    sweep({
      profile: SQUARE,
      path: { kind: 'nurbs', curve: curvedPath() },
      xHint: [0, 0, 1],
      stations: 9,
    }),
  );
}

function loftedPart(): Shape {
  const frame = (z: number) => ({
    o: [0, 0, z] as [number, number, number],
    x: [1, 0, 0] as [number, number, number],
    y: [0, 1, 0] as [number, number, number],
    z: [0, 0, 1] as [number, number, number],
  });
  const ring = (h: number) =>
    [
      [-h, -h],
      [h, -h],
      [h, h],
      [-h, h],
    ] as const;
  return must(
    loft({
      mode: 'smooth',
      sections: [
        { profile: ring(1), frame: frame(0) },
        { profile: ring(0.6), frame: frame(1.5) },
        { profile: ring(0.8), frame: frame(3) },
      ],
    }),
  );
}

function checkExactMove(part: Shape) {
  const p = skewPlacement(0.7);
  const moved = must(transformShape(part, p));
  expect(nurbsSurfaceCount(part)).toBeGreaterThan(0);

  const report = validate(moved);
  expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  expect(report.shells[0]?.euler).toBe(validate(part).shells[0]?.euler);

  expect(deviation(part, moved, p)).toBeLessThanOrEqual(1e-12);

  // Area is exact. Volume is a grid flux integral of p.n over NURBS faces, which is not exactly
  // translation-invariant; the rotation-only check below isolates the transform from that quadrature.
  const m0 = must(measure(part));
  const m1 = must(measure(moved));
  expect(Math.abs(m1.area - m0.area)).toBeLessThanOrEqual(1e-9 * m0.area);
  expect(Math.abs(m1.volume - m0.volume)).toBeLessThanOrEqual(2e-4 * Math.abs(m0.volume));
  const turned = must(transformShape(part, zTurn(0.7)));
  expect(Math.abs(must(measure(turned)).volume - m0.volume)).toBeLessThanOrEqual(
    1e-12 * Math.abs(m0.volume),
  );

  const t0 = must(tessellate(part));
  const t1 = must(tessellate(moved));
  expect(tessellationGap(t0, t1, p)).toBeLessThanOrEqual(1e-9);
  return moved;
}

describe('transformShape moves NURBS geometry exactly', () => {
  it('moves a swept NURBS part under a skew-axis placement', () => {
    checkExactMove(sweptPart());
  });

  it('moves a smooth-lofted NURBS part under a skew-axis placement', () => {
    checkExactMove(loftedPart());
  });

  it('moves a rational quarter-circle surface exactly and keeps its weights', () => {
    const s2 = Math.SQRT1_2;
    const arc: Surface = {
      kind: 'nurbs',
      surface: {
        degreeU: 2,
        degreeV: 1,
        points: [
          [
            [1, 0, 0],
            [1, 0, 1],
          ],
          [
            [1, 1, 0],
            [1, 1, 1],
          ],
          [
            [0, 1, 0],
            [0, 1, 1],
          ],
        ],
        weights: [
          [1, 1],
          [s2, s2],
          [1, 1],
        ],
        knotsU: [0, 0, 0, 1, 1, 1],
        knotsV: [0, 0, 1, 1],
      },
    };
    const shape = { ...sweptPart(), vertices: [], curves: [], surfaces: [arc] } as Shape;
    const p = skewPlacement(0.7);
    const moved = must(transformShape(shape, p));
    const movedSurface = moved.surfaces[0];
    if (movedSurface?.kind !== 'nurbs') throw new Error('expected a NURBS surface');
    expect(movedSurface.surface.weights).toEqual(arc.kind === 'nurbs' ? arc.surface.weights : []);
    expect(deviation(shape, moved, p)).toBeLessThanOrEqual(1e-12);

    // The rational midpoint sits on the unit circle in the source plane; a non-rational copy would not.
    const unweighted: Shape = {
      ...shape,
      surfaces: [
        {
          kind: 'nurbs',
          surface: {
            degreeU: arc.surface.degreeU,
            degreeV: arc.surface.degreeV,
            points: arc.surface.points,
            knotsU: arc.surface.knotsU,
            knotsV: arc.surface.knotsV,
          },
        },
      ],
    };
    expect(deviation(shape, unweighted, p)).toBeGreaterThan(1e-3);
  });

  it('falsifier: control points left unmoved are caught by the sample check', () => {
    const part = sweptPart();
    const p = skewPlacement(0.7);
    const moved = must(transformShape(part, p));
    const unmoved = { ...moved, surfaces: part.surfaces, curves: part.curves };
    expect(deviation(part, unmoved, p)).toBeGreaterThan(1e-3);
  });
});
