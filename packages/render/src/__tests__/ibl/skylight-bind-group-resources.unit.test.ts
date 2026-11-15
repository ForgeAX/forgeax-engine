import type { Buffer, Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  assembleMaterialWithSkylightEntries,
  type SkylightFallback,
  skylightBindGroupResources,
} from '../../ibl/skylight-bind-group';

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
  it.each([
    false,
    true,
  ])('retains global reflection input for medium probe selection %s', (localProbe) => {
    const global = handle<TextureView>('global-environment');
    const selected = localProbe ? handle<TextureView>('local-probe') : global;
    const sampler = fallback.sampler;
    const entries = assembleMaterialWithSkylightEntries(
      [],
      {
        ...skylightBindGroupResources(fallback),
        prefilterView: selected,
        ...(localProbe ? { skylightPrefilterView: global } : {}),
      },
      { sampler, backdropView: global },
      [],
      {
        planarView: global,
        planarUniform: fallback.intensityBuffer,
        planarUniformOffset: 0,
        rawDepthSampler: sampler,
        rawDepthView: global,
        nearestLayerSampler: sampler,
        nearestLayerView: global,
        nearestDepthSampler: sampler,
        nearestDepthView: global,
      },
    );
    expect(entries.find((entry) => entry.binding === 2)?.resource).toEqual({
      kind: 'textureView',
      value: selected,
    });
    expect(entries.find((entry) => entry.binding === 47)?.resource).toEqual({
      kind: 'textureView',
      value: global,
    });
  });

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
