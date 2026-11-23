import { describe, expect, it } from 'vitest';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import {
  applyAmbientOcclusionQuality,
  lightsForQuality,
  type RenderQualityGroups,
  renderProfileForQuality,
  resolveRenderQualityBudgets,
  textureMipSkipForQuality,
  validateRenderQualityLimits,
} from '../quality';
import type { LightRoster } from '../render-system-extract';
import { estimateSsrSpatialMemory } from '../ssr/resources';

const high: RenderQualityGroups = {
  resolution: 'high',
  shadows: 'high',
  ambientOcclusion: 'high',
  reflections: 'high',
  globalIllumination: 'high',
  volumetrics: 'high',
  textures: 'high',
  shading: 'high',
};
const low: RenderQualityGroups = {
  resolution: 'low',
  shadows: 'low',
  ambientOcclusion: 'low',
  reflections: 'low',
  globalIllumination: 'low',
  volumetrics: 'low',
  textures: 'low',
  shading: 'low',
};

describe('domain-owned quality projection', () => {
  it('retains source appearance and restores A to B to A without deriving from B', () => {
    const source = {
      ...DEFAULT_STANDARD_PROFILE,
      ambientOcclusion: {
        enabled: true,
        method: 'gtao' as const,
        radius: 3,
        intensity: 2,
        bias: 0.03,
        quality: 100,
      },
    };
    const original = structuredClone(source);
    const first = renderProfileForQuality(source, high);
    const reduced = renderProfileForQuality(source, low);
    expect(reduced.ambientOcclusion).toMatchObject({
      method: 'gtao',
      radius: 3,
      intensity: 2,
      quality: 100,
      maxQuality: 25,
      gtao: { downsample: true },
    });
    expect(renderProfileForQuality(source, high)).toEqual(first);
    expect(source).toEqual(original);
  });

  it('caps camera AO after authoring and keeps an already lower author budget', () => {
    const budget = resolveRenderQualityBudgets(low).ambientOcclusion;
    expect(
      applyAmbientOcclusionQuality({ method: 'gtao', radius: 5, quality: 100 }, budget),
    ).toMatchObject({
      radius: 5,
      method: 'gtao',
      quality: 100,
      maxQuality: 25,
      gtao: { downsample: true },
    });
    expect(applyAmbientOcclusionQuality({ quality: 20, maxQuality: 20 }, budget).maxQuality).toBe(
      20,
    );
  });

  it('bounds all shadow maps before fitting without changing light coverage or source facts', () => {
    const source = {
      directionalCsmConfig: { mapSize: 2048, cascadeCount: 4, shadowDistance: 180 },
      spot: [{ mapSize: 256, range: 80 }],
      pointShadow: [{ mapSize: 1024, farPlane: 90 }],
    } as unknown as LightRoster;
    const reduced = lightsForQuality(source, resolveRenderQualityBudgets(low));
    expect(reduced.directionalCsmConfig).toMatchObject({
      mapSize: 512,
      cascadeCount: 2,
      shadowDistance: 180,
    });
    expect(reduced.spot[0]?.mapSize).toBe(256);
    expect(reduced.pointShadow[0]).toMatchObject({ mapSize: 512, farPlane: 90 });
    expect(source.directionalCsmConfig?.mapSize).toBe(2048);
    expect(lightsForQuality(source, resolveRenderQualityBudgets(high))).toBe(source);
  });

  it('keeps precise limits stricter than tiers and validates even unused malformed limits', () => {
    const limits = {
      ambientOcclusion: { resolutionScale: 0.25 },
      ssr: { hizIterations: 12 },
      textureMipSkip: 3,
    };
    expect(resolveRenderQualityBudgets(high, limits)).toMatchObject({
      ambientOcclusion: { resolutionScale: 0.25 },
      ssr: { hizIterations: 12 },
    });
    expect(textureMipSkipForQuality('high', limits)).toBe(3);
    expect(textureMipSkipForQuality('low', limits)).toBe(3);
    expect(validateRenderQualityLimits({ ssr: { refineSteps: 0 } })).toBeDefined();
    expect(validateRenderQualityLimits({ ssr: { refineSteps: 6 } })).toBeDefined();
    expect(validateRenderQualityLimits({ ssr: { refineSteps: 5 } })).toBeUndefined();
  });

  it('accounts half-density trace storage with a full-resolution depth hierarchy', () => {
    const full = estimateSsrSpatialMemory({ width: 1920, height: 1080 });
    const half = estimateSsrSpatialMemory({ width: 1920, height: 1080 }, { resolutionScale: 0.5 });
    expect(half.traceWidth).toBe(960);
    expect(half.traceHeight).toBe(540);
    expect(half.traceBytes * 4).toBe(full.traceBytes);
    expect(half.depthPyramidBytes).toBe(full.depthPyramidBytes);
    expect(half.ssrOwnedBytes).toBeLessThan(full.ssrOwnedBytes);
  });
});
