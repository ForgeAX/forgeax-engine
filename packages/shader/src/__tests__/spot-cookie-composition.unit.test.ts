import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readShader(name: string): Promise<string> {
  return readFile(new URL(`../${name}`, import.meta.url), 'utf8');
}

function extractSpotModifierFactors(source: string): string {
  const start = source.indexOf('fn spotModifierFactors(');
  const end = source.indexOf('\nfn evalSpotWithModifiers', start);
  return source.slice(start, end).replace(/\s+/g, '');
}

describe('Cookie RGBA Spot modifier composition', () => {
  it('rejects scalar Cookie sampling and applies linear RGB times alpha', async () => {
    const [standard, skin, modifiers, clustered, common, ies] = await Promise.all([
      readShader('default-standard-pbr.wgsl'),
      readShader('default-standard-pbr-skin.wgsl'),
      readShader('lighting-spot-modifiers.wgsl'),
      readShader('standard-cluster.wgsl'),
      readShader('common.wgsl'),
      readShader('lighting-ies-profile.wgsl'),
    ]);
    expect(standard).not.toContain('lighting_spot_modifiers::{spotModifierFactors}');
    expect(skin).not.toContain('lighting_spot_modifiers::{spotModifierFactors}');
    expect(clustered).toContain('lighting_spot_modifiers::{spotModifierFactors}');
    expect(standard).not.toContain('fn spotModifierFactors(');
    expect(skin).not.toContain('fn spotModifierFactors(');
    expect(modifiers).toContain(
      'textureSampleLevel(cookieTexture, spotModifierSampler, cookieUv, metadata.w, 0.0)',
    );
    expect(modifiers).toContain('cookieSample.rgb * cookieSample.a');
    expect(modifiers).not.toMatch(/textureSampleLevel\(cookieTexture[^\n]*\)\.r/);
    expect(modifiers).toContain('cookieMatrices[metadata.w]');
    expect(modifiers).toContain('metadata.w != 0xffffffffu');
    expect(modifiers).toContain('metadata.y == 0xffffffffu || (metadata.y & PROJECTOR_FLAG) == 0u');
    expect(modifiers).toContain('let right = normalize(cross(forward, referenceUp));');
    expect(modifiers).toContain('let depth = dot(outgoing, forward);');
    expect(modifiers).toContain('sampleIesProfile(vec3<f32>(rolledX, rolledY, depth), metadata.z)');
    expect(ies).toContain('iesProfileTexture, spotModifierSampler, uv, slice, 0.0).r');
    expect(common).toContain('@group(0) @binding(15) var<uniform> cookieMatrices');
  });

  it('keeps skin and non-skin sampling and missing-resource identity aligned', async () => {
    const [standard, skin, modifiers, clustered] = await Promise.all([
      readShader('default-standard-pbr.wgsl'),
      readShader('default-standard-pbr-skin.wgsl'),
      readShader('lighting-spot-modifiers.wgsl'),
      readShader('standard-cluster.wgsl'),
    ]);
    expect(extractSpotModifierFactors(standard)).toBe('');
    expect(extractSpotModifierFactors(skin)).toBe('');
    expect(modifiers).toContain('cookie : f32');
    expect(modifiers).toContain('brdf * range * cone * ies * cookie * shadow');
    expect(clustered).toContain('spotModifierFactors');
    expect(clustered).toContain(') * modifier');
  });
});
