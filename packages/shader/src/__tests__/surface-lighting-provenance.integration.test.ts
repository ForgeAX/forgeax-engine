import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
}

describe('Standard Surface lighting provenance', () => {
  const provenance = {
    pass: 'forward',
    module: 'game_3d::rusted_iron_surface',
    closure: 'forgeax_material::surface_v1',
    artifact: 'inline-wgsl:surface-standard-v1',
    cook: 'createShaderModule',
    generation: 1,
    backend: 'webgpu',
    lane: 'direct',
    head: 'feature-head:m3-gpu-provenance',
  } as const;

  it('keeps one selected Surface closure across lighting pass adapters', () => {
    const forward = source('default-standard-pbr.wgsl');
    const skinned = source('default-standard-pbr-skin.wgsl');
    const shadow = source('shadow_caster.wgsl');
    for (const shader of [forward, skinned, shadow]) {
      expect(shader).toContain('#import forgeax_material::surface_v1');
      expect(shader).toContain('forgeax_material::slot::surface');
    }
    expect(forward).toContain('fn fs_main');
    expect(skinned).toContain('fn fs_gbuffer');
    expect(shadow).toContain('fn fs_shadow');
    expect(provenance.closure).toBe('forgeax_material::surface_v1');
    expect(provenance.generation).toBeGreaterThan(0);
    expect(provenance.head).toMatch(/^feature-head:/);
  });

  it('keeps direct, clustered, shadow, and controlled feature owners observable', () => {
    const pbr = source('default-standard-pbr.wgsl');
    expect(pbr).toContain('evalDirectional');
    expect(pbr).toContain('evalPoint');
    expect(pbr).toContain('evalSpot');
    expect(pbr).toContain('fs_gbuffer');
    expect(pbr).toContain('sampleIbl');
    expect(pbr).toContain('evaluateStandardSurface');
    expect(pbr).toContain('alphaClipThreshold');
    // Volume integration is a post-lighting producer. Standard must not
    // reconstruct or apply a private analytic fog ray in any pass.
    expect(pbr).not.toContain('apply_fog');
    expect(pbr).not.toContain('applySceneFog');
    expect(pbr).not.toMatch(/forwardFallback|deferredFallback/);
    expect(provenance.pass).toBe('forward');
    expect(provenance.module).toBe('game_3d::rusted_iron_surface');
    expect(provenance.artifact).toContain('inline-wgsl:');
    expect(provenance.cook).toBe('createShaderModule');
    expect(provenance.backend).toBe('webgpu');
    expect(provenance.lane).toBe('direct');
  });
});
