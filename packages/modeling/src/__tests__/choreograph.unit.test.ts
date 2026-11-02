import { describe, expect, it } from 'vitest';
import type { ChoreographyPhase } from '../choreograph';
import { model } from '../model';
import { type Range, rig } from '../rig';
import { sel } from '../selectors';

/** An arm: a shoulder about z and an elbow about z, 0.5 m out. */
function arm(shoulder: Range = [-30, 120]) {
  const m = model();
  m.box({ size: [0.5, 0.04, 0.04], center: [0.25, 0, 0], label: 'upper' });
  m.box({ size: [0.4, 0.04, 0.04], center: [0.7, 0, 0], label: 'fore' });
  const r = rig(m, {
    joints: [
      { name: 'ground', parent: null, position: [0, 0, 0] },
      {
        name: 'shoulder',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'revolute',
        axis: 'z',
        limits: shoulder,
      },
      {
        name: 'elbow',
        parent: 'shoulder',
        position: [0.5, 0, 0],
        kind: 'revolute',
        axis: 'z',
        limits: [0, 90],
      },
    ],
  });
  r.bindRigid(sel.createdBy('upper'), 'shoulder', { part: 'upper' });
  r.bindRigid(sel.createdBy('fore'), 'elbow', { part: 'fore' });
  return r;
}

const raise = (span: readonly [number, number], anticipate = 0.1): ChoreographyPhase => ({
  id: 'raise',
  from: { shoulder: 0 },
  to: { shoulder: 90 },
  beat: { span, anticipate },
});
const bend = (span: readonly [number, number]): ChoreographyPhase => ({
  id: 'bend',
  from: { elbow: 0 },
  to: { elbow: 60 },
  beat: { span, overshoot: 0.05 },
});

describe('rig.choreograph', () => {
  it('keys each phase in its window with its anticipation and overshoot', () => {
    const r = arm();
    const c = r.choreograph({ phases: [raise([0, 1]), bend([1.5, 2.5])], duration: 3 });
    if (!c.ok) throw c.error;
    const { path, extremes, readPoints, clamped } = c.value;
    const at = (t: number) => path.keys.find((k) => Math.abs(k.u * 3 - t) < 1e-9)?.pose;
    expect(at(0)?.shoulder).toBe(0);
    expect(at(1)?.shoulder).toBeCloseTo(90, 9);
    expect(at(2.5)?.elbow).toBeCloseTo(60, 9);
    // The dip reaches anticipate x travel back, the settle overshoot x travel past.
    expect(extremes.shoulder?.value?.[0]).toBeCloseTo(-9, 1);
    expect(extremes.elbow?.value?.[1]).toBeCloseTo(63, 1);
    expect(clamped).toEqual([]);
    expect(readPoints).toEqual([
      { phase: 'raise', at: 1, u: 1 / 3, hold: 0.5 },
      { phase: 'bend', at: 2.5, u: 2.5 / 3, hold: 0.5 },
    ]);
    // A read point inside another phase's window has no hold.
    const overlap = r.choreograph({ phases: [raise([0, 1]), bend([0.8, 2])], duration: 3 });
    expect(overlap.ok && overlap.value.readPoints[0]?.hold).toBe(0);
  });

  it('keys every joint of every phase active at a key time', () => {
    // Falsifier: overlapping phases with their own key times. Keyed only by its own phase,
    // the shoulder would interpolate across the bend's keys (and `extra`, computed from the
    // whole pose, would disagree with it there).
    const r = arm();
    const seen: string[] = [];
    const c = r.choreograph({
      phases: [raise([0, 1]), bend([0.33, 1.7])],
      duration: 2,
      extra: (_pose, phase) => {
        seen.push(phase);
        return {};
      },
    });
    if (!c.ok) throw c.error;
    for (const key of c.value.path.keys) {
      const t = key.u * 2;
      if (t > 0.33 + 1e-9 && t < 1 - 1e-9) {
        expect(Object.keys(key.pose).sort()).toEqual(['elbow', 'shoulder']);
      }
    }
    expect(new Set(seen)).toEqual(new Set(['raise', 'bend']));
  });

  it('refuses an anticipation past a joint limit unless clamping is asked for', () => {
    // Falsifier: the shoulder starts on its lower limit, so the dip leaves the range.
    const r = arm([0, 120]);
    const phases = [raise([0, 1])];
    const refused = r.choreograph({ phases, duration: 2 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('model-invalid-argument');
      const beyond = (refused.error.detail as { beyond: { joint: string; value: number }[] })
        .beyond;
      expect(beyond[0]?.joint).toBe('shoulder');
      expect(beyond.every((b) => b.value < 0)).toBe(true);
    }
    const held = r.choreograph({ phases, duration: 2, limits: 'clamp' });
    if (!held.ok) throw held.error;
    expect(held.value.clamped).toHaveLength(1);
    expect(held.value.clamped[0]?.joint).toBe('shoulder');
    expect(held.value.clamped[0]?.applied).toBe(0);
    expect(held.value.clamped[0]?.requested).toBeCloseTo(-9, 1);
    expect(held.value.extremes.shoulder?.value?.[0]).toBe(0);
  });

  it('refuses unknown joints and windows outside the clip', () => {
    const r = arm();
    const unknown = r.choreograph({
      phases: [{ id: 'x', from: { wrist: 0 }, to: { wrist: 10 }, beat: { span: [0, 1] } }],
      duration: 2,
    });
    expect(!unknown.ok && unknown.error.message).toContain('phase joints that exist');
    expect(r.choreograph({ phases: [raise([1, 3])], duration: 2 }).ok).toBe(false);
  });
});

describe("PosePath interpolation 'hermite'", () => {
  it('passes keys with velocity and never overshoots between them', () => {
    const r = arm();
    const keys = [
      { u: 0, pose: { shoulder: 0 } },
      { u: 0.4, pose: { shoulder: 50 } },
      { u: 0.6, pose: { shoulder: 50 } },
      { u: 1, pose: { shoulder: 100 } },
    ];
    const value = (interpolation: 'hermite' | 'smooth', u: number) => {
      const p = r.sample({ keys, interpolation }, u);
      if (!p.ok) throw p.error;
      return p.value.shoulder as number;
    };
    const through = [
      keys[0] as (typeof keys)[number],
      { u: 0.5, pose: { shoulder: 50 } },
      { u: 1, pose: { shoulder: 60 } },
    ];
    const mid = (interpolation: 'hermite' | 'smooth', du: number) => {
      const p = r.sample({ keys: through, interpolation }, 0.5 + du);
      if (!p.ok) throw p.error;
      return p.value.shoulder as number;
    };
    // Through a mid key: 'smooth' stops there, 'hermite' keeps moving.
    expect(Math.abs(mid('smooth', 1e-3) - mid('smooth', -1e-3))).toBeLessThan(1e-3);
    expect(mid('hermite', 1e-3) - mid('hermite', -1e-3)).toBeGreaterThan(0.02);
    expect(mid('hermite', 0)).toBeCloseTo(50, 9);
    // C1 at the key: equal slopes on both sides (linear would show 100 vs 20 per u).
    const left = (mid('hermite', 0) - mid('hermite', -1e-4)) / 1e-4;
    const right = (mid('hermite', 1e-4) - mid('hermite', 0)) / 1e-4;
    expect(Math.abs(left - right)).toBeLessThan(0.01 * right);
    // Monotone: the flat stretch stays flat and every sample stays in its key range.
    let prior = -Infinity;
    for (let k = 0; k <= 100; k++) {
      const v = value('hermite', k / 100);
      expect(v).toBeGreaterThanOrEqual(prior - 1e-9);
      prior = v;
      if (k >= 40 && k <= 60) expect(v).toBeCloseTo(50, 9);
    }
  });
});

describe('rig.motionReport', () => {
  const groups = { arm: ['shoulder'], hand: ['elbow'] };

  it('passes one action at a time with held read points', () => {
    const r = arm();
    const c = r.choreograph({ phases: [raise([0, 1]), bend([1.5, 2.5])], duration: 3 });
    if (!c.ok) throw c.error;
    const m = r.motionReport(c.value.path, { groups, duration: 3, readPoints: c.value.readPoints });
    if (!m.ok) throw m.error;
    expect(m.value.issues.map((i) => i.code)).toEqual([]);
    expect(m.value.concurrency).toBe(1);
    expect(m.value.readPoints.map((p) => p.held)).toEqual([12, 12]);
    expect(m.value.groups.arm?.[0]?.[0]).toBe(0);
  });

  it('holds from the frame after a read point between frames', () => {
    // The raise ends a quarter frame into frame 24: the hold starts with frame 25.
    const r = arm();
    const c = r.choreograph({ phases: [raise([0, 1.01]), bend([1.6, 2.5])], duration: 3 });
    if (!c.ok) throw c.error;
    const m = r.motionReport(c.value.path, { groups, duration: 3, readPoints: c.value.readPoints });
    expect(m.ok && m.value.readPoints[0]?.held).toBe(14);
    expect(m.ok && m.value.issues.map((i) => i.code)).toEqual([]);
  });

  it('flags concurrent groups and a short hold', () => {
    const r = arm();
    // Falsifier: the bend starts halfway through the raise (concurrent for 0.5 s of 3 s).
    const busy = r.choreograph({ phases: [raise([0, 1]), bend([0.5, 2])], duration: 3 });
    if (!busy.ok) throw busy.error;
    const m = r.motionReport(busy.value.path, { groups, duration: 3 });
    expect(m.ok && m.value.issues.map((i) => i.code)).toEqual(['concurrent']);
    // Falsifier: 0.2 s (4.8 frames) between the raise and the bend.
    const rushed = r.choreograph({ phases: [raise([0, 1]), bend([1.2, 2.2])], duration: 3 });
    if (!rushed.ok) throw rushed.error;
    const h = r.motionReport(rushed.value.path, {
      groups,
      duration: 3,
      readPoints: rushed.value.readPoints,
    });
    expect(h.ok && h.value.issues.map((i) => i.code)).toEqual(['short-hold']);
  });
});
