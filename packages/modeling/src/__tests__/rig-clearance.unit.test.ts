import { describe, expect, it } from 'vitest';
import {
  CLEARANCE_PRECISION,
  CONTACT_DISTANCE,
  type ScanPair,
  triangleDistance,
} from '../interference';
import { pointTriangleDistance, triangleContact } from '../intersect';
import { model } from '../model';
import { type Rig, rig } from '../rig';
import { sel } from '../selectors';

type P = readonly [number, number, number];

/**
 * A 10 mm wide, 4 mm thick plate slides 2 m along x over a fixed plate of the same size,
 * crossing it between u = 0.5 and 0.55 with `gap` between their faces: they are within
 * the 5 mm threshold for 1 % of the path, less than one 0.05 sample step.
 */
function pass(gap: number): Rig {
  const m = model();
  m.box({ size: [0.01, 0.004, 0.2], center: [0.1, 0, 0], label: 'fixed' });
  m.box({ size: [0.01, 0.004, 0.2], center: [0, 0.004 + gap, 0], label: 'slider' });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'slide', parent: 'root', position: [0, 0, 0], kind: 'prismatic', axis: 'x' },
    ],
  });
  r.bindRigid(sel.all(), 'root', { part: 'fixed' });
  r.bindRigid(sel.createdBy('slider'), 'slide', { part: 'slider' });
  return r;
}

const PASS = {
  keys: [
    { u: 0, pose: { slide: -1 } },
    { u: 1, pose: { slide: 1 } },
  ],
};

/**
 * An arm on a hinge about z sweeps its tip corner on a circle of radius R; a block's face
 * stands `gap` beyond that circle at angle 0, which the arm passes at u = 0.5.
 */
function swing(gap: number): { r: Rig; radius: number } {
  const m = model();
  const length = 0.3;
  const width = 0.04;
  const radius = Math.hypot(length, width / 2);
  m.box({ size: [length, width, 0.02], center: [length / 2, 0, 0], label: 'arm' });
  m.box({ size: [0.05, 0.2, 0.2], center: [radius + gap + 0.025, 0, 0], label: 'block' });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'hinge', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
    ],
  });
  r.bindRigid(sel.all(), 'root', { part: 'block' });
  r.bindRigid(sel.createdBy('arm'), 'hinge', { part: 'arm' });
  return { r, radius };
}

const SWING = {
  keys: [
    { u: 0, pose: { hinge: -60 } },
    { u: 1, pose: { hinge: 60 } },
  ],
};

function only(pairs: readonly ScanPair[]): ScanPair {
  expect(pairs).toHaveLength(1);
  return pairs[0] as ScanPair;
}

describe('rig: DMU clearance scan', () => {
  it('reports a 4 mm graze as clearance and lets 6 mm pass', () => {
    const near = pass(0.004).scan(PASS, { clearance: 0.005 });
    if (!near.ok) throw near.error;
    const pair = only(near.value.pairs);
    expect(pair).toMatchObject({ parts: ['fixed', 'slider'], status: 'clearance', maxDepth: 0 });
    expect(Math.abs((pair.minDistance as number) - 0.004)).toBeLessThanOrEqual(1e-4);
    expect(pair.minDistanceAt).toBeGreaterThan(0.5);
    expect(pair.minDistanceAt).toBeLessThan(0.55);
    expect(near.value.pass).toBe(true);
    expect(near.value.clearance).toBe(0.005);
    const far = pass(0.006).scan(PASS, { clearance: 0.005 });
    if (!far.ok) throw far.error;
    expect(far.value.pairs).toEqual([]);
  });

  it('subdivides where a thin plate approaches for less than one sample step', () => {
    // 25 cm travel steps alone step over the 1 cm plates: only the clearance bound finds the pass.
    const coarse = { clearance: 0.005, step: 0.1, maxTravel: 0.25 };
    const near = pass(0.004).scan(PASS, coarse);
    if (!near.ok) throw near.error;
    expect(near.value.samples.every((s) => s.clearances === 0)).toBe(true);
    const pair = only(near.value.pairs);
    expect(pair.status).toBe('clearance');
    expect(Math.abs((pair.minDistance as number) - 0.004)).toBeLessThanOrEqual(1e-4);
    expect(pair.firstContact).toBeGreaterThan(0.5);
    expect(pair.firstContact).toBeLessThanOrEqual(pair.minDistanceAt as number);
    const far = pass(0.006).scan(PASS, coarse);
    if (!far.ok) throw far.error;
    expect(far.value.pairs).toEqual([]);
    // Without the threshold the scan has nothing to look for and spends no extra poses there.
    const plain = pass(0.004).scan(PASS, { step: 0.1, maxTravel: 0.25 });
    if (!plain.ok) throw plain.error;
    expect(plain.value.pairs).toEqual([]);
    expect(plain.value.evaluated).toBeLessThan(near.value.evaluated);
  });

  it('measures the smallest distance of a swept corner within 0.1 mm', () => {
    for (const gap of [0.002, 0.004]) {
      const { r } = swing(gap);
      const scan = r.scan(SWING, { clearance: 0.005, step: 0.25 });
      if (!scan.ok) throw scan.error;
      const pair = only(scan.value.pairs);
      expect(pair.status).toBe('clearance');
      expect(pair.minDistance).toBeGreaterThanOrEqual(gap - 1e-9);
      expect((pair.minDistance as number) - gap).toBeLessThanOrEqual(1e-4);
      // Either tip corner reaches the circle's nearest point, at hinge -/+ atan(w / 2L).
      const peak = (60 - (Math.atan2(0.02, 0.3) * 180) / Math.PI) / 120;
      const u = pair.minDistanceAt as number;
      expect(Math.min(Math.abs(u - peak), Math.abs(u - (1 - peak)))).toBeLessThan(0.005);
    }
    const { r } = swing(0.006);
    const clear = r.scan(SWING, { clearance: 0.005, step: 0.25 });
    expect(clear.ok && clear.value.pairs).toEqual([]);
  });

  it('keeps contact and clash ahead of clearance, with a zero distance', () => {
    const { r } = swing(-0.001);
    const scan = r.scan(SWING, { clearance: 0.005 });
    if (!scan.ok) throw scan.error;
    const pair = only(scan.value.pairs);
    expect(pair.status).toBe('confirmed');
    expect(pair.minDistance).toBe(0);
    // The arm comes within the threshold before it first touches the block.
    const before = r.scan(
      {
        keys: [
          { u: 0, pose: { hinge: -60 } },
          { u: 1, pose: { hinge: -10 } },
        ],
      },
      { clearance: 0.005 },
    );
    if (!before.ok) throw before.error;
    expect(only(before.value.pairs).status).toBe('clearance');
  });

  it("exempts designed contacts; a 'fit' accepts no penetration", () => {
    const { r } = swing(0.002);
    const exempt = r.scan(SWING, {
      clearance: 0.005,
      contacts: [{ parts: ['arm', 'block'], kind: 'fit' }],
    });
    expect(exempt.ok && exempt.value.pairs).toEqual([]);
    const pressed = swing(-0.0005).r;
    const peak = { hinge: (-Math.atan2(0.02, 0.3) * 180) / Math.PI };
    const seat = pressed.interference(peak, { contacts: [{ parts: ['arm', 'block'] }] });
    expect(seat.ok && seat.value.pairs[0]?.status).toBe('designed');
    const fit = pressed.interference(peak, {
      contacts: [{ parts: ['arm', 'block'], kind: 'fit' }],
    });
    expect(fit.ok && fit.value.pairs[0]?.status).toBe('confirmed');
  });

  it('confirms thin closed parts slicing through each other whatever the seat (audit A3)', () => {
    for (const t of [0.0002, 0.002]) {
      const m = model();
      m.box({ size: [0.02, t, 0.01], label: 'flat' });
      m.box({ size: [t, 0.02, 0.01], center: [0, 0, 0.002], label: 'upright' });
      const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
      r.bindRigid(sel.createdBy('flat'), 'root', { part: 'flat' });
      r.bindRigid(sel.createdBy('upright'), 'root', { part: 'upright' });
      for (const contacts of [
        [],
        [{ parts: ['flat', 'upright'] as [string, string], tolerance: 0.02 }],
      ]) {
        const hit = r.interference({}, { contacts });
        if (!hit.ok) throw hit.error;
        expect(hit.value.pairs[0]?.status, `t ${t}`).toBe('confirmed');
        // Depth is half the plate there: only the through test sees it when a tolerance covers it.
        if (contacts.length > 0 || t < 0.001) expect(hit.value.pairs[0]?.reason).toBe('through');
      }
    }
    // A post sunk 5 mm into a plate is a seat, not a through-crossing.
    const m = model();
    m.box({ size: [0.1, 0.02, 0.1], center: [0, -0.01, 0], label: 'plate' });
    m.cylinder({
      radiusTop: 0.01,
      radiusBottom: 0.01,
      height: 0.05,
      radialSegments: 16,
      center: [0, 0.02, 0],
      label: 'post',
    });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.createdBy('plate'), 'root', { part: 'plate' });
    r.bindRigid(sel.createdBy('post'), 'root', { part: 'post' });
    const seat = r.interference({}, { contacts: [{ parts: ['plate', 'post'], tolerance: 0.006 }] });
    expect(seat.ok && seat.value.pairs[0]?.status).toBe('designed');
  });

  it('classes flush faces a rounding apart as contact, not clearance (audit A4)', () => {
    const m = model();
    m.box({ size: [0.1, 0.02, 0.1], center: [-0.05, 0, 0], label: 'left' });
    m.box({ size: [0.1, 0.02, 0.1], center: [0.05 + 1e-12, 0, 0], label: 'right' });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.createdBy('left'), 'root', { part: 'left' });
    r.bindRigid(sel.createdBy('right'), 'root', { part: 'right' });
    // The exact predicates see the faces 1e-12 apart: no contact at the pose.
    const exact = r.interference();
    expect(exact.ok && exact.value.pairs).toEqual([]);
    const scan = r.scan({ keys: [{ u: 0, pose: {} }] }, { clearance: 0.005 });
    if (!scan.ok) throw scan.error;
    expect(scan.value.pairs[0]).toMatchObject({ status: 'candidate' });
    expect(scan.value.pairs[0]?.minDistance).toBeLessThanOrEqual(CONTACT_DISTANCE);
  });

  it('validates the threshold and fit declarations', () => {
    const { r } = swing(0.004);
    expect(r.scan(SWING, { clearance: 0 }).ok).toBe(false);
    expect(r.scan(SWING, { clearance: Number.NaN }).ok).toBe(false);
    const tolerant = r.interference(
      {},
      { contacts: [{ parts: ['arm', 'block'], kind: 'fit', tolerance: 0.001 }] },
    );
    expect(tolerant.ok).toBe(false);
    if (!tolerant.ok) expect(tolerant.error.hint).toContain("kind: 'seat'");
    const unknown = r.interference(
      {},
      { contacts: [{ parts: ['arm', 'block'], kind: 'press' as 'fit' }] },
    );
    expect(unknown.ok).toBe(false);
    expect(CLEARANCE_PRECISION).toBe(1e-4);
  });
});

describe('triangle distance', () => {
  /** Distance between segments by nested ternary search (the squared distance is convex). */
  function segments(p: P, q: P, r: P, s: P): number {
    const at = (a: P, b: P, t: number): P => [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
    const ternary = (f: (t: number) => number) => {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        if (f(m1) <= f(m2)) hi = m2;
        else lo = m1;
      }
      return f((lo + hi) / 2);
    };
    return ternary((t) => {
      const x = at(p, q, t);
      return ternary((u) => {
        const y = at(r, s, u);
        return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
      });
    });
  }

  it('matches vertex-triangle and edge-edge distances of disjoint triangles', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const tri = (offset: number): P[] =>
      [0, 1, 2].map(() => [random() + offset, random(), random()] as P);
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const t1 = tri(0);
      const t2 = tri(0.2 + random());
      if (triangleContact(t1, t2) !== 'none') continue;
      let expected = Infinity;
      for (const p of t1) expected = Math.min(expected, pointTriangleDistance(p, t2));
      for (const p of t2) expected = Math.min(expected, pointTriangleDistance(p, t1));
      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          expected = Math.min(
            expected,
            segments(t1[a] as P, t1[(a + 1) % 3] as P, t2[b] as P, t2[(b + 1) % 3] as P),
          );
        }
      }
      expect(Math.abs(triangleDistance(t1, t2, true) - expected)).toBeLessThan(1e-9);
      expect(triangleDistance(t1, t2)).toBe(triangleDistance(t1, t2, true));
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });
});
