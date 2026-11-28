import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { recipes } from '../recipes';
import {
  type EscapementWheelOptions,
  escapementReleaseAngle,
  escapementStopAngle,
  STANDARD_GRAVITY,
  type SteelyardStopOptions,
} from '../recipes/escapement';
import { SEAT_TOLERANCE } from '../recipes/locking';
import { type Rig, rig } from '../rig';
import { sel } from '../selectors';
import { corners, expectClean } from './recipe-contract';

const TIP = 0.02;
const WHEEL = {
  teeth: 12,
  tipRadius: TIP,
  toothDepth: 0.004,
  width: 0.01,
  hubRadius: 0.006,
  spokeWidth: 0.003,
};
const STOP: SteelyardStopOptions & EscapementWheelOptions = { ...WHEEL, leverTips: 3, torque: 0.5 };
const PITCH = 360 / WHEEL.teeth;
/** Nose-to-face clearance bound for the seated poses (m): 0.05 mm. */
const CLEARANCE = 5e-5;

function part<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

/** Wheel and stop on their own revolute joints about +Z; the seat is declared only when asked. */
function pair(
  options: SteelyardStopOptions & EscapementWheelOptions = STOP,
  declared = true,
): { rg: Rig } {
  const w = part(recipes.escapementWheel({ ...options, name: 'escapement-wheel' }));
  const s = part(recipes.steelyardStop({ ...options, name: 'escapement-stop' }));
  const m = model();
  m.append(w.model, { tag: 'escapement-wheel' });
  m.append(s.model, { tag: 'escapement-stop' });
  const rg = rig(m, {
    contacts: declared
      ? [
          {
            parts: ['escapement-wheel', 'escapement-stop'],
            kind: 'seat',
            tolerance: SEAT_TOLERANCE,
          },
        ]
      : [],
    joints: [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      {
        name: 'wheel',
        parent: 'frame',
        position: w.anchors.hub as [number, number, number],
        kind: 'revolute',
        axis: 'z',
      },
      {
        name: 'stop',
        parent: 'frame',
        position: s.anchors.pivot as [number, number, number],
        kind: 'revolute',
        axis: 'z',
      },
    ],
  });
  rg.bindRigid(sel.createdBy('escapement-wheel'), 'wheel', { part: 'escapement-wheel' });
  rg.bindRigid(sel.createdBy('escapement-stop'), 'stop', { part: 'escapement-stop' });
  return { rg };
}

/** Joint pose in degrees: wheel angle and stop angle. */
type Pose = { wheel: number; stop: number };

function confirmedAt(rg: Rig, pose: Pose): number {
  const hit = rg.interference(pose);
  if (!hit.ok) throw hit.error;
  return hit.value.confirmed;
}

/** Smallest nose-to-face distance at a pose, with the seat undeclared so the gap is measured. */
function gapAt(rg: Rig, pose: Pose): number | undefined {
  const scan = rg.scan(
    {
      keys: [
        { u: 0, pose },
        { u: 1, pose },
      ],
    },
    { clearance: CLEARANCE, step: 1 },
  );
  if (!scan.ok) throw scan.error;
  const pair = scan.value.pairs.find(
    (p) => p.parts.includes('escapement-wheel') && p.parts.includes('escapement-stop'),
  );
  return pair?.minDistance;
}

function release(options: SteelyardStopOptions = STOP): number {
  return part(escapementReleaseAngle(options));
}

describe('recipes.escapementWheel', () => {
  it('builds a closed clean wheel at the default options', () => {
    const p = expectClean('escapement wheel', recipes.escapementWheel(WHEEL));
    expect(p.dimensions.pitch).toBeCloseTo(PITCH, 9);
    expect(p.anchors.hub).toEqual([0, 0, 0]);
  });

  it('is deterministic', () => {
    const a = part(recipes.escapementWheel(WHEEL)).model.toMesh();
    const b = part(recipes.escapementWheel(WHEEL)).model.toMesh();
    if (!a.ok || !b.ok) throw new Error('export failed');
    expect(a.value.mesh).toEqual(b.value.mesh);
  });

  it('builds clean across the feasible corners of its tooth ranges', { timeout: 120000 }, () => {
    const sets = corners(WHEEL, { teeth: [8, 16], toothDepth: [0.1 * TIP, 0.2 * TIP] });
    let built = 0;
    for (const options of sets) {
      const r = recipes.escapementWheel(options);
      if (!r.ok) {
        expect(r.error.code).toBe('model-invalid-argument');
        continue;
      }
      expectClean(`escapement ${JSON.stringify(options)}`, r);
      built++;
    }
    expect(built).toBeGreaterThan(0);
  });

  it('refuses a deep tooth on a fine pitch: the previous tooth covers the stop face', () => {
    const r = recipes.escapementWheel({ ...WHEEL, teeth: 16, toothDepth: 0.2 * TIP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});

describe('recipes.steelyardStop', () => {
  it('builds a clean lever at three tip radii with the moment-balance trip mass', () => {
    const p = expectClean('steelyard stop', recipes.steelyardStop(STOP));
    expect(p.dimensions.length).toBeCloseTo(3 * TIP, 12);
    expect(p.dimensions.tripMass).toBeCloseTo(0.5 / (STANDARD_GRAVITY * 3 * TIP), 9);
  });

  it('rejects a lever outside 2.5 to 3.5 tip radii with model-invalid-argument', () => {
    const r = recipes.steelyardStop({ ...STOP, leverTips: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});

describe('escapement poses (cw hand)', () => {
  it('LOCKED: wheel 0 and stop 0 are confirmed clear with the nose at most 0.05 mm from the face', () => {
    const { rg } = pair();
    expect(confirmedAt(rg, { wheel: 0, stop: 0 })).toBe(0);
    const { rg: open } = pair(STOP, false);
    const gap = gapAt(open, { wheel: 0, stop: 0 });
    expect(gap).toBeDefined();
    expect(gap as number).toBeLessThanOrEqual(CLEARANCE);
  });

  it('RELEASED: the stop at the closed-form lift is confirmed clear at 0, 0.25, 0.5, 0.75 and 1.0 pitch', () => {
    const { rg } = pair();
    const lift = release();
    expect(lift).toBeGreaterThan(0);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      expect(confirmedAt(rg, { wheel: f * PITCH, stop: lift }), `fraction ${f}`).toBe(0);
    }
  });

  it('RELOCKED: after one pitch the stop seats again with confirmed 0 and the same clearance', () => {
    const { rg } = pair();
    expect(confirmedAt(rg, { wheel: PITCH, stop: 0 })).toBe(0);
    const { rg: open } = pair(STOP, false);
    const gap = gapAt(open, { wheel: PITCH, stop: 0 });
    expect(gap as number).toBeLessThanOrEqual(CLEARANCE);
  });

  it('falsifier: a 1 degree wheel turn with the stop seated is confirmed', () => {
    const { rg } = pair();
    expect(confirmedAt(rg, { wheel: 1, stop: 0 })).toBeGreaterThan(0);
  });

  it('falsifier: a stop lifted half the release angle with the wheel at half a pitch is confirmed', () => {
    const { rg } = pair();
    expect(confirmedAt(rg, { wheel: PITCH / 2, stop: release() / 2 })).toBeGreaterThan(0);
  });

  it('mirrors for the ccw hand: seated clean, released clean, blocked by a cw turn', () => {
    const options = { ...STOP, direction: 'ccw' as const };
    const { rg } = pair(options);
    const lift = release(options);
    expect(lift).toBeLessThan(0);
    expect(confirmedAt(rg, { wheel: 0, stop: 0 })).toBe(0);
    expect(confirmedAt(rg, { wheel: PITCH / 2, stop: lift })).toBe(0);
    expect(confirmedAt(rg, { wheel: -1, stop: 0 })).toBeGreaterThan(0);
  });

  it('exposes the stop angle that rests on the wheel at any angle', () => {
    expect(part(escapementStopAngle(STOP, 0))).toBeCloseTo(0, 9);
  });
});
