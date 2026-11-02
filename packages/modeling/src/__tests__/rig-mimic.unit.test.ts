import { describe, expect, it } from 'vitest';
import { applyPoint, invertRigid, multiply } from '../affine';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type JointSpec, type Pose, type PosePath, type Rig, type RigSpec, rig } from '../rig';
import { sel } from '../selectors';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw r.error as Error;
  return r.value;
};

const root: JointSpec = { name: 'ground', parent: null, position: [0, 0, 0] };
const rev = (name: string, extra: Partial<JointSpec> = {}): JointSpec => ({
  name,
  parent: 'ground',
  position: [0, 0, 0],
  kind: 'revolute',
  axis: 'z',
  ...extra,
});
const poisoned = (joints: readonly JointSpec[], rest: Partial<RigSpec> = {}) =>
  rig(model(), { joints, ...rest }).poisoned;

function placed(r: Rig, pose: Pose, name: string, p: Tuple3): Tuple3 {
  const posed = ok(r.pose(pose));
  const world = posed.joints.find((j) => j.name === name)?.world as number[];
  const rest = r.joints.find((j) => j.name === name)?.rest as number[];
  return applyPoint(multiply(world, invertRigid(rest)), p);
}

describe('rig mimic: pose', () => {
  it('a gear pair equals keying both joints by hand, bit for bit', () => {
    const geared = rig(model(), {
      joints: [
        root,
        rev('a'),
        rev('b', { position: [0.1, 0, 0], mimic: { joint: 'a', ratio: -2.5 } }),
      ],
    });
    const manual = rig(model(), {
      joints: [root, rev('a'), rev('b', { position: [0.1, 0, 0] })],
    });
    const p = ok(geared.pose({ a: 20 }));
    expect(p.joints[2]?.value).toBe(-50);
    expect(p.joints).toEqual(ok(manual.pose({ a: 20, b: -50 })).joints);
  });

  it('couples a revolute leader to a prismatic follower (rack and pinion)', () => {
    const r = 0.02;
    const ratio = (r * Math.PI) / 180;
    const rack = rig(model(), {
      joints: [
        root,
        rev('pinion'),
        {
          name: 'rack',
          parent: 'ground',
          position: [0, 0, 0],
          kind: 'prismatic',
          axis: 'x',
          mimic: { joint: 'pinion', ratio, offset: 0 },
        },
      ],
    });
    const p = ok(rack.pose({ pinion: 123 }));
    expect(Math.abs((p.joints[2]?.value as number) - ratio * 123)).toBeLessThan(1e-12);
  });

  it('applies the offset', () => {
    const r = rig(model(), {
      joints: [root, rev('a'), rev('b', { mimic: { joint: 'a', ratio: 2, offset: 7 } })],
    });
    expect(ok(r.pose({})).joints[2]?.value).toBe(7);
    expect(ok(r.pose({ a: 10 })).joints[2]?.value).toBe(27);
  });
});

/** Two jaws sliding along x with a centre object; the right jaw mirrors the left. */
function gripper(coupled: boolean, axis: 'x' | 'y' = 'x') {
  const m = model();
  m.box({ size: [0.04, 0.04, 0.04], center: [0, 0, 0], label: 'object' });
  m.box({ size: [0.01, 0.04, 0.04], center: [-0.0225, 0, 0], label: 'jl' });
  m.box({ size: [0.01, 0.04, 0.04], center: [0.0225, 0, 0], label: 'jr' });
  const r = rig(m, {
    joints: [
      root,
      {
        name: 'jaw-l',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'prismatic',
        axis,
        limits: [0, 0.02],
      },
      {
        name: 'jaw-r',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'prismatic',
        axis,
        limits: [-0.02, 0],
        ...(coupled ? { mimic: { joint: 'jaw-l', ratio: -1 } } : {}),
      },
    ],
  });
  r.bindRigid(sel.createdBy('object'), 'ground', { part: 'object' });
  r.bindRigid(sel.createdBy('jl'), 'jaw-l', { part: 'jl' });
  r.bindRigid(sel.createdBy('jr'), 'jaw-r', { part: 'jr' });
  return r;
}

describe('rig mimic: mirrored jaws', () => {
  it('reflects across the symmetry plane and overlaps the object equally', () => {
    const g = gripper(true);
    const closed = { 'jaw-l': 0.005 };
    const l = placed(g, closed, 'jaw-l', [-0.0225, 0.01, 0.01]);
    const rr = placed(g, closed, 'jaw-r', [0.0225, 0.01, 0.01]);
    expect(Math.abs(l[0] + rr[0])).toBeLessThan(1e-12);
    expect(Math.abs(l[1] - rr[1]) + Math.abs(l[2] - rr[2])).toBeLessThan(1e-12);
    const pairs = ok(g.interference(closed, { tolerance: 0 })).pairs;
    const find = (a: string) =>
      pairs.find((p) => p.parts.includes(a) && p.parts.includes('object'));
    const [pl, pr] = [find('jl'), find('jr')];
    expect(pl).toBeDefined();
    expect(pr?.triangles).toBe(pl?.triangles);
    expect(pr?.depth).toBe(pl?.depth);
    expect(Math.abs((pl?.at[0] as number) + (pr?.at[0] as number))).toBeLessThan(1e-12);
  });

  it('drops one coordinate per follower from mobility', () => {
    const free = ok(gripper(false).mobility());
    const coupled = ok(gripper(true).mobility());
    expect(free.coordinates).toBe(2);
    expect(coupled.coordinates).toBe(1);
    expect(coupled.grubler).toBe(1);
  });

  it('builds byte-identical posed meshes twice', () => {
    const a = JSON.stringify(ok(gripper(true).pose({ 'jaw-l': 0.01 })));
    const b = JSON.stringify(ok(gripper(true).pose({ 'jaw-l': 0.01 })));
    expect(a).toBe(b);
  });
});

describe('rig mimic: limits', () => {
  it('narrows the leader by the follower range and names the leader in a clamp', () => {
    const r = rig(model(), {
      joints: [
        root,
        rev('a', { limits: [0, 40] }),
        rev('b', { limits: [-30, 0], mimic: { joint: 'a', ratio: -1 } }),
      ],
    });
    const held = ok(r.pose({ a: 40 }));
    expect(held.clamped).toEqual([{ joint: 'a', requested: 40, applied: 30 }]);
    expect(held.joints[2]?.value).toBe(-30);
    expect(r.pose({ a: 40 }, { limits: 'reject' }).ok).toBe(false);
    expect(r.pose({ a: 30 }, { limits: 'reject' }).ok).toBe(true);
  });

  it('combines a three-joint chain with mixed signs back to the root leader', () => {
    const r = rig(model(), {
      joints: [
        root,
        rev('a', { limits: [-100, 100] }),
        rev('b', { limits: [-40, 60], mimic: { joint: 'a', ratio: -2 } }),
        rev('c', { limits: [-5, 10], mimic: { joint: 'b', ratio: 0.5 } }),
      ],
    });
    const hi = ok(r.pose({ a: 100 }));
    expect(hi.clamped).toEqual([{ joint: 'a', requested: 100, applied: 5 }]);
    expect(hi.joints.map((j) => j.value)).toEqual([null, 5, -10, -5]);
    const lo = ok(r.pose({ a: -100 }));
    expect(lo.clamped).toEqual([{ joint: 'a', requested: -100, applied: -10 }]);
    expect(lo.joints.map((j) => j.value)).toEqual([null, -10, 20, 10]);
  });

  it('fails at compile on an empty intersection, with both ranges in the detail', () => {
    const e = poisoned([
      root,
      rev('a', { limits: [0, 10] }),
      rev('b', { limits: [-30, -20], mimic: { joint: 'a', ratio: -1 } }),
    ]);
    expect(e?.code).toBe('model-invalid-argument');
    expect(e?.detail).toMatchObject({ joint: 'b' });
    expect(JSON.stringify(e?.detail)).toContain('[0,10]');
  });

  it('rejects an effective range that excludes the rest value 0', () => {
    const e = poisoned([
      root,
      rev('a', { limits: [0, 40] }),
      rev('b', { limits: [10, 20], mimic: { joint: 'a', ratio: 1 } }),
    ]);
    expect(e?.code).toBe('model-invalid-argument');
    expect(e?.expected).toContain('0');
    expect(e?.detail).toMatchObject({ joint: 'b' });
  });
});

describe('rig mimic: rejections', () => {
  const two = (b: Partial<JointSpec>, a: Partial<JointSpec> = {}) => [
    root,
    rev('a', a),
    rev('b', b),
  ];
  const code = (e: ReturnType<typeof poisoned>) => [
    e?.code,
    (e?.detail as { joint?: string })?.joint,
  ];

  it('refuses a forward reference, self-mimic and a three-joint cycle', () => {
    expect(code(poisoned([root, rev('a', { mimic: { joint: 'b', ratio: 1 } }), rev('b')]))).toEqual(
      ['model-invalid-argument', 'a'],
    );
    expect(code(poisoned(two({ mimic: { joint: 'b', ratio: 1 } })))).toEqual([
      'model-invalid-argument',
      'b',
    ]);
    const cycle = poisoned([
      root,
      rev('a', { mimic: { joint: 'c', ratio: 1 } }),
      rev('b', { mimic: { joint: 'a', ratio: 1 } }),
      rev('c', { mimic: { joint: 'b', ratio: 1 } }),
    ]);
    expect(cycle?.code).toBe('model-invalid-argument');
    expect(cycle?.detail).toMatchObject({ joint: 'a', mimic: 'c' });
  });

  it('refuses a ratio of 0, NaN or Infinity and a bad offset', () => {
    for (const ratio of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(code(poisoned(two({ mimic: { joint: 'a', ratio } })))).toEqual([
        'model-invalid-argument',
        'b',
      ]);
    }
    expect(code(poisoned(two({ mimic: { joint: 'a', ratio: 1, offset: Number.NaN } })))).toEqual([
      'model-invalid-argument',
      'b',
    ]);
  });

  it('refuses spherical and fixed joints on either side', () => {
    const sph = (name: string, extra: Partial<JointSpec> = {}): JointSpec => ({
      name,
      parent: 'ground',
      position: [0, 0, 0],
      kind: 'spherical',
      ...extra,
    });
    const fix = (name: string, extra: Partial<JointSpec> = {}): JointSpec => ({
      name,
      parent: 'ground',
      position: [0, 0, 0],
      ...extra,
    });
    const m = { joint: 'a', ratio: 1 };
    expect(code(poisoned([root, sph('a'), rev('b', { mimic: m })]))).toEqual([
      'model-invalid-argument',
      'b',
    ]);
    expect(code(poisoned([root, fix('a'), rev('b', { mimic: m })]))).toEqual([
      'model-invalid-argument',
      'b',
    ]);
    expect(code(poisoned([root, rev('a'), sph('b', { mimic: m })]))).toEqual([
      'model-invalid-argument',
      'b',
    ]);
    expect(code(poisoned([root, rev('a'), fix('b', { mimic: m })]))).toEqual([
      'model-invalid-argument',
      'b',
    ]);
  });

  it('refuses a follower that is a loop joint', () => {
    const e = poisoned(
      [
        root,
        rev('a'),
        rev('b', { parent: 'a', position: [0.1, 0, 0], mimic: { joint: 'a', ratio: 1 } }),
        rev('c', { position: [0.1, 0.05, 0] }),
      ],
      { loops: [{ name: 'l', a: 'c', b: 'b', kind: 'pin', at: [0.1, 0.05, 0], axis: 'z' }] },
    );
    expect(code(e)).toEqual(['model-invalid-argument', 'b']);
  });

  it('refuses a follower named in a pose, path key, guess or drivers, naming leader and ratio', () => {
    const r = rig(model(), {
      joints: [root, rev('a'), rev('b', { mimic: { joint: 'a', ratio: -2.5 } })],
    });
    expect(r.poisoned).toBeUndefined();
    const failures = [
      r.pose({ b: 5 }),
      r.solve({ b: 5 }),
      r.solve({}, { guess: { b: 5 } }),
      r.mobility({}, { drivers: ['b'] }),
      r.sample(
        {
          keys: [
            { u: 0, pose: { b: 0 } },
            { u: 1, pose: { b: 5 } },
          ],
        },
        0.5,
      ),
    ];
    for (const f of failures) {
      expect(f.ok).toBe(false);
      if (f.ok) continue;
      expect(f.error.code).toBe('model-invalid-argument');
      expect(JSON.stringify(f.error.detail)).toContain('"leader":"a"');
      expect(`${f.error.hint}`).toContain('a');
      expect(`${f.error.hint}`).toContain('-2.5');
    }
    expect(Object.keys(ok(r.solve({ a: 3 })).pose)).toEqual(['a']);
  });
});

describe('rig mimic: loop leader', () => {
  it('follows the solved rocker and reports a passed follower limit as solved', () => {
    const o2: [number, number] = [0, 0];
    const A: [number, number] = [0.04 * Math.cos(Math.PI / 3), 0.04 * Math.sin(Math.PI / 3)];
    const d = 0.1;
    const b = 0.12;
    const c = 0.08;
    const dx = d - A[0];
    const dy = -A[1];
    const L = Math.hypot(dx, dy);
    const a2 = (b * b - c * c + L * L) / (2 * L);
    const h = Math.sqrt(b * b - a2 * a2);
    const Bp: Tuple3 = [
      A[0] + (a2 * dx) / L + (h * dy) / L,
      A[1] + (a2 * dy) / L - (h * dx) / L,
      0,
    ];
    const spec = (limits: [number, number]): RigSpec => ({
      joints: [
        root,
        rev('crank', { position: [o2[0], o2[1], 0] }),
        {
          name: 'coupler',
          parent: 'crank',
          position: [A[0], A[1], 0],
          kind: 'revolute',
          axis: 'z',
        },
        rev('rocker', { position: [d, 0, 0] }),
        rev('pointer', { limits, mimic: { joint: 'rocker', ratio: 3 } }),
      ],
      loops: [{ name: 'b', a: 'rocker', b: 'coupler', kind: 'pin', at: Bp, axis: 'z' }],
    });
    const r = rig(model(), spec([-0.5, 0.5]));
    expect(r.poisoned).toBeUndefined();
    const solved = ok(r.solve({ crank: 70 }));
    expect(solved.solved).toEqual(['coupler', 'rocker']);
    expect(Object.keys(solved.pose)).not.toContain('pointer');
    const posed = ok(r.pose({ crank: 70 }));
    const rocker = posed.joints[3]?.value as number;
    expect(Math.abs(rocker)).toBeGreaterThan(1);
    expect(posed.joints[4]?.value).toBeCloseTo(3 * rocker, 9);
    expect(posed.clamped).toContainEqual({
      joint: 'pointer',
      requested: posed.joints[4]?.value,
      applied: Math.sign(rocker) * 0.5,
      solved: true,
    });
  });
});

/** Gripper stood upright: gravity loads both jaws. */
function lifter(coupled: boolean, stops: boolean) {
  const m = model();
  m.box({ size: [0.1, 0.02, 0.1], center: [0, -0.1, 0], label: 'base' });
  m.box({ size: [0.02, 0.02, 0.02], center: [-0.03, 0, 0], label: 'jl' });
  m.box({ size: [0.04, 0.02, 0.02], center: [0.03, 0, 0], label: 'jr' });
  const r = rig(m, {
    joints: [
      root,
      {
        name: 'jl',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'prismatic',
        axis: 'y',
        limits: [0, 0.02],
      },
      {
        name: 'jr',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'prismatic',
        axis: 'y',
        limits: [0, 0.01],
        ...(stops ? { stops: { min: { stop: 'base' } } } : {}),
        ...(coupled ? { mimic: { joint: 'jl', ratio: 1 } } : {}),
      },
    ],
  });
  r.bindRigid(sel.createdBy('base'), 'ground', { part: 'base' });
  r.bindRigid(sel.createdBy('jl'), 'jl', { part: 'jl' });
  r.bindRigid(sel.createdBy('jr'), 'jr', { part: 'jr' });
  return r;
}

describe('rig mimic: actuation', () => {
  it('puts the follower load on the leader by virtual work', () => {
    const free = ok(lifter(false, false).actuation({ jl: 0.003, jr: 0.003 }));
    const geared = ok(lifter(true, false).actuation({ jl: 0.003 }));
    expect(geared.joints.map((j) => j.joint)).toEqual(['jl']);
    const expected = (free.joints[0]?.effort as number) + (free.joints[1]?.effort as number);
    expect(Math.abs((geared.joints[0]?.effort as number) - expected)).toBeLessThan(
      1e-6 * Math.abs(expected),
    );
  });

  it('holds the leader on a follower stop at the effective limit', () => {
    const held = ok(lifter(true, true).actuation({ jl: 0 }, { ratings: { jl: 1 } }));
    expect(held.joints[0]?.atStop).toBe('min');
    expect(held.exceeded).toEqual([]);
    const off = ok(lifter(true, true).actuation({ jl: 0.004 }, { ratings: { jl: 1 } }));
    expect(off.joints[0]?.atStop).toBeUndefined();
  });

  it('measures the effort one-sided at the effective upper limit', () => {
    const top = ok(lifter(true, false).actuation({ jl: 0.01 }));
    const inside = ok(lifter(true, false).actuation({ jl: 0.0099 }));
    expect(
      Math.abs((top.joints[0]?.effort as number) - (inside.joints[0]?.effort as number)),
    ).toBeLessThan(1e-3 * Math.abs(inside.joints[0]?.effort as number));
  });
});

/** Jaws closing onto fixed stop blocks. */
function stopped() {
  const m = model();
  m.box({ size: [0.01, 0.04, 0.04], center: [0.025, 0, 0], label: 'jaw' });
  m.box({ size: [0.01, 0.04, 0.04], center: [0.045, 0, 0], label: 'block' });
  const r = rig(m, {
    joints: [
      root,
      {
        name: 'lead',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'prismatic',
        axis: 'x',
        limits: [0, 0.02],
        stops: { max: { stop: 'block', against: 'jaw' } },
      },
      {
        name: 'follow',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'prismatic',
        axis: 'x',
        limits: [0, 0.01],
        stops: { max: { stop: 'block', against: 'jaw' } },
        mimic: { joint: 'lead', ratio: 2 },
      },
    ],
  });
  r.bindRigid(sel.createdBy('block'), 'ground', { part: 'block' });
  r.bindRigid(sel.createdBy('jaw'), 'follow', { part: 'jaw' });
  return r;
}

describe('rig mimic: stopReport', () => {
  it('lands a follower stop through the leader and reports the unreachable leader end', () => {
    const report = ok(stopped().stopReport());
    const follow = report.checks.find((c) => c.joint === 'follow' && c.end === 'max');
    expect(follow?.finding).toBe('landed');
    expect(follow?.value).toBe(0.01);
    expect(follow?.gap).toBeLessThan(1e-9);
    const lead = report.checks.find((c) => c.joint === 'lead' && c.end === 'max');
    expect(lead?.finding).toBe('unreachable');
    expect(report.pass).toBe(false);
  });
});

describe('rig mimic: sweep', () => {
  it('keeps a high-ratio follower in the travel subdivision', () => {
    const build = (coupled: boolean) => {
      const m = model();
      m.box({ size: [0.2, 0.02, 0.02], center: [0.1, 0, 0], label: 'arm' });
      const r = rig(m, {
        joints: [
          root,
          rev('lead', { axis: 'y' }),
          rev('follow', { axis: 'y', ...(coupled ? { mimic: { joint: 'lead', ratio: 20 } } : {}) }),
        ],
      });
      r.bindRigid(sel.createdBy('arm'), 'follow', { part: 'arm' });
      return r;
    };
    const coupled = ok(
      build(true).sweep(
        {
          keys: [
            { u: 0, pose: { lead: 0 } },
            { u: 1, pose: { lead: 9 } },
          ],
        },
        { voxel: 0.01 },
      ),
    );
    const manual = ok(
      build(false).sweep(
        {
          keys: [
            { u: 0, pose: { lead: 0, follow: 0 } },
            { u: 1, pose: { lead: 9, follow: 180 } },
          ],
        },
        { voxel: 0.01 },
      ),
    );
    expect(coupled.count).toBe(manual.count);
    expect(coupled.count).toBeGreaterThan(2500);
  });
});

describe('rig mimic: motion', () => {
  it('counts a follower as its leader, not as a concurrent action', () => {
    const m = model();
    m.box({ size: [0.2, 0.02, 0.02], center: [0.1, 0, 0], label: 'arm' });
    const r = rig(m, {
      joints: [
        root,
        rev('shoulder', { limits: [0, 90] }),
        rev('elbow', { limits: [-90, 0], mimic: { joint: 'shoulder', ratio: -1 } }),
      ],
    });
    r.bindRigid(sel.createdBy('arm'), 'elbow', { part: 'arm' });
    const path: PosePath = {
      keys: [
        { u: 0, pose: { shoulder: 0 } },
        { u: 1, pose: { shoulder: 60 } },
      ],
    };
    const report = ok(
      r.motionReport(path, { groups: { arm: ['shoulder'], hand: ['elbow'] }, duration: 2 }),
    );
    expect(report.concurrency).toBe(1);
    expect(report.issues.map((i) => i.code)).toEqual([]);
  });

  it('keeps a follower part under its leader phase, not unclaimed', () => {
    const m = model();
    m.box({ size: [0.1, 0.02, 0.02], center: [0.05, 0, 0], label: 'p' });
    m.box({ size: [0.1, 0.02, 0.02], center: [0.05, 0, 0.5], label: 'q' });
    const r = rig(m, {
      joints: [
        root,
        rev('lead', { axis: 'y' }),
        rev('follow', { axis: 'y', position: [0, 0, 0.5], mimic: { joint: 'lead', ratio: 1 } }),
      ],
    });
    r.bindRigid(sel.createdBy('p'), 'lead', { part: 'p' });
    r.bindRigid(sel.createdBy('q'), 'follow', { part: 'q' });
    const path: PosePath = {
      keys: [
        { u: 0, pose: { lead: 0 } },
        { u: 1, pose: { lead: 45 } },
      ],
    };
    const claims = ok(
      r.phaseClaims(path, { voxel: 0.01, phases: [{ id: 'turn', u: [0, 1], joints: ['lead'] }] }),
    );
    expect(claims.claims[0]?.parts.slice().sort()).toEqual(['p', 'q']);
    expect(claims.claims[0]?.unclaimed).toEqual([]);
  });
});
