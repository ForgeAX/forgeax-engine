import type { TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';
import { sel } from '../selectors';
import { idTexture, textureFrom } from '../texture';

/**
 * Audit B20 A13: material-ID maps point-sample their mips, so every level holds only the
 * IDs of level 0; the box filter blended neighbouring IDs into colors of no slot.
 */

/** Distinct RGBA colors per packed level. */
function levelColors(t: TextureAsset): Set<string>[] {
  const { width, height } = t.shape.extent;
  const out: Set<string>[] = [];
  let offset = 0;
  for (let w = width, h = height; ; w = Math.max(1, w >> 1), h = Math.max(1, h >> 1)) {
    const colors = new Set<string>();
    for (let i = 0; i < w * h; i++) {
      const o = offset + i * 4;
      colors.add(Array.from((t.data as Uint8Array).subarray(o, o + 4)).join(','));
    }
    out.push(colors);
    offset += w * h * 4;
    if (w === 1 && h === 1) break;
  }
  return out;
}

const subset = (a: Set<string>, b: Set<string>) => [...a].every((c) => b.has(c));

describe('material-ID mips keep IDs', () => {
  it.each([
    false,
    true,
  ])('keeps category colors through supersampling, filtering and gutter fill (authored: %s)', (authored) => {
    const base = model();
    base.plane({ width: 1, height: 1 });
    const mesh = base.editMesh;
    for (const face of mesh.faces()) {
      for (const half of mesh.faceHalves(face)) {
        const [x, y] = mesh.position(mesh.hVert[half] as number);
        mesh.setCorner('uv0', half, [0.5 + x * 0.6, 0.5 + y * 0.6]);
      }
    }
    const detail = model();
    for (const [name, left, right] of [
      ['left', -0.5, 0.013],
      ['right', 0.013, 0.5],
    ] as const) {
      detail.polygon({
        points: [
          [left, -0.5, 0],
          [right, -0.5, 0],
          [right, 0.5, 0],
          [left, 0.5, 0],
        ],
        material: name,
      });
    }
    const result = bakeMaps({
      base,
      detail,
      maps: authored ? ['opacity', 'materialId', 'baseColor'] : ['materialId', 'baseColor'],
      resolution: 32,
      samples: 4,
      filter: 'bspline',
      gutter: 4,
      cage: { offset: 0.01, maxRay: 0.02 },
      slots: {
        left: { baseColor: [1, 0, 0, 1], ...(authored ? { materialId: [1, 0, 0] as const } : {}) },
        right: { baseColor: [0, 1, 0, 1], ...(authored ? { materialId: [0, 1, 0] as const } : {}) },
      },
    });
    if (!result.ok) throw result.error;
    const allowed = new Set(['0,0,0,255']);
    for (const { color } of result.value.provenance.materials) {
      const encoded = idTexture(
        1,
        1,
        () => [color[0] as number, color[1] as number, color[2] as number, 1],
        false,
      );
      if (!encoded.ok) throw encoded.error;
      allowed.add(Array.from(encoded.value.data as Uint8Array).join(','));
    }
    for (const level of levelColors(result.value.textures.materialId as TextureAsset)) {
      expect(
        subset(level, allowed),
        JSON.stringify([...level].filter((color) => !allowed.has(color))),
      ).toBe(true);
    }
    // Appearance remains continuous: its color filter still averages the red/green boundary.
    const appearanceIds = new Set(['0,0,0,0', '255,0,0,255', '0,255,0,255']);
    expect(
      [...(levelColors(result.value.textures.baseColor as TextureAsset)[0] as Set<string>)].some(
        (color) => !appearanceIds.has(color),
      ),
    ).toBe(true);
  });

  it('idTexture levels hold only level-0 colors (falsifier: the box chain blends them)', () => {
    const texel = (x: number, y: number) =>
      ((x >> 2) + (y >> 2)) % 2 === 0
        ? ([0.9, 0.12, 0.1, 1] as const)
        : ([0.1, 0.65, 0.15, 1] as const);
    const id = idTexture(32, 32, texel, true);
    const box = textureFrom(32, 32, texel, { colorSpace: 'srgb' });
    if (!id.ok || !box.ok) throw new Error('texture failed');
    expect(id.value).toMatchObject({ colorSpace: 'srgb', mips: { kind: 'packed', levelCount: 6 } });
    // Level 0 is byte-identical to the color texture of the same texels.
    expect(id.value.data.subarray(0, 32 * 32 * 4)).toEqual(box.value.data.subarray(0, 32 * 32 * 4));
    const ids = levelColors(id.value);
    expect(ids[0]?.size).toBe(2);
    for (const level of ids) expect(subset(level, ids[0] as Set<string>)).toBe(true);
    const boxed = levelColors(box.value);
    expect(boxed.some((level) => !subset(level, boxed[0] as Set<string>))).toBe(true);
  });

  it('bakeMaps materialId mips hold only palette IDs', () => {
    const RES = 64;
    const base = model();
    base.plane({ width: 1, height: 1, widthSegments: 2 });
    base.uv.auto({ resolution: RES, padding: 2 });
    const detail = model();
    detail.append(base);
    detail.assign(sel.inBox([0, -9, -9], [9, 9, 9], { by: 'centroid' }), 'steel');
    const r = bakeMaps({ base, detail, maps: ['materialId'], resolution: RES, filter: 'none' });
    if (!r.ok) throw r.error;
    const id = r.value.textures.materialId as TextureAsset;
    expect(id.mips).toMatchObject({ kind: 'packed' });
    const levels = levelColors(id);
    expect(levels[0]?.size).toBeGreaterThanOrEqual(2);
    for (const level of levels) expect(subset(level, levels[0] as Set<string>)).toBe(true);
  });
});
