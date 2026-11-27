import { describe, expect, it } from 'vitest';

const fail = (): never => {
  throw new Error('tier emitted no field');
};
const fieldOf = (gi: StandardDiffuseGi | undefined) =>
  gi !== undefined && 'field' in gi ? gi.field : fail();

import { freezeRenderProfile, validateRenderProfile } from '../../assembly/renderer-facade';
import { DEFAULT_STANDARD_PROFILE, type StandardDiffuseGi } from '../../pipeline/standard-profile';
import {
  DIFFUSE_GI_TIER_BUDGETS,
  DIFFUSE_GI_TIERS,
  type DiffuseGiTierScene,
  parseDiffuseGiTier,
  resolveDiffuseGiTier,
} from '../../raytracing/diffuse-gi-tier';
import { planIrradianceField } from '../../raytracing/irradiance-field-plan';

const scene: DiffuseGiTierScene = {
  maxDistance: 40,
  environment: [0.1, 0.2, 0.3],
  region: {
    grid: {
      origin: [-4, -4, -4],
      dimensions: [33, 33, 33],
      spacing: 0.25,
      maxDistance: 2,
      coverageDistance: 0.25,
    },
    maxInstances: 64,
    maxFieldBytes: 16 * 1024 * 1024,
  },
  probeSpacing: 0.75,
};
const gpu = { compute: true, storageBuffer: true, backendKind: 'webgpu' } as const;

describe('diffuse GI quality tiers', () => {
  it('maps the closed ladder to lanes with monotonically growing budgets', () => {
    const lanes = DIFFUSE_GI_TIERS.map((tier) => resolveDiffuseGiTier(tier, scene, gpu).unwrap());
    expect(lanes.map((r) => r.lane)).toEqual([
      'direct-ibl-ssao',
      'irradiance-field',
      'screen-probe',
      'screen-probe',
    ]);
    expect(lanes.every((r) => r.fallback === undefined)).toBe(true);
    expect(lanes[0]?.profile).toEqual({
      renderPath: 'deferred',
      pbr: true,
      ibl: true,
      ambientOcclusion: { enabled: true },
    });
    const fields = (['medium', 'high', 'epic'] as const).map(
      (tier) => DIFFUSE_GI_TIER_BUDGETS[tier].field,
    );
    for (const key of ['raysPerProbe', 'cardBudget'] as const) {
      const values = fields.map((field) => field?.[key] ?? 0);
      expect(values[0]).toBeLessThan(values[1] ?? 0);
      expect(values[1]).toBeLessThan(values[2] ?? 0);
    }
  });

  it('applies the aligned Lumen settings without overriding authored Card texel density', () => {
    const framing = { ...scene, cardResolution: 32 };
    const medium = resolveDiffuseGiTier('medium', framing, gpu).unwrap().profile.diffuseGi;
    const high = resolveDiffuseGiTier('high', framing, gpu).unwrap().profile.diffuseGi;
    const epic = resolveDiffuseGiTier('epic', framing, gpu).unwrap().profile.diffuseGi;
    expect([medium, high, epic].map((gi) => fieldOf(gi).probeBudget)).toEqual([100, 100, 150]);
    expect(fieldOf(medium).radiosity).toBe(true);
    expect(fieldOf(high).cards).toMatchObject({
      resolution: 32,
      radiosity: { probeSpacing: 8, hemisphereResolution: 3, updateFactor: 128 },
    });
    expect(fieldOf(epic).cards.radiosity).toEqual({
      probeSpacing: 4,
      hemisphereResolution: 4,
      updateFactor: 64,
    });
    expect(DIFFUSE_GI_TIER_BUDGETS.high.probes).toMatchObject({
      downsample: 32,
      adaptiveFraction: 0.5,
      adaptiveCandidates: 16,
      screenTrace: { maxSteps: 50, thickness: 0.02 },
      filterPasses: 3,
      irradiance: 'probe-octahedral',
      integration: 'screen-space',
      interpolation: 'stochastic',
      shortRangeAoMode: 'half-scalar',
      maxFrames: 10,
    });
    expect(DIFFUSE_GI_TIER_BUDGETS.epic.probes?.downsample).toBe(16);
    expect(DIFFUSE_GI_TIER_BUDGETS.epic.probes?.adaptiveCandidates).toBe(8);
    expect(DIFFUSE_GI_TIER_BUDGETS.epic.probes).toMatchObject({
      irradiance: 'probe-sh3',
      integration: 'screen-space',
      shortRangeAoMode: 'full-bent',
    });
    expect(Object.isFrozen(fieldOf(high).cards.radiosity)).toBe(true);
  });

  it('defaults the Card capture ceiling to the planner maximum', () => {
    const captureBytes = (value?: number) =>
      resolveDiffuseGiTier(
        'medium',
        value === undefined ? scene : { ...scene, maxCaptureBytes: value },
        gpu,
      ).unwrap().profile.diffuseGi;
    expect(fieldOf(captureBytes()).cards?.maxCaptureBytes).toBe(256 * 1024 * 1024);
    expect(fieldOf(captureBytes(8 * 1024 * 1024)).cards?.maxCaptureBytes).toBe(8 * 1024 * 1024);
  });

  it('folds clipmap levels and per-level budgets into each tier budget', () => {
    const fixed = resolveDiffuseGiTier('high', scene, gpu).unwrap().profile.diffuseGi;
    expect(fieldOf(fixed).clipmap).toBeUndefined();
    const followed = { ...scene, clipmapDimensions: [8, 4, 8] as const };
    const levels = (['medium', 'high', 'epic'] as const).map((tier) => {
      const gi = resolveDiffuseGiTier(tier, followed, gpu).unwrap().profile.diffuseGi;
      const field = fieldOf(gi);
      expect(field.clipmap?.dimensions).toEqual([8, 4, 8]);
      const plan = planIrradianceField(field).unwrap();
      const budget = DIFFUSE_GI_TIER_BUDGETS[tier].field?.probeBudget;
      // The tier probe budget is the frame total; each level keeps a non-empty share.
      expect(plan.levelBudgets.reduce((n, b) => n + b, 0)).toBe(budget);
      expect(plan.levelBudgets.every((b) => b > 0)).toBe(true);
      expect(plan.probeCount).toBe(plan.levels * 8 * 4 * 8);
      return plan.levels;
    });
    expect(levels).toEqual([2, 3, 4]);
  });

  it('emits profiles the Renderer accepts unchanged', () => {
    for (const tier of DIFFUSE_GI_TIERS) {
      const { profile } = resolveDiffuseGiTier(tier, scene, gpu).unwrap();
      expect(profile.ibl).toBe(true);
      const merged = { ...DEFAULT_STANDARD_PROFILE, ...profile };
      expect(validateRenderProfile(merged)).toBeUndefined();
      expect(freezeRenderProfile(merged).diffuseGi).toEqual(profile.diffuseGi);
      if (profile.diffuseGi !== undefined) expect(Object.isFrozen(profile.diffuseGi)).toBe(true);
    }
  });

  it('demotes GI tiers to direct + IBL as data when capabilities are missing', () => {
    const cases = [
      [{ ...gpu, compute: false }, 'compute-unavailable'],
      [{ ...gpu, storageBuffer: false }, 'storage-buffer-unavailable'],
      [{ compute: true, storageBuffer: true, backendKind: 'wgpu-webgl2' }, 'webgl2-backend'],
    ] as const;
    for (const [caps, reason] of cases)
      for (const tier of ['medium', 'high', 'epic'] as const) {
        const resolved = resolveDiffuseGiTier(tier, scene, caps).unwrap();
        expect(resolved.lane).toBe('direct-ibl');
        expect(resolved.fallback?.reason).toBe(reason);
        expect(resolved.profile).toEqual({
          renderPath: 'deferred',
          pbr: true,
          ibl: true,
          ambientOcclusion: { enabled: false },
        });
        expect(validateRenderProfile({ ...DEFAULT_STANDARD_PROFILE, ...resolved.profile })).toBe(
          undefined,
        );
      }
    expect(
      resolveDiffuseGiTier('low', scene, { ...gpu, compute: false }).unwrap().fallback,
    ).toBeUndefined();
  });

  it('rejects scene framing the field planner rejects and parses only the closed set', () => {
    const bad = resolveDiffuseGiTier('medium', { ...scene, probeSpacing: 0.01 }, gpu);
    expect(bad.ok).toBe(false);
    expect(parseDiffuseGiTier('epic')).toBe('epic');
    expect(parseDiffuseGiTier('ultra')).toBeUndefined();
    expect(parseDiffuseGiTier(null)).toBeUndefined();
  });
});
