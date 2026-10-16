import { describe, expect, it } from 'vitest';
import { reflectVfxLayout } from '../reflection.js';

describe('VFX Data Interface reflection', () => {
  it('derives managed requirements from explicit imports in deterministic order', () => {
    const result = reflectVfxLayout({
      root: `
        #import forgeax_vfx::data::scene_depth
        #import forgeax_vfx::data::camera
        #import forgeax_vfx::data::noise
      `,
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        dataInterfaces: [
          { token: 'vfx:camera', kind: 'camera', binding: 12, bindingType: 'uniform' },
          {
            token: 'vfx:scene-depth',
            kind: 'scene-depth',
            binding: 13,
            bindingType: 'sampled-depth',
          },
          { token: 'vfx:noise', kind: 'noise', binding: 14, bindingType: 'sampled-float' },
        ],
      },
    });
  });

  it('rejects the retired vfx:channel token while preserving event channels', () => {
    const result = reflectVfxLayout({
      root: '#import forgeax_vfx::data::channel',
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'vfx-reflection-unknown-data-interface',
        detail: { path: 'root:forgeax_vfx::data::channel' },
      },
    });
  });

  it('does not create a requirement from an undeclared resource name', () => {
    const result = reflectVfxLayout({ root: 'var<private> hidden_resource: u32;' });
    expect(result).toMatchObject({ ok: true, value: { dataInterfaces: [] } });
  });
});
