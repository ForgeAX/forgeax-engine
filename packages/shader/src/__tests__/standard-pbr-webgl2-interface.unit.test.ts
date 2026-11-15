import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const standardPbrSource = readFileSync(
  fileURLToPath(new URL('../default-standard-pbr.wgsl', import.meta.url)),
  'utf8',
);
const standardPbrSkinSource = readFileSync(
  fileURLToPath(new URL('../default-standard-pbr-skin.wgsl', import.meta.url)),
  'utf8',
);

describe('standard PBR WebGL2 interface', () => {
  it('reads view depth from the fragment position and carries only the object position', () => {
    for (const source of [standardPbrSource, standardPbrSkinSource]) {
      expect(source).toContain('@location(7) positionOS : vec3<f32>');
      expect(source).not.toContain('positionOSAndViewZ');
      expect(source).not.toMatch(/@location\(\d+\)\s+ndc\s*:/u);
      expect(source).toContain('sceneFragmentViewZ(in.clip, view.temporalProjection)');
      expect(source).not.toContain('@location(4) positionOS : vec3<f32>');
      expect(source).not.toContain('@location(15) positionOS : vec3<f32>');
      expect(source).not.toContain('@location(4) @interpolate(flat) instanceIdx : u32');
    }
  });

  it('retains the compact object basis locations shared by transmission and projection', () => {
    for (const source of [standardPbrSource, standardPbrSkinSource]) {
      expect(source).toContain('@location(4) @interpolate(flat) objectBasis0 : vec4<f32>');
      expect(source).toContain('@location(13) @interpolate(flat) objectBasis1 : vec4<f32>');
      expect(source).toContain('@location(6) @interpolate(flat) objectBasis2 : f32');
      expect(source).not.toContain('@location(15) @interpolate(flat) objectBasis1 : vec4<f32>');
    }
  });
});
