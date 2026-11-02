import { describe, expect, it } from 'vitest';
import { meshVolume, type Tuple3 } from '../geom';
import { massProperties } from '../mass';
import { model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

const close = (a: number, b: number, rel = 1e-3) => Math.abs(a - b) <= rel * Math.abs(b);

describe('massProperties', () => {
  it('weighs an off-centre box exactly', () => {
    const m = model();
    m.box({ size: [0.2, 0.1, 0.4], center: [1, 2, 3] });
    const p = massProperties(m, { density: 1000 });
    if (!p.ok) throw p.error;
    const mass = 0.2 * 0.1 * 0.4 * 1000;
    expect(p.value.mass).toBeCloseTo(mass, 9);
    expect(p.value.centroid.map((v) => +v.toFixed(9))).toEqual([1, 2, 3]);
    const [ixx, iyy, izz] = [0, 1, 2].map((k) => p.value.inertia[k]?.[k] as number);
    expect(ixx).toBeCloseTo((mass * (0.1 ** 2 + 0.4 ** 2)) / 12, 9);
    expect(iyy).toBeCloseTo((mass * (0.2 ** 2 + 0.4 ** 2)) / 12, 9);
    expect(izz).toBeCloseTo((mass * (0.2 ** 2 + 0.1 ** 2)) / 12, 9);
    expect(Math.abs(p.value.inertia[0]?.[1] as number)).toBeLessThan(1e-12);
  });

  it('weighs a 256-sided cylinder within 0.1 % of the round one', () => {
    const m = model();
    const r = 0.05;
    const h = 0.3;
    m.cylinder({ radiusTop: r, radiusBottom: r, height: h, radialSegments: 256 });
    const p = massProperties(m, { density: 7850 });
    if (!p.ok) throw p.error;
    const mass = Math.PI * r * r * h * 7850;
    expect(close(p.value.mass, mass)).toBe(true);
    // Axis along +y.
    expect(close(p.value.inertia[1]?.[1] as number, (mass * r * r) / 2)).toBe(true);
    expect(close(p.value.inertia[0]?.[0] as number, (mass * (3 * r * r + h * h)) / 12)).toBe(true);
    expect(close(p.value.inertia[2]?.[2] as number, (mass * (3 * r * r + h * h)) / 12)).toBe(true);
  });

  it('refuses an open shell and a bad density', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(massProperties(m, { density: 0 }).ok).toBe(false);
    m.delete(sel.facing('+y'));
    const open = massProperties(m, { density: 1000, faces: sel.facing('+x') });
    expect(open.ok).toBe(false);
  });
});

describe('massProperties shells', () => {
  it('refuses an inside-out shell (audit A4)', () => {
    const m = model();
    m.box({ size: [1, 1, 1], center: [0, 0, 0], label: 'a' });
    m.box({ size: [1, 1, 1], center: [3, 0, 0], label: 'b' });
    m.flip(sel.createdBy('b'));
    const p = massProperties(m, { density: 1000 });
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error.code).toBe('model-precondition');
    expect(p.error.detail).toEqual({
      shells: [{ shell: 1, volume: expect.any(Number), faces: 6 }],
    });
    const shells = (p.error.detail as { shells: { volume: number }[] }).shells;
    expect(shells[0]?.volume).toBeCloseTo(-1, 9);
  });

  it('refuses a flat shell enclosing no volume', () => {
    const m = model();
    m.box({ size: [1, 1, 1], center: [0, 0, 0] });
    m.translate(sel.facing('+y'), [0, -1, 0]);
    const p = massProperties(m, { density: 1000 });
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error.code).toBe('model-precondition');
  });

  it('adds disjoint shells and counts overlapping ones twice', () => {
    const m = model();
    m.box({ size: [1, 1, 1], center: [0, 0, 0] });
    m.box({ size: [1, 1, 1], center: [3, 0, 0] });
    const p = massProperties(m, { density: 1 });
    if (!p.ok) throw p.error;
    expect(p.value.volume).toBeCloseTo(2, 12);
    expect(p.value.shells).toBe(2);
    expect(p.value.centroid[0]).toBeCloseTo(1.5, 12);
    const o = model();
    o.box({ size: [1, 1, 1], center: [0, 0, 0] });
    o.box({ size: [1, 1, 1], center: [0.5, 0, 0] });
    const q = massProperties(o, { density: 1 });
    if (!q.ok) throw q.error;
    expect(q.value.shells).toBe(2);
    expect(q.value.volume).toBeCloseTo(2, 12);
  });

  it('subtracts an enclosed cavity and still refuses an unenclosed inside-out shell', () => {
    // A hollow block: the sealed void faces inward (as a boolean difference leaves it).
    const m = model();
    m.box({ size: [1, 1, 1], label: 'outer' });
    m.box({ size: [0.5, 0.5, 0.5], label: 'void' });
    m.flip(sel.createdBy('void'));
    const hollow = massProperties(m, { density: 1000 });
    if (!hollow.ok) throw hollow.error;
    expect(hollow.value.volume).toBeCloseTo(1 - 0.125, 9);
    expect(hollow.value.shells).toBe(2);
    // The same inward shell moved outside the block encloses nothing: inside out.
    m.translate(sel.createdBy('void'), [3, 0, 0]);
    const loose = massProperties(m, { density: 1000 });
    expect(!loose.ok && loose.error.code).toBe('model-precondition');
  });
});

describe('massProperties far from the origin (review C-5)', () => {
  const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
  const weigh = (size: number, o: number, hollow = false) => {
    const m = model();
    m.box({ size: [size, size, size], center: [o, o, o], label: 'outer' });
    if (hollow) {
      m.box({ size: [size / 2, size / 2, size / 2], center: [o, o, o], label: 'void' });
      m.flip(sel.createdBy('void'));
    }
    const p = massProperties(m, { density: 1 });
    if (!p.ok) throw p.error;
    return { p: p.value, volume: meshVolume(m.editMesh), validated: m.validate().volume };
  };

  for (const [size, tolerance] of [
    [1, 1e-9],
    [0.01, 1e-6],
  ] as const) {
    it(`gives a ${size} m cube the same volume and inertia at 0, 10, 100, 1000 and 1e4 m`, () => {
      const at0 = weigh(size, 0);
      const expected = (size ** 5 * 2) / 12;
      expect(rel(at0.p.inertia[0][0], expected)).toBeLessThan(1e-12);
      for (const o of [10, 100, 1000, 1e4]) {
        const far = weigh(size, o);
        expect(rel(far.p.volume, at0.p.volume), `volume at ${o}`).toBeLessThan(tolerance);
        expect(rel(far.volume, at0.volume), `meshVolume at ${o}`).toBeLessThan(tolerance);
        expect(rel(far.validated, at0.validated), `validate().volume at ${o}`).toBeLessThan(
          tolerance,
        );
        for (const k of [0, 1, 2]) {
          expect(rel(far.p.centroid[k] as number, o), `centroid at ${o}`).toBeLessThan(1e-12);
          for (const j of [0, 1, 2]) {
            const a = far.p.inertia[k]?.[j] as number;
            const b = at0.p.inertia[k]?.[j] as number;
            if (k === j) expect(rel(a, b), `I${k}${j} at ${o}`).toBeLessThan(tolerance);
            else expect(Math.abs(a), `I${k}${j} at ${o}`).toBeLessThan(tolerance * expected);
          }
        }
      }
    });
  }

  it('keeps the products of inertia of two disjoint asymmetric boxes at any offset', () => {
    const boxes = [
      { size: [1, 2, 3], at: [0.5, -1, 2] },
      { size: [0.5, 0.5, 1], at: [-1, 1, 0] },
    ] as const;
    const weighPair = (o: number) => {
      const m = model();
      for (const [i, b] of boxes.entries()) {
        m.box({
          size: [...b.size],
          center: [o + b.at[0], o + b.at[1], o + b.at[2]],
          label: `b${i}`,
        });
      }
      const p = massProperties(m, { density: 1 });
      if (!p.ok) throw p.error;
      return p.value;
    };
    // Analytic: each box about its own centre, moved to the common centre of mass.
    const volumes = boxes.map((b) => b.size[0] * b.size[1] * b.size[2]) as [number, number];
    const total = volumes[0] + volumes[1];
    const com = [0, 1, 2].map(
      (k) =>
        (volumes[0] * (boxes[0]?.at[k] as number) + volumes[1] * (boxes[1]?.at[k] as number)) /
        total,
    );
    const analytic = [0, 1, 2].map((r) =>
      [0, 1, 2].map((c) =>
        boxes.reduce((sum, b, i) => {
          const d = [0, 1, 2].map((k) => (b.at[k] as number) - (com[k] as number));
          const own =
            r === c
              ? (volumes[i] as number) *
                ([0, 1, 2]
                  .filter((k) => k !== r)
                  .reduce((a, k) => a + (b.size[k] as number) ** 2, 0) /
                  12)
              : 0;
          const dd = d.reduce((a, x) => a + x * x, 0);
          return (
            sum +
            own +
            (volumes[i] as number) * ((r === c ? dd : 0) - (d[r] as number) * (d[c] as number))
          );
        }, 0),
      ),
    );
    for (const o of [0, 10, 100, 1000, 1e4]) {
      const p = weighPair(o);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          expect(p.inertia[r]?.[c], `I${r}${c} at ${o}`).toBeCloseTo(analytic[r]?.[c] as number, 6);
        }
      }
    }
  });

  it('keeps a far hollow block a cavity, not an inside-out shell', () => {
    const at0 = weigh(0.01, 0, true);
    const far = weigh(0.01, 1e4, true);
    expect(far.p.shells).toBe(2);
    expect(rel(far.p.volume, at0.p.volume)).toBeLessThan(1e-6);
    expect(rel(far.p.inertia[1][1], at0.p.inertia[1][1])).toBeLessThan(1e-6);
  });
});

describe('rig.actuation', () => {
  /** A 1 m arm of 0.04 x 0.04 m steel on a hinge about z at the origin. */
  function arm() {
    const m = model();
    m.box({ size: [1, 0.04, 0.04], center: [0.5, 0, 0], label: 'arm' });
    m.box({ size: [0.1, 0.1, 0.1], center: [0, -0.2, 0], label: 'base' });
    const r = rig(m, {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        { name: 'shoulder', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
      ],
    });
    r.bindRigid(sel.createdBy('base'), 'ground', { part: 'base' });
    r.bindRigid(sel.createdBy('arm'), 'shoulder', { part: 'arm' });
    return r;
  }

  it('holds an arm with m g L/2 cos(theta)', () => {
    const r = arm();
    const mass = 1 * 0.04 * 0.04 * 7850;
    for (const theta of [0, 30, 60, 90]) {
      const a = r.actuation({ shoulder: theta });
      if (!a.ok) throw a.error;
      const e = a.value.joints.find((j) => j.joint === 'shoulder')?.effort as number;
      // Turning up (+z) lifts the arm: the holding torque is +m g L/2 cos(theta).
      const expected = mass * 9.81 * 0.5 * Math.cos((theta * Math.PI) / 180);
      expect(Math.abs(e - expected)).toBeLessThan(1e-3 * mass * 9.81 * 0.5 + 1e-6);
    }
    const a = r.actuation({}, { ratings: { shoulder: 10 } });
    expect(a.ok && a.value.exceeded).toEqual(['shoulder']);
    expect(a.ok && a.value.mass).toBeCloseTo(mass + 0.1 ** 3 * 7850, 6);
  });

  it('reports a cylinder near its dead centre above its rating', () => {
    // The arm above is pushed by a cylinder from P to a point 0.3 m along it; the cylinder's
    // line passes the hinge (dead centre) when the arm points at P.
    const build = (deg: number) => {
      const m = model();
      m.box({ size: [1, 0.04, 0.04], center: [0.5, 0, 0], label: 'arm' });
      m.box({ size: [0.1, 0.1, 0.1], center: [0, -0.2, 0], label: 'base' });
      const P: Tuple3 = [
        0.8 * Math.cos((deg * Math.PI) / 180),
        0.8 * Math.sin((deg * Math.PI) / 180),
        0,
      ];
      const K: Tuple3 = [0.3, 0, 0];
      const l = Math.hypot(K[0] - P[0], K[1] - P[1]);
      const r = rig(m, {
        joints: [
          { name: 'ground', parent: null, position: [0, 0, 0] },
          { name: 'shoulder', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
          { name: 'barrel', parent: 'ground', position: P, kind: 'revolute', axis: 'z' },
          {
            name: 'rod',
            parent: 'barrel',
            position: P,
            kind: 'prismatic',
            axis: [(K[0] - P[0]) / l, (K[1] - P[1]) / l, 0],
          },
        ],
        loops: [{ name: 'eye', a: 'shoulder', b: 'rod', kind: 'pin', at: K, axis: 'z' }],
      });
      r.bindRigid(sel.createdBy('base'), 'ground', { part: 'base' });
      r.bindRigid(sel.createdBy('arm'), 'shoulder', { part: 'arm' });
      return r;
    };
    const force = (deg: number) => {
      const a = build(deg).actuation({ rod: 0 }, { ratings: { rod: 1000 } });
      if (!a.ok) throw a.error;
      return a.value.joints.find((j) => j.joint === 'rod') as { effort: number; exceeded: boolean };
    };
    // At 60 degrees the lever is good; at 5 degrees the cylinder nearly points through the hinge.
    const good = force(60);
    const dead = force(5);
    expect(good.exceeded).toBe(false);
    expect(dead.exceeded).toBe(true);
    expect(Math.abs(dead.effort)).toBeGreaterThan(5 * Math.abs(good.effort));
  });
});
