import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { triangleDistance } from '../compute/clearance';
import type { Tuple3 } from '../geom';
import { type Model, model } from '../model';
import type { NurbsSurface } from '../nurbs';
import { sel } from '../selectors';

const T = 0.003;
const CLEARANCE = T / 3;
const STEP = 0.01;
const K = 0.315;

/** A bilinear patch through four corners: [u0v0, u0v1], [u1v0, u1v1]. */
function quad(a: Tuple3, b: Tuple3, c: Tuple3, d: Tuple3): NurbsSurface {
  return {
    degreeU: 1,
    degreeV: 1,
    points: [
      [a, b],
      [c, d],
    ],
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/**
 * The F1 D05 nose shut in miniature: a centre panel (x > 0) and a corner piece (x < 0), each a
 * top and a front face meeting at a convex crease along x, `gap` apart across the shut at x = 0.
 * The body turns across the shut (a ridge, slope `k` per side), so on both sides the inner miter
 * vertex of the crease corner runs toward the other part, past the rays of its vertices.
 */
function nose(
  gap: number,
  options: {
    readonly k?: number;
    readonly parts?: 'both' | 'centre' | 'corner';
    /** Reverse the faces, so an `out` shell builds the walls an `in` shell builds. */
    readonly flip?: boolean;
  } = {},
): Model {
  const k = options.k ?? K;
  const m = model();
  for (const side of { both: [1, -1], centre: [1], corner: [-1] }[options.parts ?? 'both']) {
    const name = side > 0 ? 'centre' : 'corner';
    const at = (x: number, y: number, z: number): Tuple3 => [
      x,
      k * Math.abs(x) + y,
      -k * Math.abs(x) - z,
    ];
    const patches: { name: string; surface: NurbsSurface; flip?: boolean }[] = [];
    for (let i = 0; i < 6; i++) {
      const [x0, x1] = [i, i + 1].map((j) => side * (gap / 2 + j * STEP)) as [number, number];
      const [near, far] = side > 0 ? [x0, x1] : [x1, x0];
      for (let j = 0; j < 4; j++) {
        const [a, b] = [j * STEP, (j + 1) * STEP];
        patches.push({
          name: `${name}-top-${i}-${j}`,
          surface: quad(at(near, a, 0), at(near, b, 0), at(far, a, 0), at(far, b, 0)),
          ...(options.flip === true ? { flip: true } : {}),
        });
        patches.push({
          name: `${name}-front-${i}-${j}`,
          surface: quad(at(near, 0, b), at(near, 0, a), at(far, 0, b), at(far, 0, a)),
          ...(options.flip === true ? { flip: true } : {}),
        });
      }
    }
    expect(m.surface({ patches, label: name }).status).toBe('ok');
  }
  return m;
}

const BOTH = sel.createdBy('centre').or(sel.createdBy('corner'));

/** Triangles of every connected part of the mesh, by lowest vertex. */
function parts(m: Model): Tuple3[][][] {
  const mesh = m.editMesh;
  const root = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while ((root.get(r) ?? r) !== r) r = root.get(r) as number;
    return r;
  };
  for (const f of mesh.faces()) {
    const loop = mesh.faceVertices(f);
    for (const v of loop) root.set(find(v), find(loop[0] as number));
  }
  const groups = new Map<number, Tuple3[][]>();
  for (const f of mesh.faces()) {
    const loop = mesh.faceVertices(f).map((v) => mesh.position(v));
    const key = find(mesh.faceVertices(f)[0] as number);
    const list = groups.get(key) ?? [];
    for (let i = 1; i + 1 < loop.length; i++) {
      list.push([loop[0] as Tuple3, loop[i] as Tuple3, loop[i + 1] as Tuple3]);
    }
    groups.set(key, list);
  }
  return [...groups.values()];
}

/** Smallest distance between two parts' shells, of one model or two (0 when they touch or cross). */
function gapBetween(m: Model, other?: Model): number {
  const [a, b] = (other === undefined ? parts(m) : [...parts(m), ...parts(other)]) as [
    Tuple3[][],
    Tuple3[][],
  ];
  expect(other === undefined ? parts(m).length : 2).toBe(2);
  let best = Infinity;
  for (const s of a) for (const t of b) best = Math.min(best, triangleDistance(s, t));
  return best;
}

/** Snapshot digests on the base commit (main 5047b49), before the relief existed. */
const BASE = {
  one: '0796d962003508cb',
  far: 'dce77bc0c89e6dc8',
  near: '42d8583c20ef3552',
  out: '23f56b392f421226',
};

const sha = (m: Model) => createHash('sha256').update(m.snapshot()).digest('hex').slice(0, 16);

interface NearWall {
  vertex: number;
  thickness: number;
  distance: number;
  partner: number;
}

/** The near-wall warning of a shell report. */
function nearOf(r: { readonly diagnostics?: readonly { readonly detail?: unknown }[] }) {
  return r.diagnostics?.find((d) => (d.detail as { nearWalls?: unknown } | undefined)?.nearWalls)
    ?.detail as
    | {
        nearWalls: NearWall[];
        nearCount: number;
        relieved: boolean;
        clearance: number;
        point: Tuple3;
      }
    | undefined;
}

/** Each wall's partner is a face of the other part; the first wall is at the shut corner. */
function expectPartners(m: Model, walls: readonly NearWall[]) {
  for (const { vertex, partner } of walls) {
    const p = m.editMesh.position(vertex);
    expect(sel.createdBy(p[0] > 0 ? 'corner' : 'centre').evaluate(m.editMesh)).toContain(partner);
  }
  expect(Math.hypot(...m.editMesh.position((walls[0] as NearWall).vertex))).toBeLessThan(T * 2);
}

/** The validate issue a follow-on gate reads. */
function validateIssue(m: Model) {
  return m
    .validate()
    .issues.find(
      (i) => i.code === 'thin-wall' && (i.detail as { check?: string }).check === 'shell-clearance',
    );
}

/** Each part shelled on its own (one part per call never relieves): the walls as planned. */
function unrelieved(gap: number): number {
  const [centre, corner] = (['centre', 'corner'] as const).map((parts) => {
    const m = nose(gap, { parts });
    expect(m.shell(BOTH, { thickness: T }).status).toBe('ok');
    return m;
  }) as [Model, Model];
  return gapBetween(centre, corner);
}

describe('shell relieves the walls of neighbouring parts at a shared corner', () => {
  it('gate: clamp relieves the crease corners so the shells keep a third of the thickness apart', () => {
    for (const gap of [0.0035, 0.003]) {
      const m = nose(gap);
      const r = m.shell(BOTH, { thickness: T, clamp: true });
      expect(r.status).toBe('ok');
      expect(gapBetween(m)).toBeGreaterThanOrEqual(CLEARANCE * (1 - 1e-9));
      expect(r.diagnostics?.some((d) => d.message.includes('self-intersects'))).toBe(false);
      const near = nearOf(r);
      if (near === undefined) throw new Error('no near-wall warning');
      expect(near.relieved).toBe(true);
      expect(near.clearance).toBeCloseTo(CLEARANCE, 12);
      // Only the two crease corners at the shut (one per part), each against the other part.
      expect(near.nearCount).toBe(2);
      for (const { thickness, distance } of near.nearWalls) {
        expect(thickness).toBeGreaterThanOrEqual(T / 3);
        expect(thickness).toBeLessThan(T);
        expect(distance).toBeLessThan(CLEARANCE);
      }
      expectPartners(m, near.nearWalls);
      expect(r.diagnostics?.find((d) => d.detail === near)?.severity).toBe('warn');
      expect((validateIssue(m)?.detail as { relieved: boolean }).relieved).toBe(true);
    }
  });

  it('falsifier: unrelieved, the walls come 0.2 mm apart at a 3.5 mm shut and cross at 3.0 mm', () => {
    const near = unrelieved(0.0035);
    expect(near).toBeLessThan(CLEARANCE / 4);
    expect(near).toBeGreaterThan(0);
    expect(unrelieved(0.003)).toBe(0);
  });

  it('without clamp: the walls as today, with a located warning a validate gate sees', () => {
    const m = nose(0.0035);
    const r = m.shell(BOTH, { thickness: T });
    expect(r.status).toBe('ok');
    expect(sha(m)).toBe(BASE.near);
    const near = nearOf(r);
    if (near === undefined) throw new Error('no near-wall warning');
    expect(near.relieved).toBe(false);
    // The vertices of every near wall triangle, the crease corners nearest.
    expect(near.nearCount).toBeGreaterThanOrEqual(2);
    expect(near.nearCount).toBeLessThanOrEqual(16);
    for (const { thickness, distance } of near.nearWalls) {
      expect(thickness).toBe(T);
      expect(distance).toBeGreaterThan(0);
      expect(distance).toBeLessThan(CLEARANCE);
    }
    expect(near.nearWalls[0]?.distance).toBeLessThan(CLEARANCE / 4);
    expectPartners(m, near.nearWalls);
    expect(Math.hypot(...near.point)).toBeLessThan(T * 2);
    const issue = validateIssue(m);
    expect(issue?.severity).toBe('warn');
    expect((issue?.detail as { walls: NearWall[] }).walls).toEqual(near.nearWalls);
  });

  it("direction 'out': the same walls are only reported, never relieved", () => {
    const m = nose(0.0035, { flip: true });
    const r = m.shell(BOTH, { thickness: T, direction: 'out', clamp: true });
    expect(r.status).toBe('ok');
    expect(sha(m)).toBe(BASE.out);
    const near = nearOf(r);
    expect(near?.relieved).toBe(false);
    expect(near?.nearCount).toBeGreaterThanOrEqual(2);
    expect(near?.nearWalls.every((w) => w.thickness === T)).toBe(true);
  });

  it('a shut too tight for walls of a third of the thickness still fails with clamp', () => {
    const m = nose(0.0015);
    const r = m.shell(BOTH, { thickness: T, clamp: true });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    const detail = r.error?.detail as { limitedBy: string; maxThickness: number };
    expect(detail.limitedBy).toBe('clearance');
    expect(detail.maxThickness).toBeLessThan(T);
    // The reported maximum is honest: just under it the clamped shell fits.
    const fits = nose(0.0015);
    expect(fits.shell(BOTH, { thickness: 0.98 * detail.maxThickness, clamp: true }).status).toBe(
      'ok',
    );
    expect(gapBetween(fits)).toBeGreaterThanOrEqual((0.98 * detail.maxThickness) / 3 - 1e-9);
  });

  it('a shut tighter than a third of the thickness never passes with crossing walls', () => {
    // Before: 0.9 and 0.5 mm shuts returned ok with 54-59 crossing face pairs (the near pairs
    // were dropped because the outer surfaces were already that close), and 1.0 mm reported
    // maxThickness 0.
    for (const gap of [0.0012, 0.001, 0.0009, 0.0005]) {
      const m = nose(gap);
      const r = m.shell(BOTH, { thickness: T, clamp: true });
      expect(r.status, `${gap}`).toBe('failed');
      expect(r.error?.code).toBe('model-precondition');
      const detail = r.error?.detail as { limitedBy: string; maxThickness: number; point: Tuple3 };
      expect(detail.limitedBy).toBe('clearance');
      expect(Math.hypot(...detail.point)).toBeLessThan(2 * T);
      expect(detail.maxThickness).toBeGreaterThan(0);
      expect(detail.maxThickness).toBeLessThan(T);
      // Under the reported maximum the walls keep half the shut apart, and nothing crosses.
      const fits = nose(gap);
      const thin = 0.98 * detail.maxThickness;
      expect(fits.shell(BOTH, { thickness: thin, clamp: true }).status).toBe('ok');
      expect(gapBetween(fits)).toBeGreaterThanOrEqual(Math.min(thin / 3, gap / 2) - 1e-9);
      expect(fits.validate().issues.some((i) => i.code === 'self-intersection')).toBe(false);
    }
  });

  it('validate sees no crossing walls of a 0.9 mm shut, and counts the shell it checked', () => {
    const m = nose(0.0009);
    m.shell(BOTH, { thickness: T, clamp: true });
    const fits = nose(0.0009);
    expect(fits.shell(BOTH, { thickness: 0.00126, clamp: true }).status).toBe('ok');
    for (const session of [m, fits]) {
      const report = session.validate();
      expect(
        report.issues.filter((i) => i.code === 'self-intersection' && i.severity === 'warn'),
      ).toEqual([]);
    }
    const report = fits.validate();
    expect(report.coverage.checked.find((c) => c.code === 'thin-wall')?.subjects).toBe(1);
    expect(report.pass).toBe(true);
  });

  it('without clamp, crossing walls fail at the crossing; clamp relieves them', () => {
    // Before: the 3.0 mm shut returned ok with a near-wall warning and 12 crossing face pairs.
    const m = nose(0.003);
    const r = m.shell(BOTH, { thickness: T });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.hint).toContain('clamp: true');
    const detail = r.error?.detail as {
      point: Tuple3;
      parts: { face: number; label: string }[];
    };
    expect(detail.parts.map((part) => part.label).sort()).toEqual(['centre', 'corner']);
    expect(Math.hypot(...detail.point)).toBeLessThan(2 * T);
    const relieved = nose(0.003);
    expect(relieved.shell(BOTH, { thickness: T, clamp: true }).status).toBe('ok');
    expect(gapBetween(relieved)).toBeGreaterThanOrEqual(CLEARANCE * (1 - 1e-9));
  });

  it('single-part shells and parts far apart are unchanged (no warning, base bytes)', () => {
    const one = nose(0.0035, { parts: 'centre' });
    const far = nose(0.05);
    for (const m of [one, far]) {
      const r = m.shell(BOTH, { thickness: T, clamp: true });
      expect(r.status).toBe('ok');
      expect(nearOf(r)).toBeUndefined();
      expect(validateIssue(m)).toBeUndefined();
    }
    expect([sha(one), sha(far)]).toEqual([BASE.one, BASE.far]);
  });
});
