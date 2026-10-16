import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const shader = readFileSync(resolve(import.meta.dirname, '../default-standard-pbr.wgsl'), 'utf8');

describe('standard transmission thickness scale contract', () => {
  it('converts local authored thickness through the combined local-to-world basis', () => {
    expect(shader).toContain('@location(4) @interpolate(flat) objectBasis0 : vec4<f32>');
    expect(shader).toContain('@location(13) @interpolate(flat) objectBasis1 : vec4<f32>');
    // Scene-index Standard uses location 15 for its flat material/probe address and LOD coverage
    // when transmission is disabled.  Keep this assertion scoped to the
    // transmission ABI: it must not claim that the unrelated scene-index
    // varying is absent from the shared source template.
    expect(shader).toMatch(
      /@location\(15\)\s+@interpolate\(flat\)\s+materialAddress\s+:\s+vec4<u32>/,
    );
    expect(shader).not.toMatch(/@location\(15\)[^\n]*thickness/i);
    expect(shader).toContain('let objectToWorld = standardObjectToWorld(in);');
    expect(shader).toContain('let localToWorld0 = objectToWorld[0];');
    expect(shader).toContain('let localToWorld2 = objectToWorld[2];');
    expect(shader).toContain('let worldToLocal0 = vec3<f32>(');
    expect(shader).toContain('let worldRefractedDirection =');
    expect(shader).toMatch(
      /finiteScalar\(material\.thickness, 0\.0\) \* length\(worldRefractedDirection\) \*\s+finiteScalar\(thicknessSample, 1\.0\)/,
    );
  });
});
