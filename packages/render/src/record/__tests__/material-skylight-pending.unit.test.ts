import type { Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import { getOrCreateIblCache } from '../../ibl/IblPipelineCache';
import type { SkylightFallback } from '../../ibl/skylight-bind-group';
import type { SkylightSnapshot } from '../../render-system-extract';
import { resolveMaterialSkylight } from '../main-pass-material';

const handle = <T>(name: string): T => ({ name }) as unknown as T;
const scopes: DeviceScope[] = [];

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.dispose();
});

function fixture() {
  const scope = DeviceScope.create(1, 'material-skylight-pending-test');
  scopes.push(scope);
  const writes: Float32Array[] = [];
  const fallback: SkylightFallback = {
    irradianceTexture: handle<Texture>('fallback-irr-tex'),
    irradianceView: handle<TextureView>('fallback-irr'),
    prefilterTexture: handle<Texture>('fallback-pref-tex'),
    prefilterView: handle<TextureView>('fallback-pref'),
    brdfLutTexture: handle<Texture>('fallback-brdf-tex'),
    brdfLutView: handle<TextureView>('fallback-brdf'),
    sampler: handle<Sampler>('fallback-sampler'),
    intensityBuffer: handle<Buffer>('intensity'),
  };
  const writeBuffer = vi.fn((buffer: Buffer, offset: number, data: Float32Array) => {
    expect(buffer).toBe(fallback.intensityBuffer);
    expect(offset).toBe(0);
    expect(data).toBeInstanceOf(Float32Array);
    expect(data.byteLength).toBe(32);
    writes.push(data.slice());
    return { ok: true, value: undefined };
  });
  const runtime = {
    device: { queue: { writeBuffer } },
    deviceScope: scope,
  } as unknown as Parameters<typeof resolveMaterialSkylight>[0];
  const cache = getOrCreateIblCache(scope);
  const image: SkylightSnapshot = {
    entityHandle: 1,
    equirectHandle: 123,
    color: [0.25, 0.5, 0.75],
    intensity: 2,
    rotation: [0, 0, 0, 1],
  };
  const ready = () => {
    cache.irradianceView = handle<TextureView>('ready-irr');
    cache.prefilterView = handle<TextureView>('ready-pref');
    cache.brdfLutView = handle<TextureView>('ready-brdf');
  };
  const resolve = (
    sky: SkylightSnapshot | undefined,
    count = 1,
    environment?: Parameters<typeof resolveMaterialSkylight>[4],
  ) => resolveMaterialSkylight(runtime, { skylightFallback: fallback }, sky, count, environment);
  const payload = () => Array.from(writes.at(-1) ?? []);
  return { fallback, cache, image, ready, resolve, payload, writes };
}

describe('material Skylight explicit-image availability', () => {
  it('binds fallback views with zero intensity while an explicit image has no published IBL', () => {
    const f = fixture();
    const result = f.resolve(f.image);
    expect(result.activeViews).toBeUndefined();
    expect(result.skylightResources.irradianceView).toBe(f.fallback.irradianceView);
    expect(result.skylightResources.prefilterView).toBe(f.fallback.prefilterView);
    expect(result.skylightResources.brdfLutView).toBe(f.fallback.brdfLutView);
    expect(f.payload()).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it.each([
    'irradianceView',
    'prefilterView',
    'brdfLutView',
  ] as const)('keeps explicit-image intensity zero when the published bundle lacks %s', (missing) => {
    const f = fixture();
    f.ready();
    delete f.cache[missing];
    expect(f.resolve(f.image).activeViews).toBeUndefined();
    expect(f.payload()[0]).toBe(0);
  });

  it('retains positive solid-color ambient without an authored image', () => {
    const f = fixture();
    const result = f.resolve({ ...f.image, equirectHandle: 0 });
    expect(result.skylightResources.irradianceView).toBe(f.fallback.irradianceView);
    expect(f.payload()).toEqual([2, 0.25, 0.5, 0.75, 0, 0, 0, 1]);
  });

  it('retains the ready IBL views and the complete authored uniform', () => {
    const f = fixture();
    f.ready();
    const result = f.resolve(f.image);
    expect(result.skylightResources.irradianceView).toBe(f.cache.irradianceView);
    expect(result.skylightResources.prefilterView).toBe(f.cache.prefilterView);
    expect(result.skylightResources.brdfLutView).toBe(f.cache.brdfLutView);
    expect(f.payload()).toEqual([2, 0.25, 0.5, 0.75, 0, 0, 0, 1]);
  });

  it('retains the no-image graph environment and positive uniform', () => {
    const f = fixture();
    const environment = {
      irradiance: handle<TextureView>('graph-irr'),
      prefilter: handle<TextureView>('graph-pref'),
    };
    const result = f.resolve({ ...f.image, equirectHandle: 0 }, 1, environment);
    expect(result.skylightResources.irradianceView).toBe(environment.irradiance);
    expect(result.skylightResources.prefilterView).toBe(environment.prefilter);
    expect(result.skylightResources.brdfLutView).toBe(f.fallback.brdfLutView);
    expect(f.payload()[0]).toBe(2);
  });

  it('does not use the no-image graph environment for an unavailable explicit image', () => {
    const f = fixture();
    const result = f.resolve(f.image, 1, {
      irradiance: handle<TextureView>('graph-irr'),
      prefilter: handle<TextureView>('graph-pref'),
    });
    expect(result.skylightResources.irradianceView).toBe(f.fallback.irradianceView);
    expect(f.payload()[0]).toBe(0);
  });

  it('clears a previous positive ambient when Skylight extraction becomes empty', () => {
    const f = fixture();
    f.resolve({ ...f.image, equirectHandle: 0 });
    expect(f.payload()[0]).toBe(2);
    f.resolve(undefined, 0);
    expect(f.payload()).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('clears a previous positive ambient when a subsequent explicit image is unavailable', () => {
    const f = fixture();
    f.resolve({ ...f.image, equirectHandle: 0 });
    expect(f.payload()[0]).toBe(2);
    f.resolve(f.image);
    expect(f.payload()).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });
});
