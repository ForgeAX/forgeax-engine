import { describe, expect, it } from 'vitest';
import { model } from '../model';
import type { PoseCode } from '../pose-report';
import { rig } from '../rig';
import { sel } from '../selectors';
import { expectConserved, expectFalsifiable } from './fixtures/falsifiable';

/**
 * A block figure facing +z: pelvis and chest on hinges about z (front view tilts), two legs
 * with feet on the ground, each leg on a slide along y so a foot can be lifted.
 */
function figure(o: { arms?: boolean; stilts?: boolean; thin?: boolean; sheet?: boolean } = {}) {
  const m = model();
  const box = (label: string, size: [number, number, number], center: [number, number, number]) =>
    m.box({ size, center, label });
  // A box on stilts: a wide slab torso on two thin legs.
  box('pelvis', o.stilts ? [0.9, 0.1, 0.3] : [0.4, 0.2, 0.2], [0, 1.0, 0]);
  box('chest', o.stilts ? [1.0, 0.9, 0.35] : [0.5, 0.5, 0.25], [0, o.stilts ? 1.5 : 1.4, 0]);
  for (const [side, x] of [
    ['l', 0.15],
    ['r', -0.15],
  ] as const) {
    box(`leg-${side}`, o.stilts ? [0.03, 0.85, 0.03] : [0.12, 0.85, 0.12], [x, 0.475, 0]);
    box(`foot-${side}`, o.stilts ? [0.14, 0.02, 0.4] : [0.12, 0.05, 0.25], [
      x,
      o.stilts ? 0.01 : 0.025,
      o.stilts ? 0 : 0.05,
    ]);
    // Arms hang 7 cm clear of the chest.
    if (o.arms) box(`arm-${side}`, [0.08, 0.5, 0.1], [Math.sign(x) * 0.36, 1.35, 0]);
  }
  if (o.sheet) m.plane({ width: 0.3, height: 0.3, center: [0, 0.5, 0.3], label: 'sheet' });
  if (o.thin) {
    m.box({ size: [0.02, 3, 0.02], center: [1.5, 1.5, 0], label: 'bar' });
    m.rotate(sel.createdBy('bar'), 'z', 45);
  }
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'pelvis', parent: 'root', position: [0, 1.0, 0], kind: 'revolute', axis: 'z' },
      { name: 'chest', parent: 'pelvis', position: [0, 1.15, 0], kind: 'revolute', axis: 'z' },
      { name: 'hip-l', parent: 'root', position: [0.15, 0.9, 0] },
      { name: 'hip-r', parent: 'root', position: [-0.15, 0.9, 0] },
      { name: 'step-l', parent: 'hip-l', position: [0.15, 0.9, 0], kind: 'prismatic', axis: 'y' },
      { name: 'shoulder-l', parent: 'chest', position: [0.25, 1.6, 0] },
      { name: 'shoulder-r', parent: 'chest', position: [-0.25, 1.6, 0] },
      { name: 'pelvis-l', parent: 'pelvis', position: [0.15, 1.0, 0] },
      { name: 'pelvis-r', parent: 'pelvis', position: [-0.15, 1.0, 0] },
    ],
  });
  r.bindRigid(sel.createdBy('pelvis'), 'pelvis', { part: 'pelvis' });
  r.bindRigid(sel.createdBy('chest'), 'chest', { part: 'chest' });
  if (o.sheet) r.bindRigid(sel.createdBy('sheet'), 'root', { part: 'sheet' });
  if (o.thin) r.bindRigid(sel.createdBy('bar'), 'root', { part: 'bar' });
  if (o.arms)
    r.bindRigid(sel.createdBy('arm-l').or(sel.createdBy('arm-r')), 'chest', { part: 'arms' });
  r.bindRigid(sel.createdBy('leg-l').or(sel.createdBy('foot-l')), 'step-l', { part: 'leg-l' });
  r.bindRigid(sel.createdBy('leg-r').or(sel.createdBy('foot-r')), 'hip-r', { part: 'leg-r' });
  return r;
}

const OPTIONS = {
  hips: ['pelvis-l', 'pelvis-r'],
  shoulders: ['shoulder-l', 'shoulder-r'],
  feet: ['leg-l', 'leg-r'],
} as const;

describe('rig.poseReport', () => {
  it('reports a symmetric stance as balanced and grounded but without contrapposto', () => {
    const report = figure().poseReport({}, OPTIONS);
    if (!report.ok) throw report.error;
    expect(report.value).toMatchObject({
      hips: 0,
      shoulders: 0,
      counterTilt: 0,
      contrapposto: false,
    });
    expect(report.value.issues.map((i) => i.code)).toContain('no-contrapposto');
    expect(report.value.issues.map((i) => i.code)).not.toContain('unbalanced');
    expect(report.value.issues.map((i) => i.code)).not.toContain('not-grounded');
    expect(report.value.margin).toBeGreaterThan(0);
    expect(report.value.feet.every((f) => f.grounded)).toBe(true);
    expect(report.value.silhouette.fill).toBeGreaterThan(0.3);
    expect(report.value.silhouette.fill).toBeLessThan(1);
  });

  it('finds the counter-tilt of a contrapposto', () => {
    const report = figure().poseReport({ pelvis: 6, chest: -12 }, OPTIONS);
    if (!report.ok) throw report.error;
    expect(report.value.hips).toBeCloseTo(6, 6);
    expect(report.value.shoulders).toBeCloseTo(-6, 6);
    expect(report.value.contrapposto).toBe(true);
    expect(report.value.issues.map((i) => i.code)).not.toContain('no-contrapposto');
  });

  it('flags a foot lifted 5 cm and a centre of mass outside the feet', () => {
    const r = figure();
    const lifted = r.poseReport({ 'step-l': 0.05 }, OPTIONS);
    if (!lifted.ok) throw lifted.error;
    expect(lifted.value.issues.map((i) => i.code)).toContain('not-grounded');
    expect(lifted.value.feet.find((f) => f.part === 'leg-l')?.gap).toBeCloseTo(0.05, 9);
    const leaning = r.poseReport({ pelvis: 90 }, OPTIONS);
    if (!leaning.ok) throw leaning.error;
    expect(leaning.value.issues.map((i) => i.code)).toContain('unbalanced');
    expect(leaning.value.margin).toBeLessThan(0);
    expect(r.poseReport({}, { ...OPTIONS, feet: ['nope'] }).ok).toBe(false);
  });

  it('fails a box on stilts and passes arms clear of the torso', () => {
    // Falsifier: the slab torso in a balanced contrapposto passed every check before.
    const stilts = figure({ stilts: true }).poseReport({ pelvis: 6, chest: -12 }, OPTIONS);
    if (!stilts.ok) throw stilts.error;
    expect(stilts.value.issues.map((i) => i.code)).toContain('no-negative-space');
    expect(stilts.value.issues.map((i) => i.code)).not.toContain('unbalanced');
    expect(stilts.value.silhouette.negativeSpace).toBeLessThan(0.01);
    const armed = figure({ arms: true }).poseReport({ pelvis: 6, chest: -12 }, OPTIONS);
    if (!armed.ok) throw armed.error;
    expect(armed.value.issues.map((i) => i.code)).not.toContain('no-negative-space');
    expect(armed.value.silhouette.negativeSpace).toBeGreaterThan(0.1);
  });

  it('reads the line of action: straight when symmetric, curved in a contrapposto', () => {
    const r = figure({ arms: true });
    const still = r.poseReport({}, OPTIONS);
    expect(still.ok && still.value.lineOfAction.shape).toBe('straight');
    expect(still.ok && still.value.issues.map((i) => i.code)).toContain('straight-line-of-action');
    const posed = r.poseReport({ pelvis: 6, chest: -12 }, OPTIONS);
    if (!posed.ok) throw posed.error;
    expect(posed.value.lineOfAction.shape).not.toBe('straight');
    expect(posed.value.issues.map((i) => i.code)).not.toContain('straight-line-of-action');
  });

  it('reports open parts and refuses poses past a limit', () => {
    // Falsifier: a 3 x 3 m open wing off a small body was silently massless and balanced.
    const m = model();
    m.box({ size: [0.2, 1, 0.2], center: [0, 0.5, 0], label: 'leg' });
    m.box({ size: [0.6, 0.05, 0.6], center: [0, 0.025, 0], label: 'foot' });
    m.plane({ width: 3, height: 3, center: [1.5, 1.2, 0], label: 'wing' });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        {
          name: 'tilt',
          parent: 'root',
          position: [0, 1, 0],
          kind: 'revolute',
          axis: 'z',
          limits: [-10, 10],
        },
      ],
    });
    r.bindRigid(sel.createdBy('leg').or(sel.createdBy('foot')), 'root', { part: 'body' });
    r.bindRigid(sel.createdBy('wing'), 'tilt', { part: 'wing' });
    const report = r.poseReport({}, { feet: ['body'] });
    if (!report.ok) throw report.error;
    expect(report.value.massless).toEqual(['wing']);
    expect(report.value.issues.map((i) => i.code)).toContain('massless');
    // Past a limit the report refuses by default; asked to clamp, it says so.
    expect(r.poseReport({ tilt: 30 }, { feet: ['body'] }).ok).toBe(false);
    const clamped = r.poseReport({ tilt: 30 }, { feet: ['body'], limits: 'clamp' });
    expect(clamped.ok && clamped.value.clamped.map((c) => [c.joint, c.applied])).toEqual([
      ['tilt', 10],
    ]);
    expect(r.actuation({ tilt: 30 }).ok).toBe(false);
    const held = r.actuation({ tilt: 30 }, { limits: 'clamp' });
    expect(held.ok && held.value.clamped.length).toBe(1);
    // Nothing closed: no centre of mass to balance.
    const open = model();
    open.plane({ width: 0.6, height: 0.6, center: [5, 0, 0], label: 'p' });
    const sheet = rig(open, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    sheet.bindRigid(sel.createdBy('p'), 'root', { part: 'p' });
    const none = sheet.poseReport({}, { feet: ['p'] });
    expect(none.ok && none.value.margin).toBeUndefined();
    expect(none.ok && none.value.issues.map((i) => i.code)).toContain('massless');
  });

  it('lists the gates it did not check as unchecked coverage', () => {
    const r = figure({ arms: true });
    const bare = r.poseReport({}, {});
    if (!bare.ok) throw bare.error;
    const left = bare.value.coverage.unchecked.map((u) => [u.code, u.reason]);
    expect(left).toEqual([
      ['no-contrapposto', 'not-requested'],
      ['unbalanced', 'not-requested'],
      ['not-grounded', 'not-requested'],
    ]);
    const full = r.poseReport({}, OPTIONS);
    if (!full.ok) throw full.error;
    expect(full.value.coverage.unchecked).toEqual([]);
    const half = r.poseReport({}, { hips: OPTIONS.hips });
    if (!half.ok) throw half.error;
    expect(half.value.coverage.unchecked[0]).toMatchObject({
      code: 'no-contrapposto',
      reason: 'missing-input',
    });
  });

  it('accounts for every subject', () => {
    const r = figure({ arms: true }).poseReport({}, OPTIONS);
    if (!r.ok) throw r.error;
    expectConserved(r.value.coverage, {
      'no-contrapposto': 1,
      unbalanced: 1,
      'not-grounded': 2,
      'thin-silhouette': 1,
      'no-negative-space': 1,
      'straight-line-of-action': 1,
      massless: 5,
    });
  });

  it('has a falsifier per code', () => {
    interface Case {
      readonly rig: ReturnType<typeof figure>;
      readonly pose: Record<string, number>;
    }
    const posed = { pelvis: 6, chest: -12 };
    const run = (c: Case) => {
      const out = c.rig.poseReport(c.pose, OPTIONS);
      if (!out.ok) throw out.error;
      return out.value;
    };
    const arms = figure({ arms: true });
    expectFalsifiable<Case, PoseCode>(
      run,
      { rig: arms, pose: posed },
      {
        'no-contrapposto': { rig: arms, pose: {} },
        unbalanced: { rig: arms, pose: { ...posed, pelvis: 90 } },
        'not-grounded': { rig: arms, pose: { ...posed, 'step-l': 0.05 } },
        'thin-silhouette': { rig: figure({ arms: true, thin: true }), pose: posed },
        'no-negative-space': { rig: figure({ stilts: true }), pose: posed },
        'straight-line-of-action': { rig: arms, pose: {} },
        massless: { rig: figure({ arms: true, sheet: true }), pose: posed },
      },
    );
  });
});
