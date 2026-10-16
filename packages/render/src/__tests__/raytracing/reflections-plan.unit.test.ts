import { readFileSync } from 'node:fs';
import { assert, describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../../assembly/renderer-facade';
import {
  DEFAULT_STANDARD_PROFILE,
  type StandardExactDiffuseGi,
  type StandardProfile,
} from '../../pipeline/standard-profile';
import { validateDiffuseGi } from '../../raytracing/irradiance-field-plan';
import { DEFAULT_LITE_REFLECTIONS } from '../../raytracing/reflections-plan';

const gi: StandardExactDiffuseGi = {
  gather: 'exact',
  maxBounces: 2,
  seed: 7,
  maxDistance: 50,
  environment: [0, 0, 0],
  reflections: DEFAULT_LITE_REFLECTIONS,
};

describe('Lite reflections plan', () => {
  it('uses the UE combine defaults', () => {
    expect(DEFAULT_LITE_REFLECTIONS).toEqual({
      maxRoughnessToTrace: 0.4,
      roughnessFadeLength: 0.1,
    });
    expect(Object.isFrozen(DEFAULT_LITE_REFLECTIONS)).toBe(true);
  });

  it('admits bounded thresholds and rejects every other shape', () => {
    expect(validateDiffuseGi(gi).ok).toBe(true);
    expect(
      validateDiffuseGi({ ...gi, reflections: { maxRoughnessToTrace: 0, roughnessFadeLength: 1 } })
        .ok,
    ).toBe(true);
    for (const reflections of [
      null,
      true,
      [],
      {},
      { maxRoughnessToTrace: 0.4 },
      { maxRoughnessToTrace: -0.1, roughnessFadeLength: 0.1 },
      { maxRoughnessToTrace: 1.1, roughnessFadeLength: 0.1 },
      { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0 },
      { maxRoughnessToTrace: 0.4, roughnessFadeLength: Number.NaN },
      { maxRoughnessToTrace: 0.4, roughnessFadeLength: 0.1, kind: 'lite' },
    ]) {
      const result = validateDiffuseGi({ ...gi, reflections } as never);
      expect(result.ok, JSON.stringify(reflections)).toBe(false);
    }
  });

  it('admits the irradiance-field and screen-probe gathers through the radiance cache', () => {
    const irradianceField = {
      gather: 'irradiance-field',
      maxDistance: 50,
      environment: [0, 0, 0],
      field: {
        region: {
          grid: {
            origin: [0, 0, 0],
            dimensions: [9, 9, 9],
            spacing: 0.5,
            maxDistance: 2,
            coverageDistance: 1,
          },
          maxInstances: 4,
          maxFieldBytes: 1 << 20,
        },
        probeSpacing: 1,
        raysPerProbe: 64,
        probeBudget: 8,
        hysteresis: 0.9,
        cards: { resolution: 32, maxCaptureBytes: 1 << 22, budget: 8 },
        resolution: 'half',
        radiosity: false,
      },
    };
    expect(validateDiffuseGi(irradianceField as never).ok).toBe(true);
    const result = validateDiffuseGi({
      ...irradianceField,
      reflections: DEFAULT_LITE_REFLECTIONS,
    } as never);
    expect(result.ok).toBe(true);
    const screenProbe = validateDiffuseGi({
      ...irradianceField,
      gather: 'screen-probe',
      probes: {
        downsample: 16,
        adaptiveFraction: 0.25,
        importance: 'brdf',
        screenTrace: { maxSteps: 16, thickness: 0.02 },
        filterPasses: 1,
        shortRangeAo: 0,
        maxFrames: 8,
      },
      reflections: DEFAULT_LITE_REFLECTIONS,
    } as never);
    expect(screenProbe.ok, JSON.stringify(screenProbe)).toBe(true);
  });

  it('validates through the profile and deep-freezes a private copy', () => {
    const reflections = { maxRoughnessToTrace: 0.5, roughnessFadeLength: 0.2 };
    const profile: StandardProfile = {
      ...DEFAULT_STANDARD_PROFILE,
      renderPath: 'deferred',
      ibl: false,
      diffuseGi: { ...gi, reflections },
    };
    expect(validateRenderProfile(profile)).toBeUndefined();
    const frozenGi = freezeRenderProfile(profile).diffuseGi;
    assert(frozenGi?.gather === 'exact');
    const frozen = frozenGi.reflections;
    expect(frozen).toEqual(reflections);
    expect(frozen).not.toBe(reflections);
    expect(Object.isFrozen(frozen)).toBe(true);
  });

  it('publishes the reflection generator and composite entry points', () => {
    const raster = readFileSync(
      new URL('../../../../shader/src/ray-raster-source.wgsl', import.meta.url),
      'utf8',
    );
    expect(raster).toMatch(/@compute[^\n]*\n?fn generateReflectionRays\(/);
    expect(raster).toMatch(/fn generateRasterRays\(/);
    const composite = readFileSync(
      new URL('../../../../shader/src/ray-reflection-composite.wgsl', import.meta.url),
      'utf8',
    );
    for (const entry of [
      'vs_ray_reflection',
      'fs_ray_reflection',
      'fs_ray_reflection_reconstructed',
    ])
      expect(composite).toContain(`fn ${entry}(`);
  });
});
