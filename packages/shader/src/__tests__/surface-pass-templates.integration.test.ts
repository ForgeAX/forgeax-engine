import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
}

describe('Standard Surface pass templates', () => {
  it('imports the same Surface ABI in rigid and skinned templates', () => {
    for (const name of ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl']) {
      const shader = source(name);
      expect(shader).toContain('#pragma material_slot surface');
      expect(shader).toContain('#import forgeax_material::surface_v1');
      expect(shader).toContain('evaluate_surface');
      expect(shader).toContain('fs_gbuffer');
    }
  });

  it('keeps alpha clip in the shared shadow template without vertex mutation', () => {
    const shader = source('shadow_caster.wgsl');
    expect(shader).toContain('#pragma material_slot surface');
    expect(shader).toContain('#import forgeax_material::surface_v1');
    expect(shader).toContain('alphaClipThreshold');
    expect(shader).toContain('fn fs_shadow');
    expect(shader).not.toMatch(/\bin\.position\s*=|\bin\.positionWS\s*=/);
  });

  it('keeps the GPU scene palette base separate from the material row', () => {
    const shader = source('default-standard-pbr-skin.wgsl');
    expect(shader).toContain('paletteBase : u32');
    expect(shader).toContain('palette[paletteBase + in.skinIndex.x]');
    expect(shader).toContain('let materialIndex = visible.y;');
    expect(shader).not.toContain('meshes[visible.x]');
    expect(shader).toContain('let paletteBase = 0u;');
  });
});
