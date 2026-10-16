import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) =>
  readFileSync(new URL(`../material/physical/${name}`, import.meta.url), 'utf8');

describe('clearcoat physical shader layer', () => {
  it('owns the top-layer Fresnel attenuation and coat normal inputs', () => {
    const clearcoat = source('clearcoat.wgsl');
    expect(clearcoat).toContain('clearcoatRoughness');
    expect(clearcoat).toContain('clearcoatNormalScale');
    expect(clearcoat).toContain('fresnel');
    expect(clearcoat).toMatch(/base.*attenuat|attenuat.*base/i);
  });

  it('keeps standard and skinned roots on one physical module contract', () => {
    const standard = readFileSync(new URL('../default-standard-pbr.wgsl', import.meta.url), 'utf8');
    const skin = readFileSync(
      new URL('../default-standard-pbr-skin.wgsl', import.meta.url),
      'utf8',
    );
    expect(standard).toContain('clearcoat');
    expect(skin).toContain('clearcoat');
    expect(standard).toContain('#import forgeax_pbr::clearcoat');
    expect(skin).toContain('#import forgeax_pbr::clearcoat');
    expect(standard).not.toMatch(/clearcoat[A-Za-z]*Shadow/);
    expect(skin).not.toMatch(/clearcoat[A-Za-z]*Shadow/);
  });

  it('routes clearcoat direct and IBL through complete lighting facts', () => {
    const roots = [
      readFileSync(new URL('../default-standard-pbr.wgsl', import.meta.url), 'utf8'),
      readFileSync(new URL('../default-standard-pbr-skin.wgsl', import.meta.url), 'utf8'),
    ];

    for (const root of roots) {
      expect(root).toMatch(/let clearcoatDirect = directionalShadow \* evalDirectionalNoShadow\(/);
      expect(root).toContain('clearcoatRoughnessValue * clearcoatRoughnessValue');
      expect(root).toContain('clearcoatIbl * specularEnvironmentScale * ao');
      expect(root).not.toContain('clearcoatIbl * skylight.colorR');
    }
  });

  it('keeps rigid and skinned physical lighting on the same spot/transmission contract', () => {
    const standard = readFileSync(new URL('../default-standard-pbr.wgsl', import.meta.url), 'utf8');
    const skin = readFileSync(
      new URL('../default-standard-pbr-skin.wgsl', import.meta.url),
      'utf8',
    );

    for (const root of [standard, skin]) {
      expect(root).toContain(
        'color += evaluateStandardDirect(in.worldPos, in.ndc.xyz, standardViewZ(in),',
      );
      expect(root).toContain(
        'physicalNormal, v, diffuseAlbedo, transmissionAlbedo, metallic, a, f0, directionalShadow',
      );
      expect(root).toContain('let safeIor = max(finiteScalar(material.ior, 1.5), 1.0);');
      expect(root).toContain('transmissionBackdropTexture');
      expect(root).toContain('let transmittedEnergy = select(');
    }
    expect(skin).toContain(
      'var anisotropyStrength = finiteScalar(material.anisotropyStrength, 0.0);',
    );
    expect(skin).toContain('var anisotropyDirection = vec2<f32>(1.0, 0.0);');
  });
});
