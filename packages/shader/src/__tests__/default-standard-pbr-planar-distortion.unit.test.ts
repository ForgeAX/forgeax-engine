import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(
  fileURLToPath(new URL('../default-standard-pbr.wgsl', import.meta.url)),
  'utf8',
);

function body(name: string): string {
  const start = shader.indexOf(`fn ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  return shader.slice(start, shader.indexOf('\n}\n', start) + 2);
}

describe('Standard planar reflection normal distortion', () => {
  it('reads the strength from the planar uniform and the tilt from the shading normal', () => {
    const specular = body('standardPlanarSpecular');
    // Only the tilt away from the plane displaces the lookup; a flat normal is a mirror.
    expect(specular).toContain(
      'shadingNormal - planar.plane.xyz * dot(shadingNormal, planar.plane.xyz)',
    );
    expect(specular).toContain('normalize(to) * length(tilt) * planar.enabledAndPadding.y');
  });

  it('keeps plane membership on the geometric normal and distorts with the shading normal', () => {
    const specular = body('standardPlanarSpecular');
    expect(specular).toContain('dot(normal, planar.plane.xyz) < 0.999');
    // Off-screen fragments keep the environment; the distorted lookup stays inside the capture.
    expect(specular.indexOf('any(uv > vec2<f32>(1.0))')).toBeLessThan(
      specular.indexOf('var lookup'),
    );
    expect(specular).toContain('clamp(lookup, vec2<f32>(0.0), vec2<f32>(1.0))');
    expect(shader).toContain(
      'standardPlanarSpecular(in.worldPos, geometricNormal, physicalNormal, iblRoughness',
    );
  });
});
