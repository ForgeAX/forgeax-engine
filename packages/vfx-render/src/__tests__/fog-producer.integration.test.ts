import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shaderNames = ['billboard', 'mesh', 'ribbon', 'trail', 'beam'] as const;

function shaderSource(name: (typeof shaderNames)[number]): string {
  return readFileSync(fileURLToPath(new URL(`../shaders/${name}.wgsl`, import.meta.url)), 'utf8');
}

describe('VFX fog composition contract', () => {
  it('fogs every clip-space particle topology at its own depth through the shared View fog', () => {
    for (const name of ['billboard', 'ribbon', 'trail', 'beam'] as const) {
      const source = shaderSource(name);
      expect(source, name).toContain('#import forgeax_view::fog::{translucent_fog, ndc_world}');
      expect(source, name).toContain('translucent_fog(view, ndc_world(view, input.clip_position),');
      expect(source, name).not.toMatch(/\bFogViewParams\b|\bview_fog\s*\(|texture_3d|raymarch/i);
    }
    // Mesh particles fog through the shared Standard surface at their world position.
    const surface = readFileSync(
      fileURLToPath(new URL('../../../shader/src/standard-surface.wgsl', import.meta.url)),
      'utf8',
    );
    expect(shaderSource('mesh')).toContain('evaluateStandardSurface(');
    expect(surface).toContain(
      'translucent_fog_transmission(view, in.worldPos, color, alpha, transmittedContribution, transmittedCoefficient)',
    );
  });

  it('keeps VFX coverage on the current graphics feature lane', () => {
    const feature = readFileSync(
      fileURLToPath(new URL('../feature/gpu-particle-feature.ts', import.meta.url)),
      'utf8',
    );
    const camera = readFileSync(
      fileURLToPath(new URL('../feature/camera.ts', import.meta.url)),
      'utf8',
    );
    expect(feature).toContain('requiredCapabilities');
    expect(feature).toContain('identity: IDENTITY');
    expect(feature).not.toMatch(/fog(?:History|Texture|Registry)/i);
    expect(feature).toContain('worldCenter');
    expect(camera).toContain('position');
    expect(camera).toContain('viewProjection');
  });

  it('keeps billboard scene-depth soft-particle alpha in the final color', () => {
    const billboard = shaderSource('billboard');
    const depthLoad = billboard.indexOf('textureLoad(scene_depth');
    const softParticleCall = billboard.indexOf('softParticle(input.position');
    const finalColor = billboard.indexOf(
      'translucent_fog(view, ndc_world(view, input.clip_position), rgb * alpha, alpha)',
    );

    expect(depthLoad).toBeGreaterThanOrEqual(0);
    expect(softParticleCall).toBeGreaterThan(depthLoad);
    expect(finalColor).toBeGreaterThan(softParticleCall);
    expect(billboard).toContain('input.color.a * edge, input.fade_distance');
    expect(billboard).toContain('@group(0) @binding(1) var scene_depth: texture_depth_2d;');
  });
});
