import { describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../../assembly/renderer-facade';
import {
  DEFAULT_STANDARD_PROFILE,
  type StandardIrradianceFieldGi,
  type StandardProfile,
} from '../../pipeline/standard-profile';
import {
  IRRADIANCE_FIELD_MAX_PROBES,
  IRRADIANCE_FIELD_RADIOSITY_PERIOD,
  IRRADIANCE_FIELD_RELIGHT_SWEEPS,
  irradianceFieldRadiosityPeriod,
  irradianceFieldRelightHysteresis,
  planIrradianceField,
  validateDiffuseGi,
} from '../../raytracing/irradiance-field-plan';

const field: StandardIrradianceFieldGi['field'] = {
  region: {
    grid: {
      origin: [-4, -4, -4],
      dimensions: [33, 33, 33],
      spacing: 0.25,
      maxDistance: 2,
      coverageDistance: 1,
    },
    maxInstances: 64,
    maxFieldBytes: 16 * 1024 * 1024,
  },
  probeSpacing: 1,
  raysPerProbe: 64,
  probeBudget: 32,
  hysteresis: 0.9,
  cards: { resolution: 32, maxCaptureBytes: 8 * 1024 * 1024, budget: 64 },
  resolution: 'half',
  radiosity: true,
};
const gi: StandardIrradianceFieldGi = {
  gather: 'irradiance-field',
  maxDistance: 100,
  environment: [0.1, 0.2, 0.3],
  field,
};

describe('irradiance field plan', () => {
  it('derives a probe lattice one region sample inside the composed border', () => {
    const plan = planIrradianceField(field);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Interior extent (33 - 3) * 0.25 = 7.5 -> 8 probes at spacing 1.
    expect(plan.value.dimensions).toEqual([8, 8, 8]);
    expect(plan.value.origin).toEqual([-3.75, -3.75, -3.75]);
    expect(plan.value.probeCount).toBe(512);
    expect(plan.value.probeBudget).toBe(32);
    expect(plan.value.querySettings.byteLength).toBeGreaterThan(0);
    const clamped = planIrradianceField({ ...field, probeBudget: 4096 });
    expect(clamped.ok && clamped.value.probeBudget).toBe(512);
  });

  it('rejects every unbounded or unknown field with one structured failure', () => {
    for (const invalid of [
      { ...field, probeSpacing: 0.1 },
      { ...field, raysPerProbe: 8 },
      { ...field, raysPerProbe: 512 },
      { ...field, probeBudget: 0 },
      { ...field, hysteresis: 1 },
      { ...field, hysteresis: -0.1 },
      { ...field, resolution: 'quarter' },
      { ...field, radiosity: 1 },
      { ...field, cards: { ...field.cards, budget: 0 } },
      { ...field, cards: { ...field.cards, resolution: 4 } },
      { ...field, cards: { resolution: 32, maxCaptureBytes: 1 } },
      { ...field, probeSpacing: 100 },
      { ...field, extra: true },
      { ...field, region: { ...field.region, maxInstances: 0 } },
      { ...field, region: { ...field.region, grid: { ...field.region.grid, spacing: -1 } } },
    ]) {
      const plan = planIrradianceField(invalid as unknown as typeof field);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error.code).toBeTypeOf('string');
    }
    const dense = planIrradianceField({
      ...field,
      region: {
        ...field.region,
        grid: { ...field.region.grid, dimensions: [128, 128, 128], spacing: 0.25 },
      },
      probeSpacing: 0.25,
    });
    expect(dense.ok).toBe(false);
    expect(IRRADIANCE_FIELD_MAX_PROBES).toBe(32768);
  });

  it('keeps the gather selector closed', () => {
    expect(validateDiffuseGi(gi).ok).toBe(true);
    expect(validateDiffuseGi({ ...gi, gather: 'screen-probe' } as never).ok).toBe(false);
    expect(validateDiffuseGi({ ...gi, maxBounces: 1 } as never).ok).toBe(false);
    expect(validateDiffuseGi({ ...gi, environment: [0, -1, 0] }).ok).toBe(false);
  });

  it('validates and deep-freezes the profile', () => {
    const profile: StandardProfile = {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: 'deferred',
      ibl: false,
      diffuseGi: gi,
    };
    expect(validateRenderProfile(profile)).toBeUndefined();
    expect(validateRenderProfile({ ...profile, ibl: true })).toContain('IBL disabled');
    const frozen = freezeRenderProfile(profile).diffuseGi;
    expect(frozen?.gather).toBe('irradiance-field');
    if (frozen?.gather !== 'irradiance-field') return;
    expect(Object.isFrozen(frozen.field.region.grid.origin)).toBe(true);
    expect(Object.isFrozen(frozen.field.cards)).toBe(true);
    expect(frozen.field.region.grid.origin).not.toBe(field.region.grid.origin);
  });
});

describe('irradianceFieldRelightHysteresis', () => {
  const plan = { hysteresis: 0.7, probeCount: 100 };
  it('drops history for four lattice sweeps after a Card relight, then restores it', () => {
    expect(IRRADIANCE_FIELD_RELIGHT_SWEEPS).toEqual([0.25, 0.25, 0.5, 0.5]);
    expect(irradianceFieldRelightHysteresis(plan, 0)).toBe(0.25);
    expect(irradianceFieldRelightHysteresis(plan, 199)).toBe(0.25);
    expect(irradianceFieldRelightHysteresis(plan, 200)).toBe(0.5);
    expect(irradianceFieldRelightHysteresis(plan, 399)).toBe(0.5);
    expect(irradianceFieldRelightHysteresis(plan, 400)).toBe(0.7);
  });
  it('never raises a configured hysteresis below the reset values', () => {
    expect(irradianceFieldRelightHysteresis({ hysteresis: 0.1, probeCount: 100 }, 0)).toBe(0.1);
    expect(irradianceFieldRelightHysteresis({ hysteresis: 0.4, probeCount: 100 }, 250)).toBe(0.4);
  });
});

describe('irradianceFieldRadiosityPeriod', () => {
  it('re-gathers every tile at least once per probe sweep, at most every period frames', () => {
    expect(IRRADIANCE_FIELD_RADIOSITY_PERIOD).toBe(4);
    expect(irradianceFieldRadiosityPeriod({ probeCount: 2048, probeBudget: 128 })).toBe(4);
    expect(irradianceFieldRadiosityPeriod({ probeCount: 384, probeBudget: 128 })).toBe(3);
    expect(irradianceFieldRadiosityPeriod({ probeCount: 100, probeBudget: 128 })).toBe(1);
    expect(irradianceFieldRadiosityPeriod({ probeCount: 100, probeBudget: 0 })).toBe(4);
  });
});
