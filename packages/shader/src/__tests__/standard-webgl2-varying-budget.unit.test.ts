import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shaderFiles = ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl'] as const;

describe('Standard WebGL2 inter-stage varying budget', () => {
  it.each(shaderFiles)('%s packs Surface position and view depth into the last varying', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');

    expect(source).toContain('@location(7) positionOSAndViewZ : vec4<f32>');
    expect(source).not.toMatch(/@location\(15\)\s+positionOS\s*:/u);
    expect(source).toContain('out.positionOSAndViewZ = vec4<f32>(localPosition, sceneViewZ(');
    expect(source).toContain('in.positionOSAndViewZ.xyz');
    expect(source).toContain('in.positionOSAndViewZ.w');
  });

  // WebGPU's default maxInterStageShaderVariables is 16 and the fragment
  // front_facing input consumes one of them. The union over every define is
  // the worst case: vertex color, object basis and scene-index address together.
  it.each(shaderFiles)('%s keeps every VsOut variant within WebGPU inter-stage limits', (file) => {
    const source = readFileSync(resolve(import.meta.dirname, '..', file), 'utf8');
    const vsOut = /struct VsOut \{([\s\S]*?)\n\};/u.exec(source)?.[1] ?? '';
    const locations = new Set([...vsOut.matchAll(/@location\((\d+)\)/gu)].map((match) => match[1]));

    expect(locations.size).toBeGreaterThan(0);
    expect(locations.size + 1).toBeLessThanOrEqual(16);
  });
});
