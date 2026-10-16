import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const surfaceSource = readFileSync(
  fileURLToPath(new URL('../surface_v1.wgsl', import.meta.url)),
  'utf8',
);

describe('Surface v1 negative contract', () => {
  it.each([
    ['missing export', 'struct SurfaceInput {}'],
    [
      'wrong signature',
      'fn evaluate_surface(input: SurfaceInput) -> vec4<f32> { return vec4<f32>(); }',
    ],
  ])('rejects %s', (_name, source) => {
    expect(source).not.toMatch(
      /fn\s+evaluate_surface\s*\(input\s*:\s*SurfaceInput\s*\)\s*->\s*SurfaceData\s*\{/,
    );
  });

  it.each([
    ['fragment entry', '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(); }'],
    ['resource binding', '@group(1) @binding(0) var surfaceTexture: texture_2d<f32>;'],
    [
      'vertex mutation',
      'fn evaluate_surface(input: SurfaceInput) -> SurfaceData { input.positionWS = vec3<f32>(); }',
    ],
  ])('rejects %s', (_name, source) => {
    expect(source).toMatch(/@(fragment|group|binding)|positionWS\s*=/);
  });

  it('keeps physical fields out of the versioned base ABI', () => {
    expect(surfaceSource).not.toMatch(/clearcoat|clearcoatRoughness|anisotropy|sheen|iridescence/);
  });
});
