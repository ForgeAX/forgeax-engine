import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(
  fileURLToPath(new URL('../default-standard-pbr.wgsl', import.meta.url)),
  'utf8',
);
const surface = readFileSync(
  fileURLToPath(new URL('../default_standard_surface.wgsl', import.meta.url)),
  'utf8',
);

describe('standard PBR MASK alpha contract', () => {
  it('multiplies factor alpha by sampled texture alpha before discard', () => {
    expect(surface).toContain(
      'clamp(materialValue.baseColor.a * baseSample.a * vertexColor.a * alpha, 0.0, 1.0)',
    );
    expect(surface).toContain('return evaluate_standard_surface(input, material)');
  });

  it('matches Three r184 alphaTest by discarding values equal to or below cutoff', () => {
    expect(shader).toContain('surface.opacity <= surface.alphaClipThreshold');
    expect(shader).not.toContain('surface.opacity < surface.alphaClipThreshold');
  });

  it('keeps alpha PBR on the shared Directional factor path', () => {
    expect(shader).toContain('lighting_directional');
    expect(shader.match(/evalDirectionalShadowFactorAtPixel\(/g)).toHaveLength(1);
    expect(shader).toContain('evaluateStandardDirect(');
    expect(shader).toContain('directionalClearcoat');
  });
});
