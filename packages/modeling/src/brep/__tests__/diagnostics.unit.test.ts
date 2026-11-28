// biome-ignore-all lint/style/noNonNullAssertion: fixture indices are checked by their constructors
import { describe, expect, it } from 'vitest';
import { highlightLines } from '../../highlight-lines';
import {
  domain as curveDomain,
  curvePoint,
  surfacePoint as nurbsPoint,
  surfaceCurvature,
} from '../../nurbs';
import { checkSurfaceQuality, D09_CLASSES } from '../../surface-quality';
import { box, cone, cylinder, sphere, torus } from '../build';
import { shapeSurfaces } from '../diagnostics';
import { filletBox } from '../fillet-box';
import { surfaceInverse, surfacePoint } from '../surfaces';
import type { Shape } from '../types';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.sqrt(a.reduce((sum, x, i) => sum + (x - (b[i] as number)) ** 2, 0));
}

function sourceBounds(
  shape: Shape,
  faceIndex: number,
): { u0: number; u1: number; v0: number; v1: number } {
  const face = shape.faces[faceIndex] as Shape['faces'][number];
  const bounds = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
  for (const loopIndex of face.loops) {
    const loop = shape.loops[loopIndex] as Shape['loops'][number];
    for (const coedgeIndex of loop.coedges) {
      const coedge = shape.coedges[coedgeIndex] as Shape['coedges'][number];
      const edge = shape.edges[coedge.edge] as Shape['edges'][number];
      const t0 = coedge.reversed ? edge.t1 : edge.t0;
      const t1 = coedge.reversed ? edge.t0 : edge.t1;
      for (let k = 0; k <= 64; k++) {
        const t = t0 + ((t1 - t0) * k) / 64;
        const p =
          coedge.pcurve.kind === 'line'
            ? [
                coedge.pcurve.o[0] + t * coedge.pcurve.d[0],
                coedge.pcurve.o[1] + t * coedge.pcurve.d[1],
              ]
            : coedge.pcurve.kind === 'circle'
              ? [
                  coedge.pcurve.c[0] +
                    coedge.pcurve.r * Math.cos(coedge.pcurve.phase + coedge.pcurve.dir * t),
                  coedge.pcurve.c[1] +
                    coedge.pcurve.r * Math.sin(coedge.pcurve.phase + coedge.pcurve.dir * t),
                ]
              : [coedge.pcurve.curve.points[0]?.[0] ?? 0, coedge.pcurve.curve.points[0]?.[1] ?? 0];
        bounds.u0 = Math.min(bounds.u0, p[0] as number);
        bounds.u1 = Math.max(bounds.u1, p[0] as number);
        bounds.v0 = Math.min(bounds.v0, p[1] as number);
        bounds.v1 = Math.max(bounds.v1, p[1] as number);
      }
    }
  }
  return bounds;
}

function exactSampleError(shape: Shape): number {
  const converted = must(shapeSurfaces(shape));
  let worst = 0;
  for (const [index, named] of converted.surfaces.entries()) {
    const faceIndex = converted.faces[index] as number;
    const carrier = shape.surfaces[
      (shape.faces[faceIndex] as Shape['faces'][number]).surface
    ] as Shape['surfaces'][number];
    const [[u0, u1], [v0, v1]] = [
      named.surface.knotsU.slice(named.surface.degreeU, named.surface.points.length + 1),
      named.surface.knotsV.slice(
        named.surface.degreeV,
        (named.surface.points[0] as readonly unknown[]).length + 1,
      ),
    ] as unknown as [[number, number], [number, number]];
    const source = sourceBounds(shape, faceIndex);
    for (const fu of [0.07, 0.23, 0.51, 0.79, 0.93]) {
      for (const fv of [0.11, 0.37, 0.63, 0.89]) {
        const u = u0 + (u1 - u0) * fu;
        const v = v0 + (v1 - v0) * fv;
        const actual = nurbsPoint(named.surface, u, v);
        if (carrier.kind === 'plane' || carrier.kind === 'nurbs') {
          worst = Math.max(
            worst,
            distance(
              actual,
              surfacePoint(
                carrier,
                source.u0 + (source.u1 - source.u0) * fu,
                source.v0 + (source.v1 - source.v0) * fv,
              ),
            ),
          );
          continue;
        }
        const angular = (a0: number, a1: number, f: number) => a0 + (a1 - a0) * f;
        const face = shape.faces[faceIndex] as Shape['faces'][number];
        let uA = Infinity;
        let uB = -Infinity;
        let vA = Infinity;
        let vB = -Infinity;
        for (const loopIndex of face.loops) {
          const loop = shape.loops[loopIndex] as Shape['loops'][number];
          for (const coedgeIndex of loop.coedges) {
            const coedge = shape.coedges[coedgeIndex] as Shape['coedges'][number];
            const edge = shape.edges[coedge.edge] as Shape['edges'][number];
            for (let k = 0; k <= 64; k++) {
              const t = edge.t0 + ((edge.t1 - edge.t0) * k) / 64;
              const p =
                coedge.pcurve.kind === 'line'
                  ? [
                      coedge.pcurve.o[0] + t * coedge.pcurve.d[0],
                      coedge.pcurve.o[1] + t * coedge.pcurve.d[1],
                    ]
                  : coedge.pcurve.kind === 'circle'
                    ? [
                        coedge.pcurve.c[0] +
                          coedge.pcurve.r * Math.cos(coedge.pcurve.phase + coedge.pcurve.dir * t),
                        coedge.pcurve.c[1] +
                          coedge.pcurve.r * Math.sin(coedge.pcurve.phase + coedge.pcurve.dir * t),
                      ]
                    : [
                        coedge.pcurve.curve.points[0]?.[0] ?? 0,
                        coedge.pcurve.curve.points[0]?.[1] ?? 0,
                      ];
              uA = Math.min(uA, p[0] as number);
              uB = Math.max(uB, p[0] as number);
              vA = Math.min(vA, p[1] as number);
              vB = Math.max(vB, p[1] as number);
            }
          }
        }
        let sourceU = source.u0 + (source.u1 - source.u0) * fu;
        let sourceV = source.v0 + (source.v1 - source.v0) * fv;
        const match = named.name.match(/\.u(\d+)-v(\d+)$/);
        const i = match === null ? 0 : Number(match[1]);
        const j = match === null ? 0 : Number(match[2]);
        if (carrier.kind === 'cylinder' || carrier.kind === 'cone') {
          const u0 = source.u0;
          const u1 = u0 + 2 * Math.PI;
          sourceU = angular(u0, u1, (i + fu) / 4);
        }
        if (carrier.kind === 'sphere') {
          const u0 = source.u0;
          const u1 = u0 + 2 * Math.PI;
          sourceU = angular(u0, u1, (i + fu) / 4);
          sourceV = angular(-Math.PI / 2, Math.PI / 2, (j + fv) / 4);
        }
        if (carrier.kind === 'torus') {
          sourceU = angular(uA, uA + 2 * Math.PI, (i + fu) / 4);
          sourceV = angular(vA, vA + 2 * Math.PI, (j + fv) / 4);
        }
        if (
          carrier.kind === 'cylinder' ||
          carrier.kind === 'cone' ||
          carrier.kind === 'sphere' ||
          carrier.kind === 'torus'
        ) {
          const inverse = surfaceInverse(carrier, actual);
          sourceU = inverse.u + Math.round((sourceU - inverse.u) / (2 * Math.PI)) * 2 * Math.PI;
          if (carrier.kind === 'sphere' || carrier.kind === 'torus')
            sourceV = inverse.v + Math.round((sourceV - inverse.v) / (2 * Math.PI)) * 2 * Math.PI;
        }
        worst = Math.max(worst, distance(actual, surfacePoint(carrier, sourceU, sourceV)));
      }
    }
  }
  return worst;
}

describe('B-rep shape surfaces', () => {
  it('maps every box face to an exact bilinear patch and retains labels and face indices', () => {
    const shape = must(box({ size: [2, 3, 4], label: 'case' }));
    const out = must(shapeSurfaces(shape));
    expect(out.skipped).toEqual([]);
    expect(out.surfaces).toHaveLength(6);
    expect(out.faces).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.surfaces.map((s) => s.name)).toEqual(shape.faces.map((f) => f.label));
    expect(out.surfaces.every((s) => s.surface.degreeU === 1 && s.surface.degreeV === 1)).toBe(
      true,
    );
    expect(exactSampleError(shape)).toBeLessThan(1e-12);
  });

  it('converts full cylinder and cone angular extents into exact rational patches', () => {
    for (const shape of [
      must(cylinder({ radius: 2, height: 4 })),
      must(cone({ radius: 1.5, height: 3 })),
    ]) {
      const converted = must(shapeSurfaces(shape));
      expect(converted.skipped).toEqual([]);
      expect(converted.surfaces.some((s) => s.surface.weights !== undefined)).toBe(true);
      expect(exactSampleError(shape)).toBeLessThan(1e-12);
    }
    const shape = must(cylinder({ radius: 2, height: 4 }));
    const converted = must(shapeSurfaces(shape));
    const sideIndex = shape.faces.findIndex(
      (f) => (shape.surfaces[f.surface] as Shape['surfaces'][number]).kind === 'cylinder',
    );
    const surface = converted.surfaces[converted.faces.indexOf(sideIndex)]?.surface;
    if (surface === undefined) throw new Error('cylinder patch missing');
    const curvature = surfaceCurvature(surface, 0.5, 0.5);
    expect(curvature).toBeDefined();
    expect(Math.abs(curvature?.gaussian ?? Infinity)).toBeLessThan(1e-12);
    expect(Math.abs(Math.abs(curvature?.mean ?? Infinity) - 1 / 4)).toBeLessThan(1e-12);
  });

  it('splits full sphere and torus turns into exact rational patches with arcs at most 90 degrees', () => {
    for (const [shape, expected] of [
      [must(sphere({ radius: 1.5 })), 8],
      [must(torus({ major: 3, minor: 0.75 })), 16],
    ] as const) {
      const converted = must(shapeSurfaces(shape));
      expect(converted.skipped).toEqual([]);
      expect(converted.surfaces.length).toBeGreaterThanOrEqual(expected);
      expect(converted.surfaces.every((s) => s.surface.weights !== undefined)).toBe(true);
      expect(
        converted.surfaces.every((s) => s.surface.degreeU === 2 && s.surface.degreeV === 2),
      ).toBe(true);
      expect(exactSampleError(shape)).toBeLessThan(1e-12);
    }
  });

  it('matches analytic B-rep evaluations over filleted-box planar and rational faces', () => {
    const shape = must(filletBox({ size: [4, 3, 2], radius: 0.5 }));
    expect(must(shapeSurfaces(shape)).skipped).toEqual([]);
    expect(exactSampleError(shape)).toBeLessThan(1e-12);
  });

  it('reports every box shared plane edge as a G0 crease, never G1', () => {
    const shape = must(box({ size: [2, 3, 4] }));
    const result = checkSurfaceQuality(
      { surfaces: must(shapeSurfaces(shape)).surfaces },
      { continuity: 'G1', isoparms: 0, maxNet: [8, 6], adjacency: 1e-4, reach: 1e-3 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sharedPlaneEdges = result.value.edges.filter((edge) => {
      const a = shape.faces.findIndex((face) => face.label === edge.a);
      const b = shape.faces.findIndex((face) => face.label === edge.b);
      return (
        a >= 0 &&
        b >= 0 &&
        shape.surfaces[shape.faces[a]!.surface]?.kind === 'plane' &&
        shape.surfaces[shape.faces[b]!.surface]?.kind === 'plane'
      );
    });
    expect(sharedPlaneEdges.length).toBeGreaterThan(0);
    for (const edge of sharedPlaneEdges) {
      expect(edge.achieved).toBe('G0');
      expect(edge.pass).toBe(false);
      expect(edge.angle.value).toBeGreaterThan(result.value.thresholds.angle);
    }
  });

  it('reports fillet-plane joins as G1 with a curvature jump near 1/r and traces straight fillet highlights', () => {
    const radius = 0.5;
    const shape = must(filletBox({ size: [4, 3, 2], radius }));
    const converted = must(shapeSurfaces(shape));
    const report = must(
      checkSurfaceQuality(
        { surfaces: converted.surfaces },
        {
          continuity: 'G2',
          classes: {
            primary: { position: 1e-5, angle: 0.1, curvatureRatio: 0.02, rateRatio: 0.1 },
            blend: { position: 1e-5, angle: 0.1, curvatureRatio: 0.02, rateRatio: 0.1 },
            trim: { position: 1e-5, angle: 0.1, curvatureRatio: 0.02, rateRatio: 0.1 },
          },
          isoparms: 0,
          maxNet: [32, 32],
          adjacency: 0.01,
        },
      ),
    );
    const joins = report.edges.filter((edge) => {
      const a = converted.surfaces.find((s) => s.name === edge.a);
      const b = converted.surfaces.find((s) => s.name === edge.b);
      return (
        (a?.surface.weights !== undefined && b?.surface.degreeU === 1 && b.surface.degreeV === 1) ||
        (b?.surface.weights !== undefined && a?.surface.degreeU === 1 && a.surface.degreeV === 1)
      );
    });
    expect(joins.length).toBeGreaterThan(0);
    for (const edge of joins) {
      expect(edge.achieved).toBe('G1');
      expect(edge.required).toBe('G2');
      expect(edge.pass).toBe(false);
      // A fillet of radius r meets its planes with a curvature jump of exactly 1/r.
      expect(Math.abs(edge.curvature.value * radius - 1)).toBeLessThan(0.03);
    }

    const face = shape.faces.find((f) => shape.surfaces[f.surface]?.kind === 'cylinder');
    if (face === undefined) throw new Error('fillet cylinder face missing');
    const faceIndex = shape.faces.indexOf(face);
    const cylinderLoop = shape.loops[face.loops[0] as number];
    const edgeUse = cylinderLoop?.coedges
      .map((coedgeId) => shape.coedges[coedgeId])
      .find((coedge) => {
        const e = coedge === undefined ? undefined : shape.edges[coedge.edge];
        return e !== undefined && e.curve >= 0 && shape.curves[e.curve]?.kind === 'line';
      });
    if (edgeUse === undefined) throw new Error('straight fillet boundary edge missing');
    const edge = shape.edges[edgeUse.edge] as Shape['edges'][number];
    const curve = shape.curves[edge.curve] as Shape['curves'][number];
    if (curve.kind !== 'line') throw new Error('expected a straight fillet boundary');
    const direction = curve.d;
    const patches = converted.surfaces.filter((_, i) => converted.faces[i] === faceIndex);
    const highlights = must(
      highlightLines(
        patches.map((s) => s.surface),
        {
          field: 'isophote',
          direction: [0, 0, 1],
          step: 10,
        },
      ),
    );
    const matching = highlights.lines.filter((line) => {
      if (line.patches.length === 0) return false;
      const points = Array.from({ length: 25 }, (_, i) =>
        curvePoint(
          line.curve,
          curveDomain(line.curve)[0] +
            ((curveDomain(line.curve)[1] - curveDomain(line.curve)[0]) * i) / 24,
        ),
      );
      const straight = points.slice(1).every((point, index) => {
        const previous = points[index] as typeof point;
        const delta: [number, number, number] = [
          point[0] - previous[0],
          point[1] - previous[1],
          point[2] - previous[2],
        ];
        const cross: [number, number, number] = [
          delta[1] * direction[2] - delta[2] * direction[1],
          delta[2] * direction[0] - delta[0] * direction[2],
          delta[0] * direction[1] - delta[1] * direction[0],
        ];
        const length = Math.sqrt(delta[0] ** 2 + delta[1] ** 2 + delta[2] ** 2);
        const crossLength = Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2);
        return length > 0 && crossLength / length < 0.03;
      });
      return straight;
    });
    expect(highlights.lines.length).toBeGreaterThan(0);
    expect(matching.length).toBeGreaterThan(0);
  });

  it('grades shared rational B-rep patches through G3 under D09 limits', () => {
    const shape = must(sphere({ radius: 2 }));
    const converted = must(shapeSurfaces(shape));
    expect(converted.surfaces.some((s) => s.surface.weights !== undefined)).toBe(true);
    const result = checkSurfaceQuality(
      { surfaces: converted.surfaces },
      { classes: D09_CLASSES, continuity: 'G3', isoparms: 0, maxNet: [32, 32] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.edges.length).toBeGreaterThan(0);
      expect(result.value.edges.some((edge) => edge.achieved === 'G3')).toBe(true);
    }
  });

  it('rejects malformed Shapes and invalid arc settings as structured errors', () => {
    expect(shapeSurfaces({} as Shape).ok).toBe(false);
    expect(shapeSurfaces(must(box({ size: [1, 1, 1] })), { arcDegrees: 60 as 90 }).ok).toBe(false);
  });

  it('traces section highlight lines on converted exact patches', () => {
    const surfaces = must(shapeSurfaces(must(box({ size: [2, 2, 2] })))).surfaces;
    const result = highlightLines(
      surfaces.map((s) => s.surface),
      { field: 'section', normal: [0, 0, 1], step: 0.2 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.lines.length).toBeGreaterThan(0);
  });
});
