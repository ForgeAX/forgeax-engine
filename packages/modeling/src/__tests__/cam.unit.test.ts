import { describe, expect, it } from 'vitest';
import { recipes } from '../recipes';
import { cycloidal } from '../recipes/cam';
import { corners, expectClean } from './recipe-contract';

const BASE = 0.03;
const LIFT = 0.008;
const DEFAULT = {
  baseRadius: BASE,
  lift: LIFT,
  motionShare: 0.35,
  width: 0.01,
  follower: 'roller' as const,
  rollerRadius: 0.004,
};

function part(r: ReturnType<typeof recipes.cam>) {
  if (!r.ok) throw r.error;
  return r.value;
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw r.error;
  return r.value;
}

describe('recipes.cam', () => {
  it('builds a closed clean roller cam at default options', () => {
    const p = expectClean('cam default', recipes.cam(DEFAULT));
    expect(p.dimensions.maxPressureAngle).toBeGreaterThan(0);
    expect(p.dimensions.maxPressureAngle).toBeLessThan(30);
    expect(p.dimensions.minCurvature).toBeGreaterThan(DEFAULT.rollerRadius);
    expect(p.anchors.hub).toEqual([0, 0, 0]);
  });

  it('builds a clean flat-faced cam', () => {
    const p = expectClean(
      'cam flat',
      recipes.cam({
        baseRadius: BASE,
        lift: LIFT,
        motionShare: 0.35,
        width: 0.01,
        follower: 'flat',
      }),
    );
    expect(p.dimensions.minCurvature).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = unwrap(part(recipes.cam(DEFAULT)).model.toMesh());
    const b = unwrap(part(recipes.cam(DEFAULT)).model.toMesh());
    expect(a?.mesh).toEqual(b?.mesh);
  });

  it('stays clean across the declared corners', () => {
    for (const options of corners(DEFAULT, { motionShare: [0.2, 0.45], width: [0.002, 0.02] })) {
      expectClean(`cam ${JSON.stringify(options)}`, recipes.cam(options));
    }
  });

  it('matches the cycloidal lift at 36 angles, with derivative equal to finite differences', () => {
    const d = 0.35;
    const h = 1e-6;
    for (let k = 0; k < 36; k++) {
      const t = k / 36;
      const law = cycloidal(t, d);
      const s = law.s;
      const fd = (cycloidal(t + h, d).s - cycloidal(t - h, d).s) / (2 * h);
      expect(Math.abs(law.v - fd)).toBeLessThan(1e-5);
      expect(s).toBeGreaterThanOrEqual(-1e-12);
      expect(s).toBeLessThanOrEqual(1 + 1e-12);
    }
    expect(cycloidal(0, d).s).toBeCloseTo(0, 12);
    expect(cycloidal(0.5, d).s).toBeCloseTo(1, 12);
    expect(cycloidal(0.5 + d, d).s).toBeCloseTo(0, 12);
  });

  it('rejects a roller undercut with model-invalid-argument', () => {
    const r = recipes.cam({ ...DEFAULT, rollerRadius: 0.03 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('rejects a pressure angle above maxPressureAngle', () => {
    const r = recipes.cam({ ...DEFAULT, maxPressureAngle: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('model-invalid-argument');
      expect(r.error.message).toMatch(/pressure angle/);
    }
  });

  it('rejects a roller follower without rollerRadius', () => {
    const { rollerRadius: _omit, ...rest } = DEFAULT;
    const r = recipes.cam(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('falsifier: a linear rise fails the derivative check the cycloidal law passes', () => {
    const d = 0.35;
    const h = 1e-6;
    const linearV = 1 / d;
    let worst = 0;
    for (let k = 0; k < 36; k++) {
      const t = (k / 36) * d;
      if (t <= 0 || t >= d) continue;
      const fd = (cycloidal(t + h, d).s - cycloidal(t - h, d).s) / (2 * h);
      worst = Math.max(worst, Math.abs(linearV - fd));
    }
    expect(worst).toBeGreaterThan(1e-3);
  });
});

describe('recipes.camFollowerGuide', () => {
  const GUIDE = {
    baseRadius: BASE,
    lift: LIFT,
    rollerRadius: 0.004,
    stemRadius: 0.002,
    clearance: 0.00005,
    stemLength: 0.02,
    guideStart: 0.0425,
    guideLength: 0.008,
    guideHalfWidth: 0.004,
  };

  it('builds a stem and guide with the clearance stated as a dimension', () => {
    const p = expectClean('cam guide', recipes.camFollowerGuide(GUIDE));
    expect(p.dimensions.clearance).toBe(GUIDE.clearance);
    expect(p.dimensions.boreRadius).toBeCloseTo(GUIDE.stemRadius + GUIDE.clearance, 12);
    expect(p.dimensions.stopMargin).toBeGreaterThan(0);
    expect(p.contacts?.[0]?.gap?.[0]).toBeGreaterThan(0);
  });

  it('refuses a guide too narrow for its bore', () => {
    const r = recipes.camFollowerGuide({ ...GUIDE, guideHalfWidth: 0.001 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('refuses a stem that does not reach the guide at rest', () => {
    const r = recipes.camFollowerGuide({ ...GUIDE, stemLength: 0.001 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });
});
