import { describe, expect, it } from 'vitest';
import { AMBIENT_OCCLUSION_GTAO, AmbientOcclusion } from '../components/ambient-occlusion';
import { deriveCameraStandardConfiguration } from '../pipeline/camera-standard-profile';
import { resolveStandardGtaoExecution } from '../pipeline/standard-build-context';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';

const lane = { storageBuffer: true, maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 64 };
const ao = {
  algorithm: AMBIENT_OCCLUSION_GTAO,
  radius: 0.8,
  bias: 0.03,
  intensity: 1.4,
  directLightingStrength: 0.6,
  quality: 2,
  thickness: 1,
  distanceExponent: 1,
  distanceFallOff: 1,
  resolutionScale: 1,
};
const base = Object.freeze({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' as const });
const config = Object.freeze({
  ssao: Object.freeze({ enabled: false, radius: 0.2 }),
  outputDither: false,
});
const derive = (camera: Parameters<typeof deriveCameraStandardConfiguration>[2]) => {
  const result = deriveCameraStandardConfiguration(base, config, camera, lane);
  if (!result.ok) throw result.error;
  return result.value;
};

it('registers zero direct AO as the schema default', () => {
  expect(AmbientOcclusion.fields.directLightingStrength.default).toBe(0);
});

describe('selected-view Standard projection', () => {
  it('leaves an unrequested camera on the original profile and config identities', () => {
    expect(derive(undefined).profile).toBe(base);
    expect(derive(undefined).config).toBe(config);
  });
  it('projects camera AO over install-time AO without changing other configuration', () => {
    expect(derive({ ambientOcclusion: ao })).toMatchObject({
      profile: { renderPath: 'forward' },
      config: {
        outputDither: false,
        ssao: {
          enabled: true,
          algorithm: 'gtao',
          radius: 0.8,
          directLightingStrength: 0.6,
          quality: 'high',
        },
      },
    });
    expect(base.renderPath).toBe('forward');
    expect(config.ssao).toEqual({ enabled: false, radius: 0.2 });
  });
  it('keeps two views independent through toggles and capture snapshots without companions', () => {
    const left = derive({ ambientOcclusion: ao });
    const right = derive({ screenSpaceReflection: {} });
    expect(left.config?.ssao?.enabled).toBe(true);
    expect(right.config).toBe(config);
    expect(right.profile?.renderPath).toBe('deferred');
    const removed = derive({});
    const capture = derive(undefined);
    expect(removed.profile).toBe(base);
    expect(removed.config).toBe(config);
    expect(capture.config).toBe(config);
    expect(left.config?.ssao?.enabled).toBe(true);
  });
  it.each([
    { storageBuffer: false, maxColorAttachments: 8 },
    { storageBuffer: true, maxColorAttachments: 1 },
  ])('keeps camera AO on Forward without Deferred capabilities', (unsupported) => {
    expect(
      deriveCameraStandardConfiguration(base, config, { ambientOcclusion: ao }, unsupported),
    ).toMatchObject({
      ok: true,
      value: {
        profile: { renderPath: 'forward', ssao: { algorithm: 'gtao' } },
        config: { ssao: { enabled: true, algorithm: 'gtao' } },
      },
    });
  });
  it('reports invalid camera AO rather than admitting a NaN payload', () => {
    expect(
      deriveCameraStandardConfiguration(
        base,
        config,
        { ambientOcclusion: { ...ao, directLightingStrength: NaN } },
        lane,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'ssao-parameter-invalid', detail: { paramName: 'directLightingStrength' } },
    });
  });
});

describe('internal GTAO stage selection', () => {
  it('selects compute only for GTAO when the lane admits compute', () => {
    expect(resolveStandardGtaoExecution('gtao', true, 'compute')).toEqual({
      ok: true,
      value: 'compute',
    });
  });

  it('rejects an internal compute override on WebGL2 without enabling unsupported work', () => {
    expect(resolveStandardGtaoExecution('gtao', false, 'compute')).toMatchObject({
      ok: false,
      error: { code: 'capability-missing', detail: { capability: 'compute' } },
    });
  });

  it('does not select the GTAO compute adapter for the hemisphere SSAO algorithm', () => {
    expect(resolveStandardGtaoExecution('ssao', true, 'compute')).toMatchObject({
      ok: false,
      error: { code: 'resource-descriptor-invalid', detail: { field: 'algorithm' } },
    });
  });
});
