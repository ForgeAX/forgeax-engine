import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { type PhaseClaimsCode, type PosePath, rig } from '../rig';
import { sel } from '../selectors';
import { expectConserved, expectFalsifiable } from './fixtures/falsifiable';

const VOXEL = 0.01;

interface Input {
  readonly plateZ: number;
  readonly follower: boolean;
  readonly phases: readonly { id: string; u: readonly [number, number]; joints?: string[] }[];
}

function run(input: Input) {
  const m = model();
  m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: 'driver' });
  m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0.2, 0], label: 'follower' });
  m.box({ size: [0.1, 0.1, 0.02], center: [0, 0.2, input.plateZ], label: 'plate' });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'drive', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
      { name: 'follow', parent: 'root', position: [0, 0.2, 0], kind: 'revolute', axis: 'y' },
    ],
  });
  r.bindRigid(sel.createdBy('driver'), 'drive', { part: 'driver' });
  r.bindRigid(sel.createdBy('follower'), 'follow', { part: 'follower' });
  r.bindRigid(sel.createdBy('plate'), 'root', { part: 'plate' });
  const path: PosePath = {
    keys: [
      { u: 0, pose: { drive: 0, follow: 0 } },
      { u: 1, pose: { drive: 30, follow: input.follower ? 120 : 0 } },
    ],
  };
  const out = r.phaseClaims(path, { voxel: VOXEL, phases: input.phases });
  if (!out.ok) throw out.error;
  return out.value;
}

const phase = [{ id: 'p', u: [0, 1] as const, joints: ['drive'] }];
const clean: Input = { plateZ: -0.6, follower: true, phases: phase };

function crossing(second: number): Input2 {
  const m = model();
  for (const [k, deg] of [0, 180].entries()) {
    m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: `bar${k}` });
    if (deg !== 0) m.rotate(sel.createdBy(`bar${k}`), 'y', deg);
  }
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'hinge0', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
      { name: 'hinge1', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
    ],
  });
  r.bindRigid(sel.createdBy('bar0'), 'hinge0', { part: 'bar0' });
  r.bindRigid(sel.createdBy('bar1'), 'hinge1', { part: 'bar1' });
  const path: PosePath = {
    keys: [
      { u: 0, pose: { hinge0: 0, hinge1: 0 } },
      { u: 1, pose: { hinge0: 180, hinge1: second } },
    ],
  };
  const out = r.phaseClaims(path, { voxel: VOXEL, phases: [{ id: 'one', u: [0, 1] }] });
  if (!out.ok) throw out.error;
  return out.value;
}
type Input2 = ReturnType<typeof run>;

describe('phaseClaims gate evidence', () => {
  it('has a falsifier per code', () => {
    // The clean twin and the falsifiers are separate rigs; each input is a thunk-free report.
    const reports: Record<string, Input2> = {
      clean: run(clean),
      'static-conflict': run({ ...clean, plateZ: -0.2 }),
      'concurrent-conflict': crossing(-180),
      'nothing-checked': run({ ...clean, phases: [] }),
    };
    expectFalsifiable<string, PhaseClaimsCode>((k) => reports[k] as Input2, 'clean', {
      'static-conflict': 'static-conflict',
      'concurrent-conflict': 'concurrent-conflict',
      'nothing-checked': 'nothing-checked',
    });
  });

  it('accounts for every part of every phase', () => {
    const report = run(clean);
    expectConserved(report.coverage, { 'static-conflict': 3, 'concurrent-conflict': 2 });
    expect(report.coverage.unchecked).toEqual([]);
  });

  it('lists the follower as an unclaimed mover that is checked', () => {
    const report = run({ ...clean, plateZ: -0.2 });
    expect(report.claims[0]?.unclaimed).toEqual(['follower']);
    expect(report.issues.map((i) => i.code)).toContain('static-conflict');
    expect(report.pass).toBe(false);
  });
});
