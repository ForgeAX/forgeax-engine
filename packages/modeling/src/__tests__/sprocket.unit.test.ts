import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { recipes } from '../recipes';
import { arcSegments, chainClosure, chainDrive, chainPlacements } from '../recipes/sprocket';
import { corners, expectClean } from './recipe-contract';

type SprocketDims = {
  pitchDiameter: number;
  tipDiameter: number;
  rootDiameter: number;
  seatRadius: number;
};

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

const PITCH = 0.01;
const DEFAULT = { teeth: 12, pitch: PITCH, width: 0.006 };

function part(r: ReturnType<typeof recipes.sprocket>) {
  if (!r.ok) throw r.error;
  return r.value;
}

describe('recipes.sprocket', () => {
  it('builds a closed clean sprocket at default options', () => {
    const p = expectClean('sprocket default', recipes.sprocket(DEFAULT));
    const d = part(recipes.sprocket(DEFAULT)).dimensions as SprocketDims;
    expect(p.anchors.hub).toEqual([0, 0, 0]);
    expect(d.pitchDiameter / 2).toBeCloseTo(PITCH / (2 * Math.sin(Math.PI / 12)), 12);
    expect(d.seatRadius).toBeCloseTo(0.505 * 0.5 * PITCH, 12);
  });

  it('is deterministic', () => {
    const a = unwrap(part(recipes.sprocket(DEFAULT)).model.toMesh());
    const b = unwrap(part(recipes.sprocket(DEFAULT)).model.toMesh());
    expect(a.mesh).toEqual(b.mesh);
  });

  it('stays clean across the declared corners', () => {
    for (const options of corners(DEFAULT, { teeth: [6, 40], width: [0.002, 0.02] })) {
      expectClean(`sprocket ${JSON.stringify(options)}`, recipes.sprocket(options));
    }
  });

  it('rejects an out-of-range tooth count with model-invalid-argument', () => {
    const r = recipes.sprocket({ ...DEFAULT, teeth: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('rejects a roller above its declared pitch share', () => {
    const r = recipes.sprocket({ ...DEFAULT, rollerDiameter: 0.7 * PITCH });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('uses the ISO 606 closed-form dimensions for z=12 and z=18 at d1 = 0.5 p', () => {
    for (const teeth of [12, 18]) {
      const d = part(recipes.sprocket({ teeth, pitch: PITCH, width: 0.006 })).dimensions;
      const pitch = PITCH / Math.sin(Math.PI / teeth);
      const roller = 0.5 * PITCH;
      const tipDiameter = pitch + ((1 - 1.6 / teeth + 1.25) / 2) * PITCH - roller;
      const flank = Math.sqrt(
        0.12 * roller * (teeth + 2) * (0.008 * roller * (teeth * teeth + 180)),
      );
      expect(d.pitchDiameter).toBeCloseTo(pitch, 12);
      expect(d.tipDiameter).toBeCloseTo(tipDiameter, 12);
      expect(d.seatRadius).toBeCloseTo(0.505 * roller, 12);
      expect(d.flankRadius).toBeCloseTo(flank, 12);
      expect(d.rootDiameter).toBeCloseTo(pitch - 2 * 0.505 * roller, 12);
    }
  });

  it('places the tip circle a closed-form distance outside the pitch circle', () => {
    const d = part(recipes.sprocket(DEFAULT)).dimensions as SprocketDims;
    const tipRise = ((1 - 1.6 / 12 + 1.25) / 4) * PITCH - (0.5 * PITCH) / 2;
    expect(d.tipDiameter / 2 - d.pitchDiameter / 2).toBeCloseTo(tipRise, 12);
    expect(d.tipDiameter / 2 - d.pitchDiameter / 2).toBeGreaterThan(0);
  });

  it('samples every flank and tip arc within 2 um of its chords', () => {
    for (const radius of [0.0104, 0.0195, 0.0225]) {
      const n = arcSegments(2 * Math.PI, radius);
      const sag = radius * (1 - Math.cos(Math.PI / n));
      expect(sag, `radius ${radius}`).toBeLessThan(2e-6);
    }
  });

  it('refuses a 5-tooth sprocket that cannot seat a 0.6-pitch roller', () => {
    const r = recipes.sprocket({ ...DEFAULT, teeth: 5, rollerDiameter: 0.6 * PITCH });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});

describe('recipes.chainLink', () => {
  it('builds outer and inner links that validate clean', () => {
    const outer = expectClean(
      'outer link',
      recipes.chainLink({ pitch: PITCH, kind: 'outer', width: 0.008 }),
    );
    const inner = expectClean(
      'inner link',
      recipes.chainLink({ pitch: PITCH, kind: 'inner', width: 0.012 }),
    );
    expect(outer.anchors.pinA).toEqual([-PITCH / 2, 0, 0]);
    expect(inner.anchors.pinB).toEqual([PITCH / 2, 0, 0]);
    expect(inner.contacts?.length).toBe(4);
  });

  it('is deterministic', () => {
    const opts = { pitch: PITCH, kind: 'inner' as const, width: 0.012 };
    const a = unwrap(part(recipes.chainLink(opts)).model.toMesh());
    const b = unwrap(part(recipes.chainLink(opts)).model.toMesh());
    expect(a.mesh).toEqual(b.mesh);
  });

  it('rejects a link too narrow for its plates', () => {
    const r = recipes.chainLink({ pitch: PITCH, kind: 'inner', width: 0.001 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});

describe('chainPlacements', () => {
  it('closes the pitch polygon to 1e-9 for a closed chain', () => {
    for (const links of [6, 12, 24]) {
      const r = chainPlacements({ links, pitch: PITCH });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(chainClosure(r.value)).toBeLessThan(1e-9);
    }
  });

  it('keeps non-adjacent links apart by more than a plate height', () => {
    const r = chainPlacements({ links: 12, pitch: PITCH });
    if (!r.ok) throw r.error;
    const plateHeight = 0.6 * PITCH;
    for (let i = 0; i < r.value.length; i++) {
      for (let j = i + 2; j < r.value.length; j++) {
        if ((j + 1) % r.value.length === i) continue;
        const a = r.value[i]?.center as [number, number, number];
        const b = r.value[j]?.center as [number, number, number];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        expect(d).toBeGreaterThan(plateHeight);
      }
    }
  });

  it('keeps every link pitch at 0.01 m to within 1e-6 m', () => {
    const r = chainPlacements({ links: 12, pitch: PITCH });
    if (!r.ok) throw r.error;
    for (const link of r.value) {
      const d = Math.hypot(link.pinB[0] - link.pinA[0], link.pinB[1] - link.pinA[1]);
      expect(Math.abs(d - PITCH), `link ${link.index}`).toBeLessThan(1e-6);
    }
  });

  it('seats each wrapped roller centre on its sprocket seat centre within 0.02 mm', () => {
    const teeth = 12;
    const r = chainPlacements({ links: teeth, pitch: PITCH });
    if (!r.ok) throw r.error;
    const pitchRadius = PITCH / (2 * Math.sin(Math.PI / teeth));
    for (const link of r.value) {
      const a = (2 * Math.PI * link.index) / teeth;
      const seatCentre = [pitchRadius * Math.cos(a), pitchRadius * Math.sin(a)] as const;
      const gap = Math.hypot(link.pinA[0] - seatCentre[0], link.pinA[1] - seatCentre[1]);
      expect(gap, `link ${link.index}`).toBeLessThan(2e-5);
    }
  });

  it('detects a deliberately wrong placement', () => {
    const r = chainPlacements({ links: 12, pitch: PITCH });
    if (!r.ok) throw r.error;
    const bad = r.value.map((link, k) =>
      k === 3 ? { ...link, pinB: [link.pinB[0] * 1.05, link.pinB[1], 0] as Tuple3 } : link,
    );
    expect(chainClosure(bad)).toBeGreaterThan(1e-6);
  });
});

describe('chainDrive', () => {
  const DRIVE = { teethA: 12, teethB: 18, links: 40, pitch: PITCH };

  it('closes a 40-link drive between 12 and 18 teeth with pins on both pitch circles', () => {
    const r = chainDrive(DRIVE);
    if (!r.ok) throw r.error;
    const v = r.value;
    expect(v.placements.length).toBe(40);
    expect(chainClosure(v.placements)).toBeLessThan(1e-9);
    for (const link of v.placements) {
      const d = Math.hypot(link.pinB[0] - link.pinA[0], link.pinB[1] - link.pinA[1]);
      expect(Math.abs(d - PITCH), `link ${link.index}`).toBeLessThan(1e-6);
    }
  });

  it('centre distance is the closed form with run k = 12 and sits near the standard formula', () => {
    const r = chainDrive(DRIVE);
    if (!r.ok) throw r.error;
    const pitchRadiusA = PITCH / (2 * Math.sin(Math.PI / 12));
    const pitchRadiusB = PITCH / (2 * Math.sin(Math.PI / 18));
    expect(r.value.runPitches).toBe(11);
    expect(r.value.pitchRadiusA).toBeCloseTo(pitchRadiusA, 12);
    expect(r.value.pitchRadiusB).toBeCloseTo(pitchRadiusB, 12);
    expect(r.value.centreDistance / PITCH).toBeCloseTo(12.404314, 5);
    expect(Math.abs(r.value.centreDistance / PITCH - 12.463417)).toBeLessThan(0.1);
  });

  it('places every wrap pin on its sprocket pitch circle; run pins lie on the chords', () => {
    const r = chainDrive(DRIVE);
    if (!r.ok) throw r.error;
    const { placements, centreDistance, pitchRadiusA, pitchRadiusB, runPitches: k } = r.value;
    const n = placements.length;
    const b = 5;
    const wrapA = [0, ...Array.from({ length: n - (2 * k + 2 * b) }, (_, i) => 2 * k + 2 * b + i)];
    const wrapB = Array.from({ length: 2 * b + 1 }, (_, i) => k + i);
    for (const i of wrapA) {
      const link = placements[i];
      expect(
        Math.abs(Math.hypot(link?.pinA[0] ?? NaN, link?.pinA[1] ?? NaN) - pitchRadiusA),
        `A pin ${i}`,
      ).toBeLessThan(1e-9);
    }
    for (const i of wrapB) {
      const link = placements[i];
      const d = Math.hypot((link?.pinA[0] ?? NaN) - centreDistance, link?.pinA[1] ?? NaN);
      expect(Math.abs(d - pitchRadiusB), `B pin ${i}`).toBeLessThan(1e-9);
    }
  });

  it('refuses an odd link count for an even run with model-invalid-argument', () => {
    const r = chainDrive({ ...DRIVE, links: 41 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});
