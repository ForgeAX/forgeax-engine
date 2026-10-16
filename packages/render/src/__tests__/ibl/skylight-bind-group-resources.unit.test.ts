import type { Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { type SkylightFallback, skylightBindGroupResources } from '../../ibl/skylight-bind-group';

const handle = <T>(name: string): T => ({ name }) as unknown as T;

const fallback: SkylightFallback = {
  irradianceTexture: handle<Texture>('irr-tex'),
  irradianceView: handle<TextureView>('irr'),
  prefilterTexture: handle<Texture>('pref-tex'),
  prefilterView: handle<TextureView>('pref'),
  brdfLutTexture: handle<Texture>('brdf-tex'),
  brdfLutView: handle<TextureView>('brdf'),
  sampler: handle<Sampler>('sampler'),
  intensityBuffer: handle<Buffer>('intensity'),
};

describe('skylightBindGroupResources', () => {
  it('projects the fallback bundle with one sampler for both sampled slots', () => {
    expect(skylightBindGroupResources(fallback)).toEqual({
      irradianceView: fallback.irradianceView,
      irradianceSampler: fallback.sampler,
      prefilterView: fallback.prefilterView,
      prefilterSampler: fallback.sampler,
      brdfLutView: fallback.brdfLutView,
      intensityBuffer: fallback.intensityBuffer,
    });
  });

  it('replaces only the views when active IBL views are supplied', () => {
    const views = {
      irr: handle<TextureView>('active-irr'),
      pref: handle<TextureView>('active-pref'),
      brdf: handle<TextureView>('active-brdf'),
    };
    const resources = skylightBindGroupResources(fallback, views);
    expect(resources.irradianceView).toBe(views.irr);
    expect(resources.prefilterView).toBe(views.pref);
    expect(resources.brdfLutView).toBe(views.brdf);
    expect(resources.irradianceSampler).toBe(fallback.sampler);
    expect(resources.prefilterSampler).toBe(fallback.sampler);
    expect(resources.intensityBuffer).toBe(fallback.intensityBuffer);
  });
});
