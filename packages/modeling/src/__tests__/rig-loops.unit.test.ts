import { describe, expect, it } from 'vitest';
import { applyPoint, invertRigid, multiply } from '../affine';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type Pose, type Rig, rig } from '../rig';

type P2 = readonly [number, number];

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const at = (o: P2, length: number, angle: number): P2 => [
  o[0] + length * Math.cos(angle),
  o[1] + length * Math.sin(angle),
];
const xyz = (p: P2): Tuple3 => [p[0], p[1], 0];

/** Intersection of circles (c1, r1) and (c2, r2) nearest `near`. */
function meet(c1: P2, r1: number, c2: P2, r2: number, near: P2): P2 {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m: P2 = [c1[0] + (a * dx) / d, c1[1] + (a * dy) / d];
  const p: P2 = [m[0] - (h * dy) / d, m[1] + (h * dx) / d];
  const q: P2 = [m[0] + (h * dy) / d, m[1] - (h * dx) / d];
  return Math.hypot(p[0] - near[0], p[1] - near[1]) <= Math.hypot(q[0] - near[0], q[1] - near[1])
    ? p
    : q;
}

/** Where a rest model-space point of joint `name`'s body sits at a pose. */
function placed(r: Rig, pose: Pose, name: string, p: Tuple3): Tuple3 {
  const posed = r.pose(pose);
  if (!posed.ok) throw posed.error;
  const world = posed.value.joints.find((j) => j.name === name)?.world as number[];
  const rest = r.joints.find((j) => j.name === name)?.rest as number[];
  return applyPoint(multiply(world, invertRigid(rest)), p);
}

const gap = (p: Tuple3, q: Tuple3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** Planar four-bar about z: ground O2-O4, crank O2-A, coupler A-B, rocker O4-B, cut at B. */
function fourBar(a: number, b: number, c: number, d: number, theta0: number) {
  const o2: P2 = [0, 0];
  const o4: P2 = [d, 0];
  const A = at(o2, a, rad(theta0));
  const B = meet(A, b, o4, c, [d, c]);
  const r = rig(model(), {
    joints: [
      { name: 'ground', parent: null, position: [0, 0, 0] },
      { name: 'crank', parent: 'ground', position: xyz(o2), kind: 'revolute', axis: 'z' },
      { name: 'coupler', parent: 'crank', position: xyz(A), kind: 'revolute', axis: 'z' },
      { name: 'rocker', parent: 'ground', position: xyz(o4), kind: 'revolute', axis: 'z' },
    ],
    loops: [{ name: 'b', a: 'rocker', b: 'coupler', kind: 'pin', at: xyz(B), axis: 'z' }],
  });
  return { r, o2, o4, A, B };
}

describe('rig loops: solve closes four reference mechanisms', () => {
  it('four-bar: the rocker follows the crank to the analytic angle', () => {
    const { r, o2, o4, B } = fourBar(0.04, 0.12, 0.08, 0.1, 60);
    let near: P2 = B;
    for (const turn of [10, 40, 90, 150, 210, 300]) {
      const solved = r.solve({ crank: turn });
      if (!solved.ok) throw solved.error;
      expect(solved.value.residual).toBeLessThan(1e-9);
      expect(solved.value.solved).toEqual(['coupler', 'rocker']);
      const A = at(o2, 0.04, rad(60 + turn));
      near = meet(A, 0.12, o4, 0.08, near);
      const rocker = deg(Math.atan2(near[1], near[0] - 0.1) - Math.atan2(B[1], B[0] - 0.1));
      const value = solved.value.pose.rocker as number;
      expect(Math.abs(((((value - rocker + 540) % 360) + 360) % 360) - 180)).toBeLessThan(1e-6);
      // Closure error in meters: the pin point carried by both chains.
      const pose = solved.value.pose;
      expect(
        gap(placed(r, pose, 'coupler', xyz(B)), placed(r, pose, 'rocker', xyz(B))),
      ).toBeLessThan(1e-6);
    }
    const m = r.mobility();
    expect(m.ok && m.value).toMatchObject({
      planar: true,
      grubler: 1,
      mobility: 1,
      overconstrained: false,
    });
  });

  it('slider-crank: the slider sits at a cos + sqrt(b^2 - (a sin)^2)', () => {
    const a = 0.05;
    const b = 0.16;
    const A = at([0, 0], a, rad(30));
    const x0 = A[0] + Math.sqrt(b * b - A[1] * A[1]);
    const r = rig(model(), {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'crank', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
        { name: 'rod', parent: 'crank', position: xyz(A), kind: 'revolute', axis: 'z' },
        { name: 'slider', parent: 'ground', position: [x0, 0, 0], kind: 'prismatic', axis: 'x' },
      ],
      loops: [{ name: 'gudgeon', a: 'slider', b: 'rod', kind: 'pin', at: [x0, 0, 0], axis: 'z' }],
    });
    for (const turn of [20, 80, 150, 250, 330]) {
      const solved = r.solve({ crank: turn });
      if (!solved.ok) throw solved.error;
      const t = rad(30 + turn);
      const x = a * Math.cos(t) + Math.sqrt(b * b - (a * Math.sin(t)) ** 2);
      expect(Math.abs((solved.value.pose.slider as number) - (x - x0))).toBeLessThan(1e-6);
      expect(solved.value.residual).toBeLessThan(1e-9);
    }
    const m = r.mobility({}, { drivers: ['crank'] });
    expect(m.ok && m.value).toMatchObject({ planar: true, grubler: 1, mobility: 1 });
    expect(m.ok && m.value.actuation).toMatchObject({ free: 0, underactuated: false });
  });

  it('cylinder rocker: the rod extension drives the arm to the analytic angle', () => {
    // Arm about the origin; a cylinder pivots at P and pushes the arm at R.
    const P: P2 = [0.3, -0.1];
    const R: P2 = [0.2, 0];
    const axis: Tuple3 = [
      (R[0] - P[0]) / Math.hypot(R[0] - P[0], R[1] - P[1]),
      (R[1] - P[1]) / Math.hypot(R[0] - P[0], R[1] - P[1]),
      0,
    ];
    const length0 = Math.hypot(R[0] - P[0], R[1] - P[1]);
    const r = rig(model(), {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'arm', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
        { name: 'barrel', parent: 'ground', position: xyz(P), kind: 'revolute', axis: 'z' },
        { name: 'rod', parent: 'barrel', position: xyz(P), kind: 'prismatic', axis },
      ],
      loops: [{ name: 'eye', a: 'arm', b: 'rod', kind: 'pin', at: xyz(R), axis: 'z' }],
    });
    let near = R;
    for (const s of [0.02, 0.05, 0.08, -0.02]) {
      const solved = r.solve({ rod: s });
      if (!solved.ok) throw solved.error;
      near = meet([0, 0], 0.2, P, length0 + s, near);
      const arm = deg(Math.atan2(near[1], near[0]));
      expect(Math.abs((solved.value.pose.arm as number) - arm)).toBeLessThan(1e-6);
      expect(solved.value.residual).toBeLessThan(1e-9);
    }
    const m = r.mobility({}, { drivers: ['rod'] });
    expect(m.ok && m.value).toMatchObject({ grubler: 1, mobility: 1 });
    expect(m.ok && m.value.actuation?.free).toBe(0);
  });

  it('six-bar (Watt I): two loops close together with one driver', () => {
    const { o4, A, B } = fourBar(0.04, 0.12, 0.08, 0.1, 60);
    // The rocker carries a second coupler from C to an output link about O6.
    const C = at(o4, 0.05, Math.atan2(B[1], B[0] - o4[0]) - 0.6);
    const o6: P2 = [0.2, 0.02];
    const D = meet(C, 0.1, o6, 0.07, [0.2, 0.09]);
    const r = rig(model(), {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'crank', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
        { name: 'coupler', parent: 'crank', position: xyz(A), kind: 'revolute', axis: 'z' },
        { name: 'rocker', parent: 'ground', position: xyz(o4), kind: 'revolute', axis: 'z' },
        { name: 'link', parent: 'rocker', position: xyz(C), kind: 'revolute', axis: 'z' },
        { name: 'output', parent: 'ground', position: xyz(o6), kind: 'revolute', axis: 'z' },
      ],
      loops: [
        { name: 'b', a: 'rocker', b: 'coupler', kind: 'pin', at: xyz(B), axis: 'z' },
        { name: 'd', a: 'output', b: 'link', kind: 'pin', at: xyz(D), axis: 'z' },
      ],
    });
    for (const turn of [5, 15, 30, 45, 60]) {
      const solved = r.solve({ crank: turn });
      if (!solved.ok) throw solved.error;
      expect(solved.value.residual).toBeLessThan(1e-9);
      const pose = solved.value.pose;
      expect(
        gap(placed(r, pose, 'coupler', xyz(B)), placed(r, pose, 'rocker', xyz(B))),
      ).toBeLessThan(1e-6);
      expect(gap(placed(r, pose, 'link', xyz(D)), placed(r, pose, 'output', xyz(D)))).toBeLessThan(
        1e-6,
      );
    }
    const m = r.mobility();
    // 6 links, 7 revolute joints: 3 (6 - 1) - 2 x 7 = 1.
    expect(m.ok && m.value).toMatchObject({
      planar: true,
      grubler: 1,
      mobility: 1,
      coordinates: 5,
    });
  });

  it('poses, scans and exports by solving the loop joints a pose leaves out', () => {
    const { r } = fourBar(0.04, 0.12, 0.08, 0.1, 60);
    const direct = r.pose({ crank: 90 });
    const solved = r.solve({ crank: 90 });
    if (!direct.ok || !solved.ok) throw new Error('pose');
    expect(direct.value.joints.find((j) => j.name === 'rocker')?.value).toBeCloseTo(
      solved.value.pose.rocker as number,
      9,
    );
    expect(r.pose({ crank: 90, rocker: 3 }).ok).toBe(false);
  });
});

/** Both analytic rocker angles (absolute, degrees) of a four-bar at absolute crank angle phi, by side of A-O4. */
function rockerRoots(a: number, b: number, c: number, d: number, phi: number): number[] {
  const A = at([0, 0], a, rad(phi));
  const dx = d - A[0];
  const dy = -A[1];
  const l = Math.hypot(dx, dy);
  const m = (b * b - c * c + l * l) / (2 * l);
  const h = Math.sqrt(Math.max(0, b * b - m * m));
  const base: P2 = [A[0] + (m * dx) / l, A[1] + (m * dy) / l];
  return [
    [base[0] - (h * dy) / l, base[1] + (h * dx) / l],
    [base[0] + (h * dy) / l, base[1] - (h * dx) / l],
  ].map((B) => deg(Math.atan2(B[1] as number, (B[0] as number) - d)));
}

const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;

describe('rig loops: continuation stays on its assembly mode (audit A1)', () => {
  /** Turn the crank a full turn in `step` degree poses; count switches between the analytic roots. */
  function turn(a: number, b: number, c: number, d: number, branch: 0 | 1, step: number) {
    const A = at([0, 0], a, rad(60));
    const rest = rockerRoots(a, b, c, d, 60)[branch] as number;
    const B = at([d, 0], c, rad(rest));
    const r = rig(model(), {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'crank', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
        { name: 'coupler', parent: 'crank', position: xyz(A), kind: 'revolute', axis: 'z' },
        { name: 'rocker', parent: 'ground', position: [d, 0, 0], kind: 'revolute', axis: 'z' },
      ],
      loops: [{ name: 'b', a: 'rocker', b: 'coupler', kind: 'pin', at: xyz(B), axis: 'z' }],
    });
    let mode = branch as number;
    let flips = 0;
    let risky = 0;
    for (let t = 0; t >= -360; t -= step) {
      const s = r.solve({ crank: t });
      if (!s.ok) throw s.error;
      const abs = rest + (s.value.pose.rocker as number);
      const e = rockerRoots(a, b, c, d, 60 + t).map((x) => Math.abs(wrap(abs - x)));
      const now = (e[0] as number) <= (e[1] as number) ? 0 : 1;
      if (now !== mode) flips++;
      mode = now;
      if (s.value.branchRisk) risky++;
    }
    return { flips, risky };
  }

  it('keeps a near-parallelogram on its mode at 7 and 5 degree steps, and flags the fold', {
    timeout: 120000,
  }, () => {
    for (const c of [0.0501, 0.0505, 0.051]) {
      for (const branch of [0, 1] as const) {
        for (const step of [7, 5]) {
          const { flips, risky } = turn(0.05, 0.1, c, 0.1, branch, step);
          expect(flips, `c ${c} branch ${branch} step ${step}`).toBe(0);
          // 0.2 % off a parallelogram the two modes pass within 20 degrees of each other.
          if (c === 0.0501) expect(risky, `c ${c} branch ${branch}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('reports no branch risk on a crank-rocker far from its folds', () => {
    for (const branch of [0, 1] as const) {
      expect(turn(0.04, 0.12, 0.08, 0.1, branch, 7)).toEqual({ flips: 0, risky: 0 });
    }
  });
});

describe('rig loops: falsifiers', () => {
  it('reports the branch risk of a parallelogram at its change point', () => {
    // a = c and b = d: crank, coupler and rocker fold flat onto the ground line at 0 degrees.
    const { r } = fourBar(0.05, 0.1, 0.05, 0.1, 60);
    const open = r.solve({ crank: 0 });
    expect(open.ok && open.value.branchRisk).toBe(false);
    const flat = r.solve({ crank: -60 });
    if (!flat.ok) throw flat.error;
    expect(flat.value.branchRisk).toBe(true);
    expect(flat.value.conditioning).toBeLessThan(1e-3);
  });

  it('reports three coaxial hinges as overconstrained', () => {
    const r = rig(model(), {
      joints: [
        { name: 'frame', parent: null, position: [0, 0, 0] },
        { name: 'door', parent: 'frame', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
      ],
      loops: [
        { name: 'middle', a: 'frame', b: 'door', kind: 'pin', at: [0, 1, 0], axis: 'y' },
        { name: 'top', a: 'frame', b: 'door', kind: 'pin', at: [0, 2, 0], axis: 'y' },
      ],
    });
    const m = r.mobility({ door: 30 });
    if (!m.ok) throw m.error;
    // The count says the door cannot move; the closure Jacobian has rank 0: it turns freely.
    expect(m.value.grubler).toBeLessThan(0);
    expect(m.value.mobility).toBe(1);
    expect(m.value.rank).toBe(0);
    expect(m.value.overconstrained).toBe(true);
    expect(m.value.redundant).toBe(1 - m.value.grubler);
  });

  it('reports a five-bar driven by one crank as underactuated', () => {
    const o1: P2 = [0, 0];
    const o2: P2 = [0.12, 0];
    const A = at(o1, 0.05, rad(80));
    const C = at(o2, 0.05, rad(100));
    const B = meet(A, 0.1, C, 0.1, [0.06, 0.15]);
    const r = rig(model(), {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'left', parent: 'ground', position: xyz(o1), kind: 'revolute', axis: 'z' },
        { name: 'left-link', parent: 'left', position: xyz(A), kind: 'revolute', axis: 'z' },
        { name: 'right', parent: 'ground', position: xyz(o2), kind: 'revolute', axis: 'z' },
        { name: 'right-link', parent: 'right', position: xyz(C), kind: 'revolute', axis: 'z' },
      ],
      loops: [
        { name: 'apex', a: 'right-link', b: 'left-link', kind: 'pin', at: xyz(B), axis: 'z' },
      ],
    });
    const one = r.mobility({}, { drivers: ['left'] });
    if (!one.ok) throw one.error;
    expect(one.value).toMatchObject({ grubler: 2, mobility: 2 });
    expect(one.value.actuation).toMatchObject({ free: 1, underactuated: true });
    expect(one.value.actuation?.uncontrolled).toContain('right');
    const both = r.mobility({}, { drivers: ['left', 'right'] });
    expect(both.ok && both.value.actuation).toMatchObject({
      free: 0,
      underactuated: false,
      redundantDrivers: 0,
    });
  });

  it('counts the spin of an S-S link as idle, not as underactuation (audit A5)', () => {
    // RSSR: crank about z, a spherical coupler, a rocker about x, a ball closure.
    const crank: Tuple3 = [0.03, 0, 0];
    const ball: Tuple3 = [0.12, 0.06, 0.03];
    const r = rig(model(), {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'crank', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
        { name: 'coupler', parent: 'crank', position: crank, kind: 'spherical' },
        {
          name: 'rocker',
          parent: 'ground',
          position: [0.12, 0.06, 0.08],
          kind: 'revolute',
          axis: 'x',
        },
      ],
      loops: [{ name: 's', a: 'rocker', b: 'coupler', kind: 'ball', at: ball }],
    });
    const m = r.mobility({ crank: 30 }, { drivers: ['crank'] });
    if (!m.ok) throw m.error;
    expect(m.value).toMatchObject({
      mobility: 1,
      idle: 1,
      idleJoints: ['coupler'],
      overconstrained: false,
    });
    expect(m.value.actuation).toMatchObject({ free: 0, underactuated: false, uncontrolled: [] });
    for (const t of [10, 30, 60]) {
      const s = r.solve({ crank: t });
      if (!s.ok) throw s.error;
      expect(s.value.residual).toBeLessThan(1e-9);
      expect(s.value.branchRisk, `crank ${t}`).toBe(false);
    }
    // Held by the other link alone (no driver), the rig is underactuated by its real motion.
    const loose = r.mobility({ crank: 30 }, { drivers: [] });
    expect(loose.ok && loose.value.actuation).toMatchObject({ free: 1, underactuated: true });
  });

  it('reports a solved loop joint that passes its limit (audit A7)', () => {
    const { r: free } = fourBar(0.04, 0.12, 0.08, 0.1, 60);
    const joints = free.joints.map((j) => ({
      name: j.name,
      parent: j.parent,
      position: [j.rest[3], j.rest[7], j.rest[11]] as Tuple3,
      ...(j.kind === 'fixed' ? {} : { kind: j.kind, axis: j.axis }),
      ...(j.name === 'rocker' ? { limits: [-10, 10] as [number, number] } : {}),
    }));
    const B = (fourBar(0.04, 0.12, 0.08, 0.1, 60) as { B: P2 }).B;
    const r = rig(model(), {
      joints,
      loops: [{ name: 'b', a: 'rocker', b: 'coupler', kind: 'pin', at: xyz(B), axis: 'z' }],
    });
    const posed = r.pose({ crank: 90 });
    if (!posed.ok) throw posed.error;
    const rocker = posed.value.joints.find((j) => j.name === 'rocker')?.value as number;
    expect(Math.abs(rocker)).toBeGreaterThan(10);
    expect(posed.value.clamped).toEqual([
      { joint: 'rocker', requested: rocker, applied: rocker > 0 ? 10 : -10, solved: true },
    ]);
    expect(r.pose({ crank: 90 }, { limits: 'reject' }).ok).toBe(false);
  });

  it('rejects malformed loops and fails a pose the loop cannot reach', () => {
    const joints = fourBar(0.04, 0.12, 0.08, 0.1, 60).r.joints.map((j) => ({
      name: j.name,
      parent: j.parent,
      position: [j.rest[3], j.rest[7], j.rest[11]] as Tuple3,
      ...(j.kind === 'fixed' ? {} : { kind: j.kind, axis: j.axis }),
    }));
    const bad = (loop: object) => rig(model(), { joints, loops: [loop as never] }).pose({}).ok;
    expect(
      bad({ name: 'b', a: 'rocker', b: 'rocker', kind: 'pin', at: [0, 0, 0], axis: 'z' }),
    ).toBe(false);
    expect(bad({ name: 'b', a: 'rocker', b: 'coupler', kind: 'pin', at: [0, 0, 0] })).toBe(false);
    expect(bad({ name: 'b', a: 'rocker', b: 'nope', kind: 'ball', at: [0, 0, 0] })).toBe(false);
    expect(bad({ name: 'B', a: 'rocker', b: 'coupler', kind: 'ball', at: [0, 0, 0] })).toBe(false);
    // A crank-rocker: this crank reaches every angle, but a slider-crank rod cannot stretch.
    const a = 0.05;
    const r = rig(model(), {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'crank', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
        { name: 'rod', parent: 'crank', position: [a, 0, 0], kind: 'revolute', axis: 'z' },
        {
          name: 'slider',
          parent: 'ground',
          position: [0.15, 0, 0],
          kind: 'prismatic',
          axis: 'x',
          limits: [-1, 1],
        },
      ],
      loops: [{ name: 'g', a: 'slider', b: 'rod', kind: 'pin', at: [0.15, 0, 0], axis: 'z' }],
    });
    const out = r.pose({ slider: 0.2 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('model-solver-diverged');
  });
});
