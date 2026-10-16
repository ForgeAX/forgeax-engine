import { assert, describe, expect, it } from 'vitest';
import { freezeRenderProfile, validateRenderProfile } from '../assembly/renderer-facade';
import { AUTO_EXPOSURE_PRESET_V1 } from '../pipeline/standard-output/auto-exposure/preset';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from '../pipeline/standard-profile';

describe('Standard profile oracle', () => {
  it('rejects the unused shadow policy; lights own casting and filtering', () => {
    expect(DEFAULT_STANDARD_PROFILE).not.toHaveProperty('shadows');
    for (const shadows of ['off', 'hard', 'filtered']) {
      expect(
        validateRenderProfile({
          ...DEFAULT_STANDARD_PROFILE,
          shadows,
        } as unknown as StandardProfile),
      ).toContain('shadows');
    }
  });
  it('admits the existing GPU occlusion control and rejects nonboolean inputs', () => {
    for (const gpuOcclusion of [false, true]) {
      const profile = { ...DEFAULT_STANDARD_PROFILE, gpuOcclusion };
      expect(validateRenderProfile(profile)).toBeUndefined();
      expect(freezeRenderProfile(profile).gpuOcclusion).toBe(gpuOcclusion);
    }
    expect(
      validateRenderProfile({
        ...DEFAULT_STANDARD_PROFILE,
        gpuOcclusion: 0,
      } as unknown as StandardProfile),
    ).toBe('RenderProfile.gpuOcclusion must be boolean');
  });
  it('requires the renderPath-only profile contract', () => {
    const profile: StandardProfile = DEFAULT_STANDARD_PROFILE;
    expect(profile.pipelineId).toBe('forgeax::standard');
    expect(profile.renderPath).toBe('forward');
    expect(profile).not.toHaveProperty('lighting');
    expect(profile).not.toHaveProperty('fallback');
  });

  it('keeps one identity across the supported light budgets', () => {
    expect(STANDARD_LIGHT_COUNTS).toEqual([1, 32, 256]);
    for (const lightCount of STANDARD_LIGHT_COUNTS) {
      const profile: StandardProfile = {
        ...DEFAULT_STANDARD_PROFILE,
        lightCount,
      };
      expect(profile.pipelineId).toBe(STANDARD_PIPELINE_ID);
      expect(profile.lightCount).toBe(lightCount);
    }
  });

  it('does not model a second lighting or fallback lane', () => {
    const profile = DEFAULT_STANDARD_PROFILE as unknown as Record<string, unknown>;
    expect(profile).not.toHaveProperty('lighting');
    expect(profile).not.toHaveProperty('fallback');
  });

  it('selects only the graph path; Cluster transport is capability-derived', () => {
    expect({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' }).toMatchObject({
      pipelineId: STANDARD_PIPELINE_ID,
      renderPath: 'forward',
    });
    expect({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' }).toMatchObject({
      pipelineId: STANDARD_PIPELINE_ID,
      renderPath: 'deferred',
    });
  });

  it('keeps the color-domain stage order stable for all profiles', () => {
    expect(DEFAULT_STANDARD_PROFILE.postStages).toEqual([
      'transparent-blend',
      'bloom',
      'output-transform',
      'fxaa',
      'post-effect',
      'present',
    ]);
  });
  it('keeps current-main post-processing defaults in the Standard profile', () => {
    expect(DEFAULT_STANDARD_PROFILE).toMatchObject({
      renderPath: 'forward',
      postStages: [
        'transparent-blend',
        'bloom',
        'output-transform',
        'fxaa',
        'post-effect',
        'present',
      ],
    });
    expect(DEFAULT_STANDARD_PROFILE).not.toHaveProperty('tone');
    expect(DEFAULT_STANDARD_PROFILE).not.toHaveProperty('antialias');
    expect(DEFAULT_STANDARD_PROFILE).not.toHaveProperty('sky');
  });

  it('binds the Standard profile to the versioned auto-exposure oracle preset', () => {
    expect(AUTO_EXPOSURE_PRESET_V1.version).toBe('auto-exposure-v1');
    expect(AUTO_EXPOSURE_PRESET_V1.histogramBins).toBe(256);
  });
});

describe('Volumetric fog public profile', () => {
  it('admits and snapshots each supported quality, depth and tile size', () => {
    for (const quality of ['low', 'high'] as const)
      for (const depth of [48, 64] as const)
        for (const tileSize of [4, 16] as const) {
          const volumetricFog = { quality, depth, tileSize };
          const profile = { ...DEFAULT_STANDARD_PROFILE, volumetricFog };
          expect(validateRenderProfile(profile)).toBeUndefined();
          const frozen = freezeRenderProfile(profile);
          volumetricFog.tileSize = tileSize === 4 ? 16 : 4;
          expect(frozen.volumetricFog).toEqual({ quality, depth, tileSize });
          expect(Object.isFrozen(frozen.volumetricFog)).toBe(true);
        }
  });

  it('rejects malformed volume profiles at admission', () => {
    for (const volumetricFog of [
      null,
      [],
      {},
      { quality: 'medium', depth: 48, tileSize: 16 },
      { quality: 'low', depth: 0, tileSize: 16 },
      { quality: 'low', depth: 48, tileSize: 8 },
      { quality: 'low', depth: 48, tileSize: 16, other: true },
    ]) {
      expect(
        validateRenderProfile({ ...DEFAULT_STANDARD_PROFILE, volumetricFog } as StandardProfile),
      ).toContain('volumetricFog');
    }
  });
});

describe('SSAO public profile', () => {
  it('preserves immutable AO parameters through the public profile', () => {
    const ssao = {
      algorithm: 'gtao' as const,
      radius: 0.8,
      bias: 0.01,
      intensity: 1.5,
      quality: 'low' as const,
    };
    const profile = { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' as const, ssao };
    expect(validateRenderProfile(profile)).toBeUndefined();
    const frozen = freezeRenderProfile(profile);
    ssao.radius = 2;
    expect(frozen.ssao).toEqual({
      algorithm: 'gtao',
      radius: 0.8,
      bias: 0.01,
      intensity: 1.5,
      quality: 'low',
    });
    expect(Object.isFrozen(frozen.ssao)).toBe(true);
  });
  it('rejects unavailable normals and malformed parameter objects', () => {
    expect(validateRenderProfile({ ...DEFAULT_STANDARD_PROFILE, ssao: true })).toContain(
      'deferred',
    );
    for (const ssao of [
      [],
      null,
      { quality: 'ultra' },
      { algorithm: 'unknown' },
      { radius: Number.NaN },
      { other: 1 },
    ]) {
      expect(
        validateRenderProfile({
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: 'deferred',
          ssao,
        } as unknown as StandardProfile),
      ).toBeTypeOf('string');
    }
  });
});

describe('reference diffuse GI profile', () => {
  const diffuseGi = {
    gather: 'exact' as const,
    maxBounces: 1,
    maxDistance: 100,
    seed: 47,
    environment: [0.1, 0.2, 0.3] as [number, number, number],
  };
  const profile = {
    ...DEFAULT_STANDARD_PROFILE,
    renderPath: 'deferred' as const,
    ibl: false,
    diffuseGi,
  };
  it('derives receiver demand and freezes the caller environment', () => {
    expect(validateRenderProfile(profile)).toBeUndefined();
    const frozen = freezeRenderProfile(profile);
    expect(frozen.visibleSurface).toBe(true);
    assert(frozen.diffuseGi?.gather === 'exact');
    expect(frozen.diffuseGi?.environment).not.toBe(diffuseGi.environment);
    expect(Object.isFrozen(frozen.diffuseGi?.environment)).toBe(true);
  });
  it('rejects duplicate environment lighting and unbounded reference settings', () => {
    expect(validateRenderProfile({ ...profile, ibl: true })).toContain('IBL disabled');
    expect(validateRenderProfile({ ...profile, renderPath: 'forward' })).toContain('deferred');
    for (const invalid of [
      null,
      [],
      {},
      { ...diffuseGi, maxBounces: 0 },
      { ...diffuseGi, maxBounces: 9 },
      { ...diffuseGi, maxDistance: Infinity },
      { ...diffuseGi, seed: -1 },
      { ...diffuseGi, environment: [0, -1, 0] },
      { ...diffuseGi, environment: [0, 0, NaN] },
    ])
      expect(
        validateRenderProfile({ ...profile, diffuseGi: invalid } as unknown as StandardProfile),
      ).toBeTypeOf('string');
  });
});
