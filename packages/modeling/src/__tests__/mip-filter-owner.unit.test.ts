import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { r16Texture } from '../texture';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Every kernel source file outside tests and the Node-only tools. */
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory())
      return e.name === '__tests__' || e.name === 'tools' ? [] : sources(join(dir, e.name));
    return e.name.endsWith('.ts') ? [join(dir, e.name)] : [];
  });
}

describe('one mip filter (R6: mipChain owns every texel mip chain)', () => {
  it('no source outside texture.ts averages a 2x2 footprint into a mip level', () => {
    // A texel mip loop walks the 2x2 offset table and divides the sum by 4 right after it
    // (the chart-ownership pyramid in the bake walks the table but merges ids, not values).
    const table = /\[0, 0\],\s*\[1, 0\],\s*\[0, 1\],\s*\[1, 1\],/g;
    const owners = sources().filter((file) => {
      const code = readFileSync(file, 'utf8');
      return [...code.matchAll(table)].some((m) =>
        /\/ 4\b/.test(code.slice(m.index, m.index + 900)),
      );
    });
    expect(owners.map((f) => f.slice(SRC.length))).toEqual(['texture.ts']);
  });

  it('r16Texture packs the shared linear box chain as 16-bit texels', () => {
    const t = r16Texture(4, 4, (x, y) => (x + y * 4) / 15, true);
    expect(t).toMatchObject({ format: 'r16unorm', mips: { kind: 'packed', levelCount: 3 } });
    const view = new DataView(t.data.buffer, t.data.byteOffset, t.data.byteLength);
    // Level 1 texel 0 averages (0, 1, 4, 5) / 15; level 2 is the mean 7.5 / 15.
    expect(view.getUint16(32, true)).toBe(Math.round((2.5 / 15) * 65535));
    expect(Math.abs(view.getUint16(40, true) - 0.5 * 65535)).toBeLessThanOrEqual(0.5);
    expect(t.data.byteLength).toBe((16 + 4 + 1) * 2);
  });
});
