import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { GradientSky, GradientSkyPresets } from '../components/gradient-sky';
import { selectEnvironment } from '../environment/frame';
import {
  GRADIENT_SKY_PARAMS_BYTES,
  GRADIENT_SKY_SUN_DISC_GAIN,
  gradientSkyClearColor,
  gradientSkyIn,
  gradientSkySunBlooms,
  packGradientSkyParams,
} from '../environment/gradient-sky';
import type { FogCandidate, GradientSkyFrame } from '../extract/environment';
import { earthAtmosphere } from './atmosphere-fixture';

const sky = (overrides: Partial<GradientSkyFrame> = {}): GradientSkyFrame => ({
  entityKey: 7,
  zenith: [0.1, 0.3, 0.8],
  horizon: [0.7, 0.8, 0.9],
  ground: [0.3, 0.3, 0.28],
  mid: [0, 0, 0],
  midHeight: 0,
  exponent: 0.6,
  sunSize: 0.04,
  sunGlow: 0.5,
  fogBlend: 0.15,
  toneMapped: false,
  ...overrides,
});

const sun = {
  entityKey: 2,
  direction: [0, 0.6, -0.8] as const,
  color: [1, 0.5, 0.25] as const,
  intensity: 3,
};

const fog: FogCandidate = {
  entityKey: 3,
  color: [0.6, 0.65, 0.7],
  density: 0,
  heightFalloff: 0,
  maxOpacity: 0.9,
  mode: 'linear',
  near: 20,
  far: 80,
};

const output = { exposure: 1.1, whitePoint: 4, tonemap: 4, gamut: 0 };

describe('GradientSky', () => {
  it('defaults to a display-referred clear-day sky with a sun disc and fog blend', () => {
    const world = new World();
    const entity = world.spawn({ component: GradientSky, data: {} }).unwrap();
    const value = world.get(entity, GradientSky).unwrap();
    expect(value.toneMapped).toBe(false);
    expect(value.sunSize).toBeGreaterThan(0);
    expect(value.fogBlend).toBeGreaterThan(0);
    expect(value.zenith[2]).toBeGreaterThan(value.zenith[0] ?? 1);
  });

  it('is selected into the environment frame beside an image or no environment', () => {
    const none = selectEnvironment({ environments: [], fogs: [], suns: [], skies: [sky()] });
    if (!none.ok) throw none.error;
    expect(none.value.sky).toEqual(sky());
    expect(Object.isFrozen(none.value.sky)).toBe(true);
    const image = selectEnvironment({
      environments: [{ kind: 'image', entityKey: 1, sourceKey: 'equirect:1' }],
      fogs: [],
      suns: [],
      skies: [sky()],
    });
    expect(image.ok).toBe(true);
    const absent = selectEnvironment({ environments: [], fogs: [], suns: [] });
    if (!absent.ok) throw absent.error;
    expect(absent.value.sky).toBeUndefined();
  });

  it.each([
    ['a second GradientSky', { skies: [sky(), sky({ entityKey: 8 })] }, 'GradientSky'],
    ['a SkyboxBackground', { skies: [sky()], skyboxBackground: true }, 'GradientSky'],
    [
      'a negative zenith channel',
      { skies: [sky({ zenith: [0, -1, 0] })] },
      'GradientSky.zenith[1]',
    ],
    ['a zero exponent', { skies: [sky({ exponent: 0 })] }, 'GradientSky.exponent'],
    ['an oversized sun', { skies: [sky({ sunSize: 1 })] }, 'GradientSky.sunSize'],
    ['a fog blend above 1', { skies: [sky({ fogBlend: 2 })] }, 'GradientSky.fogBlend'],
    ['a mid stop at the zenith', { skies: [sky({ midHeight: 1 })] }, 'GradientSky.midHeight'],
    ['a negative mid channel', { skies: [sky({ mid: [0, 0, -1] })] }, 'GradientSky.mid[2]'],
  ] as const)('rejects %s and names the field', (_, input, field) => {
    const result = selectEnvironment({ environments: [], fogs: [], suns: [], ...input });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('environment-selection-invalid');
    expect((result.error as { detail: { field: string } }).detail.field).toBe(field);
  });

  it('rejects a GradientSky beside Atmosphere, which draws its own sky', () => {
    const result = selectEnvironment({
      environments: [
        { kind: 'atmosphere', entityKey: 1, sourceKey: 'a', atmosphere: earthAtmosphere },
      ],
      fogs: [],
      suns: [sun],
      skies: [sky()],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Atmosphere');
  });

  it('packs display lanes: authored colours, light-hued disc, fog opacity and output curve', () => {
    const values = packGradientSkyParams(sky(), sun, fog, output, 'display');
    expect(values.byteLength).toBe(GRADIENT_SKY_PARAMS_BYTES);
    expect([...values.subarray(0, 4)]).toEqual([0.1, 0.3, 0.8, 0.6].map(Math.fround));
    expect([...values.subarray(4, 8)]).toEqual([0.7, 0.8, 0.9, 0.15].map(Math.fround));
    expect(values[11]).toBeCloseTo(0.9);
    expect([...values.subarray(12, 16)]).toEqual([0, 0.6, -0.8, 0.04].map(Math.fround));
    expect([...values.subarray(16, 19)]).toEqual([1, 0.75, 0.625]);
    expect([...values.subarray(20, 24)]).toEqual([1, 0.5, 0.25, 0.5]);
    expect([...values.subarray(24, 27)]).toEqual([0.6, 0.65, 0.7].map(Math.fround));
    expect([...values.subarray(28, 32)]).toEqual([1.1, 4, 4, 0].map(Math.fround));
    // Without a middle stop the lane is zero, which the shader reads as the two-stop law.
    expect([...values.subarray(32, 36)]).toEqual([0, 0, 0, 0]);
  });

  it('packs the optional middle stop and its elevation into the mid lane', () => {
    const values = packGradientSkyParams(
      sky({ mid: [0.6, 0.2, 0.3], midHeight: 0.25 }),
      sun,
      undefined,
      output,
      'display',
    );
    expect([...values.subarray(32, 36)]).toEqual([0.6, 0.2, 0.3, 0.25].map(Math.fround));
  });

  it('defaults to no middle stop and ships valid daylight, dusk, night and overcast presets', () => {
    const world = new World();
    const plain = world.spawn({ component: GradientSky, data: {} }).unwrap();
    expect(world.get(plain, GradientSky).unwrap().midHeight).toBe(0);
    for (const [name, preset] of Object.entries(GradientSkyPresets)) {
      const entity = world.spawn({ component: GradientSky, data: preset }).unwrap();
      const value = world.get(entity, GradientSky).unwrap();
      const frame = sky({
        zenith: [...value.zenith] as unknown as GradientSkyFrame['zenith'],
        horizon: [...value.horizon] as unknown as GradientSkyFrame['horizon'],
        ground: [...value.ground] as unknown as GradientSkyFrame['ground'],
        mid: [...value.mid] as unknown as GradientSkyFrame['mid'],
        midHeight: value.midHeight,
        exponent: value.exponent,
        sunSize: value.sunSize,
        sunGlow: value.sunGlow,
      });
      const selected = selectEnvironment({ environments: [], fogs: [], suns: [], skies: [frame] });
      expect(selected.ok, name).toBe(true);
    }
    // Dusk is three stops: orange horizon, rose middle, violet (blue > red) zenith.
    const dusk = GradientSkyPresets.dusk;
    expect(dusk.midHeight).toBeGreaterThan(0);
    expect(dusk.horizon[0]).toBeGreaterThan(dusk.horizon[2] * 5);
    expect(dusk.zenith[2]).toBeGreaterThan(dusk.zenith[0]);
    expect(dusk.zenith[0]).toBeGreaterThan(dusk.zenith[1]);
  });

  it('gives the scene-referred disc radiance from the light intensity', () => {
    const values = packGradientSkyParams(
      sky({ toneMapped: true }),
      sun,
      undefined,
      output,
      'scene',
    );
    const gain = sun.intensity * GRADIENT_SKY_SUN_DISC_GAIN;
    expect([...values.subarray(16, 19)]).toEqual([1, 0.5, 0.25].map((v) => v * gain));
    expect(values[11]).toBe(0);
  });

  it('draws no disc without a sun or with sunSize 0, and ignores an inactive Fog', () => {
    expect(packGradientSkyParams(sky(), undefined, fog, output, 'display')[15]).toBe(0);
    expect(packGradientSkyParams(sky({ sunSize: 0 }), sun, fog, output, 'display')[15]).toBe(0);
    const inactive = { ...fog, maxOpacity: 0 };
    expect(packGradientSkyParams(sky(), sun, inactive, output, 'display')[11]).toBe(0);
  });

  it('clears the main pass transparent under a GradientSky, else to the camera clearColor', () => {
    const camera = [0.2, 0.3, 0.4, 1] as const;
    expect(gradientSkyClearColor(sky(), camera)).toEqual([0, 0, 0, 0]);
    expect(gradientSkyClearColor(sky({ toneMapped: true }), camera)).toEqual([0, 0, 0, 0]);
    expect(gradientSkyClearColor(undefined, camera)).toEqual([0.2, 0.3, 0.4, 1]);
  });

  it('routes the sky to exactly one domain by toneMapped', () => {
    expect(gradientSkyIn(sky(), 'display')).toBe(true);
    expect(gradientSkyIn(sky(), 'scene')).toBe(false);
    expect(gradientSkyIn(sky({ toneMapped: true }), 'scene')).toBe(true);
    expect(gradientSkyIn(undefined, 'display')).toBe(false);
  });

  it('adds the display sun to the bloomed HDR scene only when bloom is admitted', () => {
    const bloom = { bloom: 'on', bloomIntensity: 0.3 } as const;
    expect(gradientSkySunBlooms(sky(), sun, bloom)).toBe(true);
    expect(gradientSkySunBlooms(sky(), sun, { ...bloom, bloom: 'off' })).toBe(false);
    expect(gradientSkySunBlooms(sky(), sun, { ...bloom, bloomIntensity: 0 })).toBe(false);
    expect(gradientSkySunBlooms(sky({ sunSize: 0 }), sun, bloom)).toBe(false);
    expect(gradientSkySunBlooms(sky(), undefined, bloom)).toBe(false);
    expect(gradientSkySunBlooms(sky(), { ...sun, intensity: 0 }, bloom)).toBe(false);
    // A toneMapped sky already draws its disc in the scene.
    expect(gradientSkySunBlooms(sky({ toneMapped: true }), sun, bloom)).toBe(false);
  });
});
