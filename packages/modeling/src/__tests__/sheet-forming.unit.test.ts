import { describe, expect, it } from 'vitest';
import type { SheetMetalSpec } from '../sheet';
import { SHEET_MATERIALS, type SheetMaterial, sheetForming } from '../sheet-forming';

const rect = (x0: number, y0: number, x1: number, y1: number) =>
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const;

const thickness = 0.001;
const radius = 0.002;
const outline = { outer: rect(-0.02, 0, 0.02, 0.04) };

function specWith(
  options: {
    readonly thickness?: number;
    readonly radius?: number;
    readonly holes?: readonly (readonly [number, number])[];
  } = {},
): SheetMetalSpec {
  const t = options.thickness ?? thickness;
  const r = options.radius ?? radius;
  return {
    thickness: t,
    outline: options.holes === undefined ? outline : { ...outline, holes: [options.holes] },
    bends: [
      {
        line: [
          [0, 0],
          [0, 0.04],
        ],
        angle: 90,
        radius: r,
      },
    ],
  };
}

const ratio = (x: number) => 4 * x * x * x - 3 * x + 1;
const allowance = (angle: number, r: number, t: number, k = 0.44) =>
  (Math.abs(angle) * Math.PI * (r + k * t)) / 180;

function testMaterial(xAtReleasedRadius: number, t = thickness, r = radius): SheetMaterial {
  const youngsModulus = 1e9;
  return {
    name: 'forming test alloy',
    youngsModulus,
    yieldStrength: (xAtReleasedRadius * youngsModulus * t) / r,
    minBendRatio: 0.5,
  };
}

function report(spec = specWith(), material = SHEET_MATERIALS['mild-steel'], options = {}) {
  const result = sheetForming(spec, material, options);
  if (!result.ok) throw result.error;
  return result.value;
}

function issue(reportValue: ReturnType<typeof report>, code: string) {
  return reportValue.issues.find((entry) => entry.code === code);
}

describe('sheetForming', () => {
  it('solves the elastic recovery relation and round-trips the tool radius', () => {
    // t=1 mm, Rf=2 mm, E=210 GPa, Y=180 MPa: bisection gives x=0.001706,
    // Ri/Rf=0.9949; Ks=(2Ri/t+1)/(2Rf/t+1)=0.9959 (four significant digits).
    const material = SHEET_MATERIALS['mild-steel'];
    const result = report(specWith(), material);
    const bend = result.bends[0];
    expect(bend).toBeDefined();
    if (bend === undefined) throw new Error('expected a bend report');
    const x = (bend.toolRadius * material.yieldStrength) / (material.youngsModulus * thickness);
    const riOverRf = ratio(x);
    const expectedKs = ((2 * bend.toolRadius) / thickness + 1) / ((2 * radius) / thickness + 1);
    expect(x).toBeCloseTo(0.0017055, 7);
    expect(bend.toolRadius / radius).toBeCloseTo(0.9948835, 7);
    expect(bend.springback).toBeCloseTo(expectedKs, 14);
    expect(bend.springback).toBeCloseTo(0.9959068, 7);
    expect(bend.toolAngle).toBeCloseTo(90 / expectedKs, 12);
    expect(bend.minRadius).toBe(0.0005);
    expect(bend.allowance).toBeCloseTo(allowance(90, radius, thickness), 15);
    const releasedRadius = bend.toolRadius / riOverRf;
    expect(Math.abs(releasedRadius - radius) / radius).toBeLessThanOrEqual(1e-12);
  });

  it('decreases Ks as yield and radius rise, thickness and modulus fall', () => {
    const ks = (spec: SheetMetalSpec, material: SheetMaterial) =>
      report(spec, material).bends[0]?.springback;
    const base = testMaterial(0.04);
    const baseKs = ks(specWith(), base);
    expect(baseKs).toBeDefined();
    expect(ks(specWith(), { ...base, yieldStrength: base.yieldStrength * 2 })).toBeLessThan(
      baseKs as number,
    );
    expect(ks(specWith({ radius: radius * 2 }), base)).toBeLessThan(baseKs as number);
    expect(ks(specWith({ thickness: thickness / 2 }), base)).toBeLessThan(baseKs as number);
    expect(ks(specWith(), { ...base, youngsModulus: base.youngsModulus / 2 })).toBeLessThan(
      baseKs as number,
    );

    const equalYield = 180e6;
    const steel = {
      name: 'steel',
      youngsModulus: 210e9,
      yieldStrength: equalYield,
      minBendRatio: 0.5,
    };
    const aluminium = {
      name: 'aluminium',
      youngsModulus: 70e9,
      yieldStrength: equalYield,
      minBendRatio: 0.5,
    };
    expect(ks(specWith(), aluminium)).toBeLessThan(ks(specWith(), steel) as number);
  });

  it('reports a radius below the material minimum with the measured radius and limit', () => {
    const material = { ...SHEET_MATERIALS['mild-steel'], minBendRatio: 3 };
    const result = report(specWith(), material);
    expect(issue(result, 'bend-radius-below-minimum')).toMatchObject({
      severity: 'warn',
      detail: { bend: 0, radius, minimum: 0.003, point: [0, 0.02] },
    });
  });

  it('reports the shortest flange distance from each zone edge', () => {
    const minFlange = 19;
    const result = report(specWith(), SHEET_MATERIALS['mild-steel'], { minFlange });
    const findings = result.issues.filter((entry) => entry.code === 'flange-too-short');
    const halfZone = allowance(90, radius, thickness) / 2;
    expect(findings).toHaveLength(2);
    expect(findings[0]?.detail).toMatchObject({
      bend: 0,
      side: 'negative',
      length: expect.closeTo(0.02 - halfZone, 12),
      minimum: minFlange * thickness,
      point: [0.02, 0],
    });
    expect(findings[1]?.detail).toMatchObject({
      bend: 0,
      side: 'positive',
      length: expect.closeTo(0.02 - halfZone, 12),
      minimum: minFlange * thickness,
      point: [-0.02, 0],
    });
  });

  it('reports the nearest hole edge distance from the bend zone', () => {
    const halfZone = allowance(90, radius, thickness) / 2;
    const nearestHoleEdge = halfZone + 0.0007;
    const hole = rect(-nearestHoleEdge - 0.0004, 0.01, -nearestHoleEdge, 0.02);
    const result = report(specWith({ holes: hole }), SHEET_MATERIALS['mild-steel']);
    expect(issue(result, 'hole-near-bend')).toMatchObject({
      severity: 'warn',
      detail: {
        bend: 0,
        hole: 0,
        distance: expect.closeTo(0.0007, 12),
        minimum: expect.closeTo(0.0045, 12),
        point: expect.any(Array),
      },
    });

    const crossingHole = rect(-0.004, 0.01, 0.004, 0.02);
    const crossingResult = report(specWith({ holes: crossingHole }), SHEET_MATERIALS['mild-steel']);
    expect(issue(crossingResult, 'hole-near-bend')?.detail).toMatchObject({
      distance: 0,
      minimum: expect.closeTo(0.0045, 12),
    });
  });

  it('reports tool-angle compensation above the configured limit', () => {
    const material = testMaterial(0.05);
    const result = report(specWith(), material, { minFlange: 10, maxSpringback: 5 });
    const bend = result.bends[0];
    expect(bend).toBeDefined();
    if (bend === undefined) throw new Error('expected a bend report');
    const correction = Math.abs(bend.toolAngle - bend.angle);
    expect(issue(result, 'springback-large')).toMatchObject({
      severity: 'warn',
      detail: {
        bend: 0,
        angleCorrection: correction,
        maximum: 5,
        toolAngle: bend.toolAngle,
        angle: 90,
        point: [0, 0.02],
      },
    });
    expect(correction).toBeGreaterThan(5);
  });

  it('passes a clean spec and uses all four forming checks', () => {
    const result = report(specWith(), testMaterial(0.001));
    expect(result).toMatchObject({ pass: true, material: 'forming test alloy', issues: [] });
    expect(result.bends[0]).toMatchObject({ index: 0, angle: 90, radius, minRadius: 0.0005 });
  });

  it('provides complete frozen room-temperature material presets', () => {
    expect(Object.isFrozen(SHEET_MATERIALS)).toBe(true);
    expect(Object.keys(SHEET_MATERIALS).sort()).toEqual([
      'aluminium-5xxx',
      'aluminium-6xxx',
      'high-strength-steel',
      'mild-steel',
      'stainless-304',
    ]);
    expect(Object.values(SHEET_MATERIALS).every(Object.isFrozen)).toBe(true);
    expect(SHEET_MATERIALS['mild-steel']).toMatchObject({
      youngsModulus: 210e9,
      yieldStrength: 180e6,
      minBendRatio: 0.5,
    });
    expect(SHEET_MATERIALS['high-strength-steel']).toMatchObject({
      youngsModulus: 210e9,
      yieldStrength: 420e6,
      minBendRatio: 1.5,
    });
    expect(SHEET_MATERIALS['aluminium-5xxx']).toMatchObject({
      youngsModulus: 70e9,
      yieldStrength: 130e6,
      minBendRatio: 1,
    });
    expect(SHEET_MATERIALS['aluminium-6xxx']).toMatchObject({
      youngsModulus: 70e9,
      yieldStrength: 120e6,
      minBendRatio: 1,
    });
    expect(SHEET_MATERIALS['stainless-304']).toMatchObject({
      youngsModulus: 193e9,
      yieldStrength: 215e6,
      minBendRatio: 0.5,
    });
    expect(
      Object.values(SHEET_MATERIALS).every((material) => material.name.includes('typical values')),
    ).toBe(true);
  });

  it.each([
    ['null spec', null, SHEET_MATERIALS['mild-steel'], undefined, 'model-invalid-argument'],
    [
      'invalid thickness',
      { ...specWith(), thickness: 0 },
      SHEET_MATERIALS['mild-steel'],
      undefined,
      'model-invalid-argument',
    ],
    ['null material', specWith(), null, undefined, 'model-invalid-argument'],
    [
      'blank material name',
      specWith(),
      { ...SHEET_MATERIALS['mild-steel'], name: '  ' },
      undefined,
      'model-invalid-argument',
    ],
    [
      'invalid Young modulus',
      specWith(),
      { ...SHEET_MATERIALS['mild-steel'], youngsModulus: Infinity },
      undefined,
      'model-invalid-argument',
    ],
    [
      'invalid yield strength',
      specWith(),
      { ...SHEET_MATERIALS['mild-steel'], yieldStrength: 0 },
      undefined,
      'model-invalid-argument',
    ],
    [
      'invalid minimum ratio',
      specWith(),
      { ...SHEET_MATERIALS['mild-steel'], minBendRatio: Number.NaN },
      undefined,
      'model-invalid-argument',
    ],
    ['null options', specWith(), SHEET_MATERIALS['mild-steel'], null, 'model-invalid-argument'],
    [
      'negative flange multiplier',
      specWith(),
      SHEET_MATERIALS['mild-steel'],
      { minFlange: -1 },
      'model-invalid-argument',
    ],
    [
      'non-finite flange multiplier',
      specWith(),
      SHEET_MATERIALS['mild-steel'],
      { minFlange: Infinity },
      'model-invalid-argument',
    ],
    [
      'malformed hole-clearance pair',
      specWith(),
      SHEET_MATERIALS['mild-steel'],
      { holeClearance: [2] },
      'model-invalid-argument',
    ],
    [
      'negative hole-clearance coefficient',
      specWith(),
      SHEET_MATERIALS['mild-steel'],
      { holeClearance: [2, -1] },
      'model-invalid-argument',
    ],
    [
      'non-finite maximum springback',
      specWith(),
      SHEET_MATERIALS['mild-steel'],
      { maxSpringback: Number.NaN },
      'model-invalid-argument',
    ],
  ])('returns a structured invalid-argument error for %s', (_name, spec, material, options, code) => {
    const result = sheetForming(
      spec as SheetMetalSpec,
      material as SheetMaterial,
      options as Parameters<typeof sheetForming>[2],
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a validation error');
    expect(result.error.code).toBe(code);
  });

  it('returns model-precondition when the material range reaches x >= 0.5', () => {
    const result = sheetForming(specWith(), {
      name: 'out-of-range material',
      youngsModulus: 1e9,
      yieldStrength: 1e9,
      minBendRatio: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a physical-range precondition error');
    expect(result.error.code).toBe('model-precondition');
    expect(result.error.detail).toMatchObject({ bend: 0, maximumX: 0.5 });
  });
});
