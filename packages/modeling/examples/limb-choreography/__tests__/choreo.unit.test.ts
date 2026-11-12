import { describe, expect, it } from 'vitest';
import { LIMB_CONTACTS, limbPath } from '../../transforming-limb/limb';
import { choreographLimb, choreoRig, DURATION, GROUPS } from '../choreo';

const r = choreoRig();

describe('C-118 choreographed limb', () => {
  it('refuses the first design: the fender dips below closed', () => {
    const first = choreographLimb(r, 'first');
    expect(first.ok).toBe(false);
    if (first.ok) return;
    const beyond = (first.error.detail as { beyond: { joint: string; phase: string; value: number }[] }).beyond;
    expect(new Set(beyond.map((b) => `${b.joint}/${b.phase}`))).toEqual(new Set(['fender-hinge/fender-open']));
    expect(Math.min(...beyond.map((b) => b.value))).toBeLessThan(-1);
  });

  it('catches the second design: the shoulder dip is within its limit but hits the chassis', { timeout: 300000 }, () => {
    const second = choreographLimb(r, 'second');
    if (!second.ok) throw second.error;
    const scan = r.scan(second.value.path, { contacts: LIMB_CONTACTS });
    if (!scan.ok) throw scan.error;
    expect(scan.value.clamped).toEqual([]);
    expect(scan.value.pairs.map((p) => [p.parts, p.status])).toEqual([[['chassis', 'upper-arm'], 'confirmed']]);
    // The dip is at the start of the shoulder's window (2.7 s of 8.4).
    expect(scan.value.pairs[0]?.firstContact).toBeGreaterThan(2.7 / DURATION);
    expect(scan.value.pairs[0]?.firstContact).toBeLessThan(3.0 / DURATION);
  });

  it('reads one action at a time, clear of contacts, where the hand keys overlapped', { timeout: 300000 }, () => {
    const c = choreographLimb(r);
    if (!c.ok) throw c.error;
    expect(c.value.clamped).toEqual([]);
    const scan = r.scan(c.value.path, { contacts: LIMB_CONTACTS });
    if (!scan.ok) throw scan.error;
    expect(scan.value.pairs).toEqual([]);
    const motion = r.motionReport(c.value.path, { groups: GROUPS, duration: DURATION, readPoints: c.value.readPoints });
    if (!motion.ok) throw motion.error;
    expect(motion.value.issues.map((i) => i.code)).toEqual([]);
    expect(motion.value.concurrency).toBeGreaterThan(0.9);
    expect(Math.min(...motion.value.readPoints.map((p) => p.held))).toBeGreaterThanOrEqual(8);
    // C-107's hand-keyed path runs its phases into each other.
    const keyed = r.motionReport(limbPath(), { groups: GROUPS, duration: 6 });
    expect(keyed.ok && keyed.value.issues.map((i) => i.code)).toEqual(['concurrent']);
  });

  it('claims space per phase: only mounted neighbours share cells', { timeout: 600000 }, () => {
    const c = choreographLimb(r);
    if (!c.ok) throw c.error;
    const claims = r.phaseClaims(c.value.path, { voxel: 0.02, contacts: LIMB_CONTACTS, phases: c.value.spans });
    if (!claims.ok) throw claims.error;
    expect(claims.value.claims.map((x) => [x.phase, x.parts])).toEqual([
      ['fender-open', ['fender']],
      ['wheel-up', ['wheel']],
      ['shoulder-down', ['upper-arm', 'forearm', 'wheel', 'slider', 'claw']],
      ['elbow-unfold', ['forearm', 'wheel', 'slider', 'claw']],
      ['hand-out', ['slider', 'claw']],
      ['claw-open', ['claw']],
      ['pauldron', ['fender']],
    ]);
    // Every moving part is a declared mover: no drive member moves unclaimed.
    expect(claims.value.claims.every((x) => x.unclaimed.length === 0)).toBe(true);
    expect(claims.value.conflicts.every((x) => x.kind === 'static')).toBe(true);
  });

  it('releases the fender along the body and holds the arm', () => {
    const c = choreographLimb(r);
    if (!c.ok) throw c.error;
    const release = r.release('fender', c.value.path);
    if (!release.ok) throw release.error;
    // The hinge seam slides along the body (zero draft) and nothing moves into it.
    expect(release.value.undercut).toEqual([]);
    expect(release.value.critical.length).toBe(release.value.faces.length);
    const robot = r.sample(c.value.path, 1);
    if (!robot.ok) throw robot.error;
    const efforts = r.actuation(robot.value, { ratings: { shoulder: 400 } });
    if (!efforts.ok) throw efforts.error;
    expect(efforts.value.exceeded).toEqual([]);
    const car = r.actuation({}, { ratings: { shoulder: 400 } });
    // Folded under the car the arm hangs farther out: the shoulder holds more than in the pose.
    expect(car.ok && car.value.exceeded).toEqual(['shoulder']);
  });
});
