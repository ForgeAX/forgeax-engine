import { vec3 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import { packLights, packSettings, type RayPathSettings } from '../../raytracing/path-input';

// Extraction pre-multiplies `color * intensity` (render-system-extract
// LightSnapshot contract); the GI lane receives those snapshots unchanged, so
// transport must not scale by intensity a second time.
describe('packLights', () => {
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
