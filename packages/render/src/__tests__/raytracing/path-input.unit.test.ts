import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { degToCos, validateSpotLightData } from '../../components/light-helpers';
import {
  onlyPrimaryDirectionalColorChanged,
  packLights,
  packSettings,
  type RayPathSettings,
} from '../../raytracing/path-input';
import type { SpotLightSnapshot } from '../../render-system-extract';

// Extraction pre-multiplies `color * intensity` (render-system-extract
// LightSnapshot contract); the GI lane receives those snapshots unchanged, so
// transport must not scale by intensity a second time.
describe('packLights', () => {
  const spot = (cosInner: number, cosOuter = cosInner): SpotLightSnapshot => ({
    kind: 'spot',
    position: vec3.create(0, 0, 2),
    direction: vec3.create(0, 0, -1),
    color: vec3.create(8, 4, 2),
    intensity: 8,
    invRangeSquared: 0,
    cosInner,
    cosOuter,
    castShadow: false,
    lightViewProj: undefined,
    mapSize: 1024,
    nearPlane: 0.5,
    farPlane: 500,
    shadowAtlasTile: -1,
  });

  it.each([
    15, 45, 89,
  ])('retains an authored %s degree hard-cone SpotLight in Card and probe input', (angle) => {
    expect(
      validateSpotLightData({
        direction: [0, 0, -1],
        innerConeDeg: angle,
        outerConeDeg: angle,
      }).ok,
    ).toBe(true);
    const cosine = degToCos(angle);
    const result = packLights([spot(cosine)]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error.expected);
    const row = new Float32Array(result.value.buffer);
    expect(Array.from(row.slice(4, 7))).toEqual([8, 4, 2]);
    expect(Array.from(row.slice(12, 14))).toEqual([Math.fround(cosine), Math.fround(cosine)]);
  });

  it('keeps reversed and nonfinite Spot cones unavailable while retaining a real penumbra', () => {
    expect(packLights([spot(0.5, 0.75)]).ok).toBe(false);
    expect(packLights([spot(NaN, 0.5)]).ok).toBe(false);
    expect(packLights([spot(0.75, Infinity)]).ok).toBe(false);
    expect(packLights([spot(1.01, 0.5)]).ok).toBe(false);
    expect(packLights([spot(0.5, -1.01)]).ok).toBe(false);
    expect(packLights([spot(0.75, 0.5)]).ok).toBe(true);
  });

  it('distinguishes primary directional radiance from changes to the transport source', () => {
    const lamp = spot(0.75, 0.5);
    const sun = {
      kind: 'directional',
      direction: vec3.create(0, -1, 0),
      color: vec3.create(0.01, 0.02, 0.03),
      intensity: 0.03,
      contactShadowLength: 0,
    } as const;
    const rotated = { ...sun, direction: vec3.create(0, -1, 1) };
    const changedSun = { ...sun, color: vec3.create(0.02, 0.04, 0.06) };
    const changedLamp = { ...lamp, color: vec3.create(1, 2, 3) };
    const packed = packLights([lamp, sun]).unwrap();
    const compare = (...lights: Parameters<typeof packLights>[0]) =>
      onlyPrimaryDirectionalColorChanged(packed, packLights(lights).unwrap());
    expect(compare(lamp, changedSun)).toBe(true);
    expect(compare(lamp, sun)).toBe(false);
    expect(compare(lamp, rotated)).toBe(false);
    expect(compare(changedLamp, changedSun)).toBe(false);
    expect(compare(changedSun, lamp)).toBe(false);
    expect(compare(changedSun)).toBe(false);
    expect(
      onlyPrimaryDirectionalColorChanged(
        packLights([sun, sun]).unwrap(),
        packLights([sun, changedSun]).unwrap(),
      ),
    ).toBe(false);
  });

  it('packs extracted light color as radiance without re-applying intensity', () => {
    const intensity = 12;
    const packed = new Float32Array(
      packLights([
        {
          kind: 'point',
          position: vec3.create(0, 1, 0),
          color: vec3.create(1 * intensity, 0.5 * intensity, 0.25 * intensity),
          intensity,
          invRangeSquared: 0.01,
          shadowAtlasLayer: -1,
        },
        {
          kind: 'directional',
          direction: vec3.create(0, -1, 0),
          color: vec3.create(3, 3, 3),
          intensity: 3,
          contactShadowLength: 0,
        },
      ]).unwrap().buffer,
    );
    expect(Array.from(packed.slice(4, 7))).toEqual([12, 6, 3]);
    expect(Array.from(packed.slice(20, 23))).toEqual([3, 3, 3]);
  });
});

describe('packSettings receiver', () => {
  const base = {
    width: 8,
    height: 8,
    camera: { origin: [0, 0, 2], target: [0, 0, 0], up: [0, 1, 0], verticalFov: 0.5 },
    maxBounces: 2,
    seed: 1,
    environment: [1, 1, 1],
    maxDistance: 100,
  } satisfies RayPathSettings;
  const receiverWord = (s: RayPathSettings) =>
    new Float32Array(packSettings(s).unwrap().buffer)[15];

  it('packs the diffuse receiver flag and defaults to the full BSDF', () => {
    expect(receiverWord(base)).toBe(0);
    expect(receiverWord({ ...base, receiver: 'full' })).toBe(0);
    expect(receiverWord({ ...base, receiver: 'diffuse' })).toBe(1);
  });

  it('rejects an unknown receiver', () => {
    const bad = { ...base, receiver: 'specular' } as unknown as RayPathSettings;
    expect(packSettings(bad).ok).toBe(false);
  });
});
