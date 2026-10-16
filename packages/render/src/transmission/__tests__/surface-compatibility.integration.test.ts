import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Materials } from '../../materials';

function shaderSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../../shader/src/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('Surface compatibility boundaries', () => {
  it('keeps transmission on its existing forward shading route', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      transmission: 1,
    });
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
    expect(material.passes?.map((pass) => pass.name)).not.toContain('deferred');
  });

  it('keeps the unlit sibling outside the Surface ABI', () => {
    const unlit = shaderSource('unlit.wgsl');
    expect(unlit).not.toContain('surface_v1');
    expect(unlit).not.toContain('fs_gbuffer');
    expect(unlit).toContain('fn fs_main');
  });

  it('keeps transmission fields out of the v1 Surface contract', () => {
    const surface = shaderSource('surface_v1.wgsl');
    expect(surface).not.toMatch(/transmission|thickness|attenuation/i);
    expect(surface).not.toMatch(/@(vertex|fragment|compute)/);
  });
});
