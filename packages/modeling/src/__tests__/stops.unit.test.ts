import { describe, expect, it } from 'vitest';
import { model } from '../model';
import type { Range } from '../recipes';
import { recipes } from '../recipes';
import { rig } from '../rig';
import { sel } from '../selectors';

const LOCK = { span: 0.2, overCentre: 0.004, width: 0.02, thickness: 0.008 } as const;

/** The lock in a rig: link A turns about +Z at A, link B rides on it. */
function locked(limits: Range = [0, 20], withStop = true) {
  const built = recipes.overCenterLock(LOCK);
  if (!built.ok) throw built.error;
  const { model: m, anchors, contacts } = built.value;
  if (!withStop) m.delete(sel.tag('lock-stop'));
  const r = rig(m, {
    joints: [
      { name: 'ground', parent: null, position: [0, 0, 0] },
      {
        name: 'a',
        parent: 'ground',
        position: anchors.a ?? [0, 0, 0],
        kind: 'revolute',
        axis: 'z',
        limits,
        stops: { min: { stop: 'lock-stop', against: 'lock-a' } },
      },
      { name: 'b', parent: 'a', position: anchors.m ?? [0, 0, 0], kind: 'revolute', axis: 'z' },
    ],
    contacts: contacts ?? [],
  });
  if (withStop) r.bindRigid(sel.tag('lock-stop'), 'ground', { part: 'lock-stop' });
  r.bindRigid(sel.tag('lock-a'), 'a', { part: 'lock-a' });
  r.bindRigid(sel.tag('lock-b'), 'b', { part: 'lock-b' });
  return { r, built: built.value };
}

describe('overCenterLock and stops', () => {
  it('lands the locked toggle on its stop and clears it mid-travel', () => {
    const { r, built } = locked();
    expect(built.dimensions.lockAngle).toBeCloseTo((Math.atan2(0.004, 0.1) * 180) / Math.PI, 9);
    const report = r.stopReport();
    if (!report.ok) throw report.error;
    expect(report.value.checks).toHaveLength(1);
    const check = report.value.checks[0];
    expect(check?.finding).toBe('landed');
    expect(check?.gap).toBeCloseTo(0.0002, 7);
    expect(check?.travelGap).toBeGreaterThan(0.01);
    // The open end (20 degrees) has no stop, so the report as a whole does not pass.
    expect(report.value.unstopped).toEqual(['a/max']);
    expect(report.value.pass).toBe(false);
    // The locked pose itself is clear: the links seat on each other only.
    const at = r.interference({});
    expect(at.ok && at.value.pairs.filter((p) => p.status !== 'designed')).toEqual([]);
  });

  it('fails without the stop part, short of it and touching mid-travel', () => {
    // Falsifier: remove the stop and the end check must fail.
    const bare = locked([0, 20], false).r.stopReport();
    expect(bare.ok && bare.value.checks[0]?.finding).toBe('missing');
    expect(bare.ok && bare.value.pass).toBe(false);
    // The limit stops 5 degrees short of the stop.
    const short = locked([5, 20]).r.stopReport();
    expect(short.ok && short.value.checks[0]?.finding).toBe('open');
    // Travel past the stop: the limit drives link A into it.
    const through = locked([-8, 0.5]).r.stopReport();
    expect(through.ok && through.value.checks[0]?.finding).toBe('through');
  });

  it('refuses a toggle at or before its centre line and malformed stops', () => {
    // Falsifier: a lock that is not past centre (delta <= 0) is reported.
    for (const overCentre of [0, -0.004]) {
      const toggle = recipes.overCenterLock({ ...LOCK, overCentre });
      expect(!toggle.ok && toggle.error.message).toContain('overCentre > 0');
    }
    const built = recipes.overCenterLock(LOCK);
    if (!built.ok) throw built.error;
    const unlimited = rig(built.value.model, {
      joints: [
        { name: 'ground', parent: null, position: [0, 0, 0] },
        {
          name: 'a',
          parent: 'ground',
          position: [0, 0, 0],
          kind: 'revolute',
          axis: 'z',
          stops: { min: { stop: 'lock-stop' } },
        },
      ],
    });
    expect(unlimited.poisoned?.code).toBe('model-invalid-argument');
  });

  it('fails a stop the end runs into and limits without stops', () => {
    // A bar on a hinge, limits [0, 90]; a 6 cm stop block at its 90-degree end.
    const bar = (stopCenter: [number, number, number], declared = true) => {
      const m = model();
      m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: 'bar' });
      m.box({ size: [0.06, 0.06, 0.06], center: stopCenter, label: 'stop' });
      const r = rig(m, {
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          {
            name: 'hinge',
            parent: 'root',
            position: [0, 0, 0],
            kind: 'revolute',
            axis: 'y',
            limits: [0, 90],
            ...(declared ? { stops: { max: { stop: 'stop', against: 'bar' } } } : {}),
          },
        ],
      });
      r.bindRigid(sel.createdBy('bar'), 'hinge', { part: 'bar' });
      r.bindRigid(sel.createdBy('stop'), 'root', { part: 'stop' });
      return r.stopReport();
    };
    // Beside the bar at 90 degrees: it lands. Centred on its path: it is 20 mm inside the stop.
    const beside = bar([-0.05, 0, -0.2]);
    expect(beside.ok && beside.value.checks[0]?.finding).toBe('landed');
    const inside = bar([0, 0, -0.2]);
    if (!inside.ok) throw inside.error;
    expect(inside.value.checks[0]?.finding).toBe('through');
    expect(inside.value.checks[0]?.depth).toBeGreaterThan(0.015);
    expect(inside.value.pass).toBe(false);
    // Falsifier: without the stops declaration the limits are unstopped, so the report fails.
    const undeclared = bar([-0.05, 0, -0.2], false);
    if (!undeclared.ok) throw undeclared.error;
    expect(undeclared.value.checks).toEqual([]);
    expect(undeclared.value.unstopped).toEqual(['hinge/min', 'hinge/max']);
    expect(undeclared.value.pass).toBe(false);
  });

  it('holds a compressive load on its stop and opens under a reversed one', () => {
    const built = recipes.overCenterLock(LOCK);
    if (!built.ok) throw built.error;
    const { a, m, b } = built.value.anchors as Record<'a' | 'm' | 'b', [number, number, number]>;
    // Torque about A (z) of a load at M along link B: compression pushes from B toward M.
    const torque = (sign: number) => {
      const l = Math.hypot(m[0] - b[0], m[1] - b[1]);
      const f = [((m[0] - b[0]) / l) * sign, ((m[1] - b[1]) / l) * sign];
      return (m[0] - a[0]) * (f[1] as number) - (m[1] - a[1]) * (f[0] as number);
    };
    // Unlocking turns link A +z off its stop: compression turns it -z, onto the stop (locks),
    // tension +z, back over the centre line (the lock needs a latch or spring for it).
    expect(torque(1)).toBeLessThan(0);
    expect(torque(-1)).toBeGreaterThan(0);
  });

  it('lets a landed stop carry the effort at a limit, measured one-sided', () => {
    // The arm resting on a stop at 0 degrees: gravity pushes it into the stop.
    const build = (stopped: boolean) => {
      const m = model();
      m.box({ size: [1, 0.04, 0.04], center: [0.5, 0, 0], label: 'arm' });
      m.box({ size: [0.1, 0.1, 0.1], center: [0, -0.2, 0], label: 'base' });
      const r = rig(m, {
        joints: [
          { name: 'ground', parent: null, position: [0, 0, 0] },
          {
            name: 'shoulder',
            parent: 'ground',
            position: [0, 0, 0],
            kind: 'revolute',
            axis: 'z',
            limits: [0, 90],
            ...(stopped ? { stops: { min: { stop: 'base' } } } : {}),
          },
        ],
      });
      r.bindRigid(sel.createdBy('base'), 'ground', { part: 'base' });
      r.bindRigid(sel.createdBy('arm'), 'shoulder', { part: 'arm' });
      return r;
    };
    const mass = 1 * 0.04 * 0.04 * 7850;
    const full = mass * 9.81 * 0.5;
    const free = build(false).actuation({ shoulder: 0 }, { ratings: { shoulder: 10 } });
    if (!free.ok) throw free.error;
    // At the limit the difference is one-sided, not halved.
    expect(Math.abs((free.value.joints[0]?.effort as number) - full)).toBeLessThan(1e-3 * full);
    expect(free.value.exceeded).toEqual(['shoulder']);
    const resting = build(true).actuation({ shoulder: 0 }, { ratings: { shoulder: 10 } });
    if (!resting.ok) throw resting.error;
    expect(resting.value.joints[0]?.atStop).toBe('min');
    expect(resting.value.exceeded).toEqual([]);
    // Lifted off the stop, the actuator holds it again.
    const lifted = build(true).actuation({ shoulder: 30 }, { ratings: { shoulder: 10 } });
    expect(lifted.ok && lifted.value.exceeded).toEqual(['shoulder']);
  });
});
