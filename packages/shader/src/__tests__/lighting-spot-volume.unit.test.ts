import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const attenuation = readFileSync(new URL('../lighting-attenuation.wgsl', import.meta.url), 'utf8');
const punctual = readFileSync(new URL('../lighting-punctual.wgsl', import.meta.url), 'utf8');

describe('shared Spot volume optics', () => {
  it('uses finite squared distance attenuation and a smooth cosine cone', () => {
    expect(attenuation).toContain('evalSpotAttenuation');
    expect(attenuation).toContain('invRangeSquared');
    expect(attenuation).toContain('smoothstep(cosOuter, cosInner');
  });

  it('is consumed by the surface punctual owner', () => {
    expect(punctual).toContain('forgeax_pbr::lighting_attenuation');
    expect(punctual).toContain('evalSpotAttenuation');
  });

  it('keeps invalid range and cone inputs finite at the shared boundary', () => {
    expect(attenuation).toContain('max(dSquared, nearFloor)');
    expect(attenuation).toContain('evalDistanceAttenuation(dSquared, invRangeSquared, 2.0, 1e-4)');
    expect(attenuation).toContain('clamp');
    expect(attenuation).toContain('cosInner');
    expect(attenuation).toContain('cosOuter');
  });
});
