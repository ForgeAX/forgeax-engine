import { describe, expect, it } from 'vitest';
import { AmbientOcclusion } from '../components/ambient-occlusion';
import { MaterialResource } from '../material-resource';
import { deriveCameraStandardConfiguration } from '../pipeline/camera-standard-profile';
import { resolveStandardGtaoExecution } from '../pipeline/standard-build-context';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import { defaultMaterialSnapshot } from '../render-system-extract';
import { MaterialFrame } from '../scene/material-dispatch';

const lane = { storageBuffer: true, maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 72 };
const ao = {
  enabled: true,
  radius: 0.8,
  bias: 3,
  intensity: 0.7,
  power: 2,
  fadeDistance: 80,
  fadeRadius: 50,
  quality: 50,
};
const base = Object.freeze({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' as const });
const config = Object.freeze({
  ambientOcclusion: Object.freeze({ enabled: false, method: 'gtao' as const, radius: 0.2 }),
  outputDither: false,
});
const derive = (camera: Parameters<typeof deriveCameraStandardConfiguration>[2]) => {
  const result = deriveCameraStandardConfiguration(base, config, camera, lane);
  if (!result.ok) throw result.error;
  return result.value;
};

it('leaves omitted camera parameters inherited', () => {
  expect(AmbientOcclusion.fields.intensity.default).toBe(-1);
});

describe('selected-view Standard projection', () => {
  it.each(['forward', 'deferred'] as const)('keeps %s when SLW is selected', (renderPath) => {
    const water = new MaterialResource({
      ...defaultMaterialSnapshot(),
      surfaceModel: 'single-layer-water',
    });
    const materials = new MaterialFrame(undefined).with(water);
    const profile = { ...base, renderPath };
    const selected = deriveCameraStandardConfiguration(
      profile,
      config,
      {},
      lane,
      materials.hasWater,
    );
    expect(selected.unwrap().profile).toBe(profile);
    expect(base.renderPath).toBe('forward');
  });
  it('keeps explicitly selected Forward with SLW and ordinary camera SSR', () => {
    const water = new MaterialResource({
      ...defaultMaterialSnapshot(),
      surfaceModel: 'single-layer-water',
    });
    const materials = new MaterialFrame(undefined).with(water);
    const selected = deriveCameraStandardConfiguration(
      base,
      config,
      { screenSpaceReflection: {} },
      lane,
      materials.hasWater,
    );
    expect(selected.unwrap().profile).toBe(base);
  });
  it('does not infer SLW from zero bindings or a Standard WaterMesh material', () => {
    for (const [surfaceModel, bindings] of [
      ['single-layer-water', 0],
      ['standard', 1],
    ] as const) {
      const resource = new MaterialResource({ ...defaultMaterialSnapshot(), surfaceModel });
      const materials = new MaterialFrame(undefined).with(resource, bindings);
      const selected = deriveCameraStandardConfiguration(
        base,
        config,
        {},
        lane,
        materials.hasWater,
      );
      expect(selected).toMatchObject({ ok: true, value: { profile: base } });
      if (selected.ok) expect(selected.value.profile).toBe(base);
    }
  });
  it.each([
    [{ ...lane, storageBuffer: false }, {}, 'lane.storageBuffer'],
    [{ ...lane, maxColorAttachments: 4 }, {}, 'lane.maxColorAttachments'],
    [
      { ...lane, maxColorAttachmentBytesPerSample: 32 },
      {},
      'lane.maxColorAttachmentBytesPerSample',
    ],
  ])('rejects unsupported SLW demand before lighting is prepared', (capabilities, camera, field) => {
    expect(
      deriveCameraStandardConfiguration(base, config, camera, capabilities, true),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'resource-descriptor-invalid',
        detail: { resourceLabel: 'single-layer-water', field },
      },
    });
  });
  it('keeps Forward Water MSAA on the real Forward producer with an ordinary SSR request', () => {
    for (const antialias of ['msaa', 'msaa-fxaa'] as const) {
      for (const screenSpaceReflection of [undefined, {}]) {
        const selected = deriveCameraStandardConfiguration(
          base,
          config,
          { antialias, screenSpaceReflection },
          lane,
          true,
        );
        expect(selected).toMatchObject({ ok: true, value: { profile: { renderPath: 'forward' } } });
      }
    }
  });
  it('leaves an unrequested camera on the original profile and config identities', () => {
    expect(derive(undefined).profile).toBe(base);
    expect(derive(undefined).config).toBe(config);
  });
  it('preserves project GTAO limits when the camera overrides intensity', () => {
    expect(
      deriveCameraStandardConfiguration(
        base,
        {
          ambientOcclusion: {
            enabled: false,
            method: 'gtao',
            levels: 2,
            gtao: { downsample: true },
          },
        },
        { ambientOcclusion: { ...ao, quality: -1, intensity: 0 } },
        lane,
      ).unwrap().config?.ambientOcclusion,
    ).toMatchObject({
      enabled: true,
      method: 'gtao',
      levels: 2,
      gtao: { downsample: true },
      intensity: 0,
    });
  });
  it('projects camera AO over install-time AO without changing other configuration', () => {
    expect(derive({ ambientOcclusion: ao })).toMatchObject({
      profile: { renderPath: 'forward' },
      config: {
        outputDither: false,
        ambientOcclusion: {
          enabled: true,
          method: 'gtao',
          radius: 0.8,
          intensity: 0.7,
          quality: 50,
        },
      },
    });
    expect(base.renderPath).toBe('forward');
    expect(config.ambientOcclusion).toEqual({ enabled: false, method: 'gtao', radius: 0.2 });
  });
  it('lets a camera disable inherited AO while retaining the project method', () => {
    const inherited = { ambientOcclusion: { enabled: true, method: 'gtao' as const } };
    const selected = deriveCameraStandardConfiguration(
      base,
      inherited,
      { ambientOcclusion: { ...ao, enabled: false } },
      lane,
    ).unwrap();
    expect(selected.config?.ambientOcclusion).toEqual({ enabled: false, method: 'gtao' });
    expect(deriveCameraStandardConfiguration(base, inherited, {}, lane).unwrap().config).toBe(
      inherited,
    );
  });
  it('keeps two views independent through toggles and capture snapshots without companions', () => {
    const left = derive({ ambientOcclusion: ao });
    const right = derive({ screenSpaceReflection: {} });
    expect(left.config?.ambientOcclusion?.enabled).toBe(true);
    expect(right.config).toBe(config);
    expect(right.profile?.renderPath).toBe('deferred');
    const removed = derive({});
    const capture = derive(undefined);
    expect(removed.profile).toBe(base);
    expect(removed.config).toBe(config);
    expect(capture.config).toBe(config);
    expect(left.config?.ambientOcclusion?.enabled).toBe(true);
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
        profile: { renderPath: 'forward', ambientOcclusion: { enabled: true, method: 'gtao' } },
        config: { ambientOcclusion: { enabled: true, method: 'gtao' } },
      },
    });
  });
  it('reports invalid camera AO rather than admitting a NaN payload', () => {
    expect(
      deriveCameraStandardConfiguration(
        base,
        config,
        { ambientOcclusion: { ...ao, power: NaN } },
        lane,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'ssao-parameter-invalid', detail: { paramName: 'power' } },
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
