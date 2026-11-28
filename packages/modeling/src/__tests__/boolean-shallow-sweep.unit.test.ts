import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { sel } from '../selectors';
import base from './golden/boolean-shallow-base-bad.json';

/**
 * Regression sweep: cube pairs with a shallow tilt, scored against the exact volume of the
 * convex intersection. `base-bad` lists every case that fails at a9211b2, before the band
 * settling; a case outside it must never fail (no regression), and every case that does
 * close must carry the right volume. The two sweeps are the K2c audit's (13230 cases).
 */

type V = [number, number, number];
type Face = readonly V[];
type Matrix = readonly [V, V, V];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: V) => Math.sqrt(dot(a, a));
const centroid = (pts: readonly V[]): V => mul(pts.reduce(add, [0, 0, 0] as V), 1 / pts.length);

function rotMat(axis: 'x' | 'y' | 'z', deg: number): Matrix {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  if (axis === 'x')
    return [
      [1, 0, 0],
      [0, c, -s],
      [0, s, c],
    ];
  if (axis === 'y')
    return [
      [c, 0, s],
      [0, 1, 0],
      [-s, 0, c],
    ];
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}
const apply = (m: Matrix, p: V): V => [dot(m[0], p), dot(m[1], p), dot(m[2], p)];
const column = (m: Matrix, j: 0 | 1 | 2): V => [m[0][j], m[1][j], m[2][j]];
const matmul = (a: Matrix, b: Matrix): Matrix => [
  [dot(a[0], column(b, 0)), dot(a[0], column(b, 1)), dot(a[0], column(b, 2))],
  [dot(a[1], column(b, 0)), dot(a[1], column(b, 1)), dot(a[1], column(b, 2))],
  [dot(a[2], column(b, 0)), dot(a[2], column(b, 1)), dot(a[2], column(b, 2))],
];
const IDENTITY: Matrix = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function boxFaces(c: V, size: number): Face[] {
  const h = size / 2;
  const P = (x: number, y: number, z: number): V => [c[0] + x * h, c[1] + y * h, c[2] + z * h];
  return [
    [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)],
    [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
    [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
    [P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)],
    [P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1)],
    [P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)],
  ];
}

const TINY = 1e-13;

/** Clip a convex polytope's faces to the half-space n.p <= w, closing the cut with a cap. */
function clip(poly: readonly Face[], n: V, w: number): Face[] {
  const faces: V[][] = [];
  let cap: V[] = [];
  let coincident = false;
  for (const face of poly) {
    const out: V[] = [];
    const on: V[] = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i] as V;
      const b = face[(i + 1) % face.length] as V;
      const da = dot(n, a) - w;
      const db = dot(n, b) - w;
      if (da <= TINY) out.push(a);
      if (Math.abs(da) <= TINY) on.push(a);
      else if ((da < 0 && db > TINY) || (da > 0 && db < -TINY)) {
        const p = add(a, mul(sub(b, a), da / (da - db)));
        out.push(p);
        on.push(p);
      }
    }
    if (on.length === face.length && face.every((p) => Math.abs(dot(n, p) - w) <= TINY))
      coincident = true;
    if (out.length >= 3) faces.push(out);
    cap.push(...on);
  }
  const unique: V[] = [];
  for (const p of cap) if (!unique.some((q) => len(sub(p, q)) < 1e-11)) unique.push(p);
  cap = unique;
  if (!coincident && cap.length >= 3) {
    const c = centroid(cap);
    const u: V = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = cross(n, u);
    const E1 = mul(e1, 1 / len(e1));
    const E2 = cross(n, E1);
    const angle = (p: V) => Math.atan2(dot(sub(p, c), E2), dot(sub(p, c), E1));
    cap.sort((p, q) => angle(p) - angle(q));
    faces.push(cap);
  }
  return faces;
}

function volume(poly: readonly Face[]): number {
  const pts = poly.flat();
  if (pts.length === 0) return 0;
  const c = centroid(pts);
  let v = 0;
  for (const f of poly)
    for (let i = 1; i < f.length - 1; i++)
      v += Math.abs(dot(sub(f[0] as V, c), cross(sub(f[i] as V, c), sub(f[i + 1] as V, c)))) / 6;
  return v;
}

function planesOf(poly: readonly Face[]): { n: V; w: number }[] {
  const c = centroid(poly.flat());
  return poly.map((f) => {
    let n = cross(sub(f[1] as V, f[0] as V), sub(f[2] as V, f[0] as V));
    n = mul(n, 1 / len(n));
    let w = dot(n, f[0] as V);
    if (dot(n, c) - w > 0) {
      n = mul(n, -1);
      w = -w;
    }
    return { n, w };
  });
}

function intersectionVolume(a: readonly Face[], b: readonly Face[]): number {
  let p = [...a];
  for (const { n, w } of planesOf(b)) p = clip(p, n, w);
  return volume(p);
}

type Operation = 'difference' | 'union' | 'intersection';
const OPERATIONS: readonly Operation[] = ['difference', 'union', 'intersection'];
type Step = readonly ['x' | 'y' | 'z', number];

function truthOf(sc: number, a: readonly Face[], b: readonly Face[]) {
  const volumeOfBox = sc ** 3;
  const shared = intersectionVolume(a, b);
  return {
    volumeOfBox,
    truth: {
      difference: volumeOfBox - shared,
      union: 2 * volumeOfBox - shared,
      intersection: shared,
    } as Record<Operation, number>,
  };
}

function sweepOne() {
  const angles = [0.0003, 0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 5, 12];
  const tilts: Record<string, readonly (readonly ['x' | 'y' | 'z', number])[]> = {
    x: [['x', 1]],
    y: [['y', 1]],
    z: [['z', 1]],
    xy: [
      ['x', 1],
      ['y', 0.7],
    ],
    xz: [
      ['x', 0.5],
      ['z', 1],
    ],
    yz: [
      ['y', 1],
      ['z', -0.4],
    ],
    xyz: [
      ['x', 1],
      ['y', 0.6],
      ['z', 0.3],
    ],
  };
  const pivots: Record<string, V> = {
    center: [0, 0, 0],
    corner: [0.5, 0.5, 0.5],
    offset: [0.37, -0.21, 0.11],
  };
  const failed: string[] = [];
  let wrong = 0;
  let total = 0;
  for (const sc of [0.01, 1, 100])
    for (const [tiltName, tilt] of Object.entries(tilts))
      for (const [pivotName, unit] of Object.entries(pivots))
        for (const angle of angles)
          for (const sign of [1, -1]) {
            const deg = angle * sign;
            const pivot = mul(unit, sc);
            const steps: Step[] = tilt.map(([axis, factor]) => [axis, factor * deg]);
            let R = IDENTITY;
            for (const [axis, d] of steps) R = matmul(rotMat(axis, d), R);
            const A = boxFaces([0, 0, 0], sc);
            const B = A.map((f) => f.map((p) => add(apply(R, sub(p, pivot)), pivot)));
            const { volumeOfBox, truth } = truthOf(sc, A, B);
            const snapVolume = 6 * 5 * 1e-5 * sc * sc;
            for (const operation of OPERATIONS) {
              total++;
              const m = model();
              m.box({ size: [sc, sc, sc] });
              const t = model();
              t.box({ size: [sc, sc, sc] });
              for (const [axis, d] of steps) t.rotate(sel.all(), axis, d, pivot);
              const r = m[operation](t, { onPartial: 'error' });
              const key = [sc, tiltName, pivotName, deg, operation].join('|');
              if (r.status === 'ok') {
                const v = m.validate();
                if (!(v.pass && Math.abs(v.volume - truth[operation]) <= snapVolume)) {
                  wrong++;
                  failed.push(key);
                }
              } else if (!(truth[operation] <= snapVolume && operation === 'difference')) {
                failed.push(key);
              }
              void volumeOfBox;
            }
          }
  return { total, failed, wrong };
}

function sweepTwo() {
  const angles = [0.002, 0.005, 0.02, 0.05, 0.2, 0.5, 2];
  const offsets: V[] = [
    [0.5, 0, 0],
    [0, 0.3, 0],
    [0.4, 0.4, 0],
    [0.5, 0.2, -0.3],
    [0.9, 0, 0],
    [0.1, 0.05, 0.02],
  ];
  const rotations: Record<string, readonly (readonly ['x' | 'y' | 'z', number])[]> = {
    x: [['x', 1]],
    y: [['y', 1]],
    z: [['z', 1]],
    xy: [
      ['x', 1],
      ['y', 0.6],
    ],
    yz: [
      ['y', 1],
      ['z', 0.8],
    ],
    xyz: [
      ['x', 1],
      ['y', 0.6],
      ['z', 0.3],
    ],
  };
  const failed: string[] = [];
  let wrong = 0;
  let total = 0;
  for (const sc of [0.02, 1, 40])
    for (const off of offsets)
      for (const [rotationName, rotation] of Object.entries(rotations))
        for (const pivotOn of ['tool', 'target'])
          for (const angle of angles)
            for (const sign of [1, -1]) {
              const deg = angle * sign;
              const c = mul(off, sc);
              const pivot: V = pivotOn === 'tool' ? c : [0, 0, 0];
              let R = IDENTITY;
              for (const [axis, factor] of rotation) R = matmul(rotMat(axis, factor * deg), R);
              const A = boxFaces([0, 0, 0], sc);
              const B = boxFaces(c, sc).map((f) =>
                f.map((p) => add(apply(R, sub(p, pivot)), pivot)),
              );
              const { volumeOfBox, truth } = truthOf(sc, A, B);
              for (const operation of OPERATIONS) {
                total++;
                const m = model();
                m.box({ size: [sc, sc, sc] });
                const t = model();
                t.box({ size: [sc, sc, sc], center: c });
                for (const [axis, factor] of rotation)
                  t.rotate(sel.all(), axis, factor * deg, pivot);
                const r = m[operation](t, { onPartial: 'error' });
                const key = [sc, off.join(','), rotationName, pivotOn, deg, operation].join('|');
                if (r.status !== 'ok') {
                  failed.push(key);
                  continue;
                }
                const v = m.validate();
                if (
                  !(
                    v.pass &&
                    v.closed &&
                    Math.abs(v.volume - truth[operation]) / volumeOfBox < 5e-3
                  )
                ) {
                  wrong++;
                  failed.push(key);
                }
              }
            }
  return { total, failed, wrong };
}

describe('boolean sweep of shallow tilts against the exact volume', () => {
  const known = (list: readonly string[]) => new Set(list);

  it('sweep 1 (4158 cases): no case the base closed fails, and every closed case is exact', () => {
    const result = sweepOne();
    expect(result.total).toBe(4158);
    const baseBad = known(base.sweep1);
    expect(result.failed.filter((key) => !baseBad.has(key))).toEqual([]);
    expect(result.wrong).toBe(0);
    expect(result.failed.length).toBeLessThanOrEqual(171);
  }, 240_000);

  it('sweep 2 (9072 cases): no case the base closed fails, and every closed case is exact', () => {
    const result = sweepTwo();
    expect(result.total).toBe(9072);
    const baseBad = known(base.sweep2);
    expect(result.failed.filter((key) => !baseBad.has(key))).toEqual([]);
    expect(result.wrong).toBe(0);
    expect(result.failed.length).toBeLessThanOrEqual(86);
  }, 240_000);
});
