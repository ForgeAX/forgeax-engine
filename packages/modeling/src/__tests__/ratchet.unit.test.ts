import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { recipes } from '../recipes';
import { ratchetPawlAngle } from '../recipes/ratchet';
import { rig } from '../rig';
import { sel } from '../selectors';
import { corners, expectClean } from './recipe-contract';

const TIP = 0.02;
const DEFAULT = { teeth: 12, tipRadius: TIP, toothDepth: 0.002, width: 0.01 };
const PITCH = 360 / DEFAULT.teeth;

function part(r: ReturnType<typeof recipes.ratchet>) {
  if (!r.ok) throw r.error;
  return r.value;
}

/** Wheel and pawl on their own revolute joints about +Z; the pawl is bound to its own part. */
function pair(options = DEFAULT, direction?: 'ccw' | 'cw', declared = true) {
  const w = part(recipes.ratchet(direction === undefined ? options : { ...options, direction }));
  const m = model();
  m.append(w.model, { tag: 'ratchet' });
  const rg = rig(m, {
    contacts: declared ? (w.contacts ?? []) : [],
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
        name: 'pawl',
        parent: 'frame',
        position: w.anchors.pawlPivot as [number, number, number],
        kind: 'revolute',
        axis: 'z',
      },
    ],
  });
  rg.bindRigid(sel.createdBy('ratchet-wheel'), 'wheel', { part: 'ratchet-wheel' });
  rg.bindRigid(sel.createdBy('ratchet-pawl'), 'pawl', { part: 'ratchet-pawl' });
  return { w, rg };
}

/** Pose with the pawl resting on the wheel at `wheel` degrees (the rig's pawl joint, seat-relative). */
function resting(options: typeof DEFAULT, wheel: number): { wheel: number; pawl: number } {
  const angle = ratchetPawlAngle(options, wheel);
  if (!angle.ok) throw angle.error;
  return { wheel, pawl: angle.value };
}

describe('recipes.pawl', () => {
  it('builds a closed bar with its boss at the origin', () => {
    const p = part(recipes.pawl({ length: 0.02, width: 0.002, thickness: 0.01 }));
    expect(p.anchors.pivot).toEqual([0, 0, 0]);
    expect(p.anchors.tip?.[0]).toBeCloseTo(0.02, 12);
    const report = p.model.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('rejects an out-of-range length with model-invalid-argument', () => {
    const r = recipes.pawl({ length: 0.0001, width: 0.002, thickness: 0.01 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});

describe('recipes.ratchet', () => {
  it('builds a closed wheel and pawl at the default options', { timeout: 60000 }, () => {
    const p = expectClean('default ratchet', recipes.ratchet(DEFAULT));
    expect(p.dimensions.pitch).toBeCloseTo(PITCH, 9);
    expect(p.contacts).toEqual([
      { parts: ['ratchet-wheel', 'ratchet-pawl'], kind: 'seat', tolerance: 1e-6 },
    ]);
  });

  it('is deterministic: the same options give identical geometry', { timeout: 60000 }, () => {
    const a = part(recipes.ratchet(DEFAULT)).model.toMesh();
    const b = part(recipes.ratchet(DEFAULT)).model.toMesh();
    if (!a.ok || !b.ok) throw new Error('export failed');
    expect(a.value.mesh).toEqual(b.value.mesh);
  });

  it('builds clean across the feasible corners of its ranges', { timeout: 120000 }, () => {
    const sets = corners(DEFAULT, {
      teeth: [8, 16],
      toothDepth: [0.1 * TIP, 0.25 * TIP],
      width: [0.2 * TIP, TIP],
    });
    let built = 0;
    for (const options of sets) {
      const r = recipes.ratchet(options);
      if (!r.ok) {
        expect(r.error.code).toBe('model-invalid-argument');
        continue;
      }
      expectClean(JSON.stringify(options), r);
      built++;
    }
    expect(built).toBeGreaterThan(0);
  });

  it('seats the pawl at pitches 0, 1 and 2 with zero confirmed interference', {
    timeout: 300000,
  }, () => {
    const { rg } = pair();
    for (const k of [0, 1, 2]) {
      const pose = resting(DEFAULT, k * PITCH);
      const hit = rg.interference(pose);
      if (!hit.ok) throw hit.error;
      expect(hit.value.confirmed, `pitch ${k}`).toBe(0);
    }
  });

  it('keeps the seated tip-to-face clearance within 0.05 mm at pitches 0, 1 and 2', {
    timeout: 300000,
  }, () => {
    // The seat is declared only for the interference checks: undeclared, the scan reports the true gap.
    const { rg } = pair(DEFAULT, undefined, false);
    for (const k of [0, 1, 2]) {
      const pose = resting(DEFAULT, k * PITCH);
      const scan = rg.scan(
        {
          keys: [
            { u: 0, pose },
            { u: 1, pose },
          ],
        },
        { clearance: 5e-5, step: 1 },
      );
      if (!scan.ok) throw scan.error;
      const pair = scan.value.pairs.find(
        (p) => p.parts.includes('ratchet-wheel') && p.parts.includes('ratchet-pawl'),
      );
      expect(pair?.minDistance, `pitch ${k}`).toBeDefined();
      expect(pair?.minDistance as number, `pitch ${k}`).toBeLessThanOrEqual(5e-5);
    }
  });

  it('turns freely in the drive direction: resting pawl at five wheel angles has zero confirmed interference', {
    timeout: 300000,
  }, () => {
    const { rg } = pair();
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const pose = resting(DEFAULT, f * PITCH);
      const hit = rg.interference(pose);
      if (!hit.ok) throw hit.error;
      expect(hit.value.confirmed, `fraction ${f}`).toBe(0);
    }
  });

  it('falsifier: a 1 degree turn in the blocked direction with the pawl seated is confirmed', {
    timeout: 120000,
  }, () => {
    const { rg } = pair();
    const seated = resting(DEFAULT, 0);
    const hit = rg.interference({ wheel: -1, pawl: seated.pawl });
    if (!hit.ok) throw hit.error;
    expect(hit.value.confirmed).toBeGreaterThan(0);
  });

  it('builds the pawl at its resting pose: the seat angle is zero at every whole pitch', () => {
    expect(Math.abs(resting(DEFAULT, 0).pawl)).toBeLessThan(1e-9);
    // A turned wheel carries rotation round-off, so later seats are zero to 1e-4 degrees.
    for (const k of [1, 2])
      expect(Math.abs(resting(DEFAULT, k * PITCH).pawl), `pitch ${k}`).toBeLessThan(1e-4);
  });

  it('lifts over the ramp: the resting pawl swings away mid-pitch and a pawl held at seat clashes', {
    timeout: 120000,
  }, () => {
    const mid = resting(DEFAULT, PITCH / 2);
    expect(mid.pawl).toBeLessThan(-0.5);
    const { rg } = pair();
    const held = rg.interference({ wheel: PITCH / 2, pawl: 0 });
    if (!held.ok) throw held.error;
    expect(held.value.confirmed).toBeGreaterThan(0);
    const riding = rg.interference(mid);
    if (!riding.ok) throw riding.error;
    expect(riding.value.confirmed).toBe(0);
  });

  it('mirrors for the cw drive direction: seated clean, blocked turn confirmed', {
    timeout: 120000,
  }, () => {
    const { rg } = pair(DEFAULT, 'cw');
    const seated = rg.interference({ wheel: 0, pawl: 0 });
    if (!seated.ok) throw seated.error;
    expect(seated.value.confirmed).toBe(0);
    const blocked = rg.interference({ wheel: 1, pawl: 0 });
    if (!blocked.ok) throw blocked.error;
    expect(blocked.value.confirmed).toBeGreaterThan(0);
  });

  it('refuses a deep tooth on a fine pitch: the previous tooth covers the stop face', () => {
    const r = recipes.ratchet({ ...DEFAULT, teeth: 16, toothDepth: 0.2 * TIP });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('rejects an out-of-range tooth count with model-invalid-argument', () => {
    const r = recipes.ratchet({ ...DEFAULT, teeth: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});
