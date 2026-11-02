import { describe, expect, it } from 'vitest';
import type { FitCheck } from '../interference';
import { model } from '../model';
import { isoFit, type RecipePart, recipes } from '../recipes';
import { rig } from '../rig';
import { sel } from '../selectors';

function built(result: ReturnType<typeof recipes.pinJoint>): RecipePart {
  if (!result.ok) throw result.error;
  return result.value;
}

const LABELS = ['clevis', 'lug', 'pin', 'washer', 'ring'].map((p) => `pj-${p}`);

/** The joint as a rig: everything on the frame, the lug on a hinge about the pin axis. */
function jointRig(part: RecipePart) {
  const r = rig(part.model, {
    joints: [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      { name: 'turn', parent: 'frame', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
    ],
  });
  for (const label of LABELS) {
    if (part.model.count(sel.createdBy(label)) === 0) continue;
    r.bindRigid(sel.createdBy(label), label === 'pj-lug' ? 'turn' : 'frame', { part: label });
  }
  return r;
}

describe('ISO 286 fits', () => {
  it('matches the 10-18 mm table and centres each band', () => {
    const fit = isoFit(0.012, 'H11/c11');
    if (!fit.ok) throw fit.error;
    expect(fit.value.clearance[0]).toBeCloseTo(95e-6, 12);
    expect(fit.value.clearance[1]).toBeCloseTo(315e-6, 12);
    expect(fit.value.clearanceMid).toBeCloseTo(205e-6, 12);
    const running = isoFit(0.012, 'H8/f7');
    expect(running.ok && [running.value.clearance[0], running.value.clearance[1]]).toEqual([
      expect.closeTo(16e-6, 12),
      expect.closeTo(61e-6, 12),
    ]);
    expect(isoFit(0.2, 'H7/h6').ok).toBe(false);
    expect(isoFit(0.01, 'H9/d9' as 'H7/h6').ok).toBe(false);
  });
});

describe('recipes.pinJoint', () => {
  const part = built(recipes.pinJoint({ d: 0.02, name: 'pj' }));

  it('builds closed parts that validate clean, with every pair declared a fit', () => {
    expect(part.model.poisoned).toBeUndefined();
    const report = part.model.validate({ contacts: part.contacts ?? [] });
    // Only the info that lists each declared fit: nothing crosses, nothing undeclared touches.
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([['designed-contact', 'info']]);
    expect(report.closed).toBe(true);
    expect(part.contacts).toHaveLength(10);
    expect(part.contacts?.every((c) => c.kind === 'fit')).toBe(true);
    for (const label of LABELS) expect(part.model.count(sel.createdBy(label))).toBeGreaterThan(0);
  });

  it('stands the pin flats off the bore flats by the mid-band radial gap', {
    timeout: 60000,
  }, () => {
    const gap = part.dimensions.radialGap as number;
    // 18-30 mm H11/c11: hole 0..+130 um, shaft -110..-240 um, mid clearance 240 um.
    expect(gap).toBeCloseTo(120e-6, 12);
    const r = jointRig(part);
    for (const turn of [0, 7.5, 33]) {
      const scan = r.scan({ keys: [{ u: 0, pose: { turn } }] }, { clearance: 0.005 });
      if (!scan.ok) throw scan.error;
      const pair = scan.value.pairs.find((p) => p.parts.join('/') === 'pj-lug/pj-pin');
      expect(pair?.status).toBe('clearance');
      // Aligned flats measure the gap; a turned pin loses at most half of it to its vertices.
      if (turn === 0)
        expect(Math.abs((pair?.minDistance as number) - gap)).toBeLessThanOrEqual(2e-5);
      expect(pair?.minDistance).toBeGreaterThan(gap / 2 - 1e-9);
    }
  });

  it('turns the lug through its swing with no clash and no undeclared contact', {
    timeout: 120000,
  }, () => {
    const swing = (part.dimensions.swing as number) - 2;
    expect(swing).toBeGreaterThan(90);
    const r = jointRig(part);
    const scan = r.scan(
      {
        keys: [
          { u: 0, pose: { turn: -swing } },
          { u: 1, pose: { turn: swing } },
        ],
      },
      { contacts: part.contacts ?? [], clearance: 0.005 },
    );
    if (!scan.ok) throw scan.error;
    expect(scan.value.pass).toBe(true);
    expect(scan.value.pairs.filter((p) => p.status !== 'designed')).toEqual([]);
  });

  it('reports a pin through a solid lug as a clash', () => {
    const solid = model();
    solid.append(part.model.snapshot());
    solid.delete(sel.createdBy('pj-lug'));
    const t = part.dimensions.lugThickness as number;
    const e = part.dimensions.edge as number;
    solid.box({ size: [2 * e, t, 2 * e], center: [0, 0, 0], label: 'pj-lug' });
    const r = jointRig({ ...part, model: solid });
    const hit = r.interference({}, { contacts: part.contacts ?? [] });
    if (!hit.ok) throw hit.error;
    const pair = hit.value.pairs.find((p) => p.parts.join('/') === 'pj-lug/pj-pin');
    expect(pair?.status).toBe('confirmed');
  });

  it('checks every fit band: a mis-sized bore is a mismatch, not a quiet fit (audit A2)', {
    timeout: 120000,
  }, () => {
    const swap = (d: number) => {
      const m = model();
      m.append(part.model.snapshot());
      m.delete(sel.createdBy('pj-lug'));
      const l = recipes.lug({
        d,
        name: 'pj-lug',
        thickness: part.dimensions.lugThickness as number,
      });
      if (!l.ok) throw l.error;
      m.append(l.value.model.snapshot());
      return m;
    };
    const lugPin = (fits: readonly FitCheck[] | undefined) =>
      fits?.find((f) => f.parts.join('/') === 'pj-lug/pj-pin');
    const designed = jointRig(part);
    const rest = designed.interference({}, { contacts: part.contacts ?? [] });
    if (!rest.ok) throw rest.error;
    expect(rest.value.fits?.every((f) => f.pass)).toBe(true);
    const swept = designed.scan(
      {
        keys: [
          { u: 0, pose: { turn: -30 } },
          { u: 1, pose: { turn: 30 } },
        ],
      },
      { contacts: part.contacts ?? [], clearance: 0.005 },
    );
    expect(swept.ok && swept.value.fits?.every((f) => f.pass)).toBe(true);
    // A 22 mm bore on the 20 mm pin: 1.1 mm of play, far outside H11/c11 (55-185 um radial).
    const loose = swap(0.022);
    const r = jointRig({ ...part, model: loose });
    const hit = r.interference({}, { contacts: part.contacts ?? [] });
    if (!hit.ok) throw hit.error;
    expect(hit.value.pairs.filter((p) => p.status === 'confirmed')).toEqual([]);
    const fit = lugPin(hit.value.fits);
    expect(fit?.pass).toBe(false);
    expect(fit?.min).toBeGreaterThan(0.001);
    const scan = r.scan(
      {
        keys: [
          { u: 0, pose: { turn: -30 } },
          { u: 1, pose: { turn: 30 } },
        ],
      },
      { contacts: part.contacts ?? [], clearance: 0.005 },
    );
    expect(scan.ok && lugPin(scan.value.fits)?.pass).toBe(false);
    const report = loose.validate({ contacts: part.contacts ?? [] });
    const issue = report.issues.find((i) => i.code === 'designed-contact');
    expect(issue?.severity).toBe('warn');
    const fits = (issue?.detail as { fits: { parts: string[]; status: string }[] }).fits;
    expect(fits.find((f) => f.parts.join('/') === 'pj-lug/pj-pin')?.status).toBe('mismatch');
    // A fit band only goes on a fit, ordered.
    expect(
      r.interference({}, { contacts: [{ parts: ['pj-lug', 'pj-pin'], gap: [0, 1] }] }).ok,
    ).toBe(false);
    expect(
      r.interference({}, { contacts: [{ parts: ['pj-lug', 'pj-pin'], kind: 'fit', gap: [2, 1] }] })
        .ok,
    ).toBe(false);
  });

  it('refuses a lug edge distance below 1.5 D with a hint', () => {
    const short = recipes.pinJoint({ d: 0.02, lug: { e: 1.2 } });
    expect(short.ok).toBe(false);
    if (!short.ok) {
      expect(short.error.code).toBe('model-invalid-argument');
      expect(short.error.hint).toContain('1.5');
    }
  });

  it('builds single shear and a bare pin, and keeps every fit at its segment count', () => {
    const single = built(
      recipes.pinJoint({ d: 0.012, shear: 'single', retainer: 'none', name: 'pj' }),
    );
    const issues = single.model.validate({ contacts: single.contacts ?? [] }).issues;
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['designed-contact', 'info']]);
    expect(single.contacts).toHaveLength(3);
    const tight = built(recipes.pinJoint({ d: 0.03, fit: 'H7/g6', name: 'pj' }));
    expect(tight.dimensions.segments).toBeGreaterThan(32);
    const coarse = recipes.pinJoint({ d: 0.03, fit: 'H7/g6', segments: 32 });
    expect(coarse.ok).toBe(false);
    if (!coarse.ok) expect(coarse.error.hint).toContain('segments');
  });
});

describe('recipes.lug, clevis, bushing, rodEnd', () => {
  /** A bare shaft at the fit's shaft mid size, flats in phase with the recipe's bore. */
  function shaftIn(part: RecipePart, length: number, y0: number) {
    const m = model();
    m.append(part.model.snapshot());
    const n = part.dimensions.segments as number;
    const r = (part.dimensions.shaft as number) / 2 / Math.cos(Math.PI / n);
    m.revolve({
      points: [
        [0, y0],
        [r, y0],
        [r, y0 + length],
        [0, y0 + length],
      ],
      segments: n,
      label: 'shaft',
    });
    return m;
  }

  function gapOf(m: ReturnType<typeof model>, label: string): number {
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.createdBy(label), 'root', { part: label });
    r.bindRigid(sel.createdBy('shaft'), 'root', { part: 'shaft' });
    const scan = r.scan({ keys: [{ u: 0, pose: {} }] }, { clearance: 0.005 });
    if (!scan.ok) throw scan.error;
    return scan.value.pairs[0]?.minDistance as number;
  }

  it('builds a lug and a clevis that validate clean around a mid-band pin', () => {
    const l = built(recipes.lug({ d: 0.016, name: 'eye' }));
    expect(l.model.validate().issues).toEqual([]);
    const lg = gapOf(shaftIn(l, 0.06, -0.03), 'eye');
    expect(Math.abs(lg - (l.dimensions.radialGap as number))).toBeLessThanOrEqual(2e-5);
    const c = built(recipes.clevis({ d: 0.016, name: 'fork' }));
    expect(c.model.validate().issues).toEqual([]);
    const cg = gapOf(shaftIn(c, 0.08, -0.04), 'fork');
    expect(Math.abs(cg - (c.dimensions.radialGap as number))).toBeLessThanOrEqual(2e-5);
    expect(recipes.lug({ d: 0.016, e: 1.2 }).ok).toBe(false);
  });

  it('builds a bushing whose bore clears its shaft by the fit and refuses long sleeves', () => {
    const b = built(
      recipes.bushing({ d: 0.02, name: 'bush', flange: { diameter: 0.034, thickness: 0.003 } }),
    );
    expect(b.model.validate().issues).toEqual([]);
    // 18-30 mm H8/f7: hole 0..+33 um, shaft -20..-41 um, mid radial gap 23.5 um.
    expect(b.dimensions.radialGap).toBeCloseTo(23.5e-6, 12);
    const gap = gapOf(shaftIn(b, 0.03, -0.005), 'bush');
    expect(Math.abs(gap - (b.dimensions.radialGap as number))).toBeLessThanOrEqual(2e-5);
    expect(recipes.bushing({ d: 0.02, length: 0.05 }).ok).toBe(false);
  });

  it('builds a rod end whose ball keeps its clearance in the race at any tilt', {
    timeout: 120000,
  }, () => {
    const part = built(recipes.rodEnd({ d: 0.012, name: 're' }));
    const report = part.model.validate({ contacts: part.contacts ?? [] });
    expect(report.issues.map((i) => [i.code, i.severity])).toEqual([['designed-contact', 'info']]);
    expect(part.dimensions.tilt).toBeGreaterThan(5);
    const r = rig(part.model, {
      joints: [
        { name: 'eye', parent: null, position: [0, 0, 0] },
        { name: 'ball', parent: 'eye', position: [0, 0, 0], kind: 'spherical' },
      ],
    });
    r.bindRigid(sel.createdBy('re-housing'), 'eye', { part: 're-housing' });
    r.bindRigid(sel.createdBy('re-ball'), 'ball', { part: 're-ball' });
    const c = part.dimensions.clearance as number;
    for (const pose of [{}, { ball: { y: 37 } }, { ball: { x: 4, z: -3, y: 11 } }]) {
      const scan = r.scan({ keys: [{ u: 0, pose }] }, { clearance: 0.005 });
      if (!scan.ok) throw scan.error;
      const pair = scan.value.pairs[0];
      expect(pair?.status).toBe('clearance');
      expect(pair?.minDistance).toBeGreaterThan(c / 2 - 1e-9);
      if (Object.keys(pose).length === 0) {
        expect(Math.abs((pair?.minDistance as number) - c)).toBeLessThanOrEqual(2e-5);
      }
    }
  });
});

describe('pin joint recipes: declared ranges build clean parts', () => {
  const clean = (label: string, part: RecipePart) => {
    const report = part.model.validate({ contacts: part.contacts ?? [] });
    expect(
      report.issues.filter((i) => i.code !== 'designed-contact' || i.severity !== 'info'),
      label,
    ).toEqual([]);
    expect(report.closed, label).toBe(true);
    expect(part.model.toMesh({ normals: { mode: 'weighted' } }).ok, label).toBe(true);
  };

  it('sweeps size, fit, shape and retainer corners', { timeout: 600000 }, () => {
    const d = 0.02;
    const cases: [string, Parameters<typeof recipes.pinJoint>[0]][] = [
      ['d min', { d: 0.003 }],
      ['d max', { d: 0.18 }],
      ...(['H7/h6', 'H7/g6', 'H8/f7'] as const).map(
        (fit) => [fit, { d, fit }] as [string, Parameters<typeof recipes.pinJoint>[0]],
      ),
      ['e max', { d, lug: { e: 4 } }],
      ['thin lug', { d, lug: { thickness: 0.25 * d } }],
      ['thick lug', { d, lug: { thickness: 2 * d } }],
      ['thin wall', { d, wall: 0.25 * d }],
      ['thick wall', { d, wall: 1.5 * d }],
      ['no gap', { d, gap: 0 }],
      ['wide gap', { d, gap: 0.5 * d }],
      ['single bare', { d, shear: 'single', retainer: 'none' }],
    ];
    for (const [label, options] of cases) clean(label, built(recipes.pinJoint(options)));
    for (const d of [0.003, 0.18]) {
      clean(`bushing ${d}`, built(recipes.bushing({ d })));
      clean(`lug ${d}`, built(recipes.lug({ d })));
      clean(`clevis ${d}`, built(recipes.clevis({ d, shear: 'single' })));
    }
    for (const d of [0.003, 0.06]) clean(`rod end ${d}`, built(recipes.rodEnd({ d })));
  });
});
