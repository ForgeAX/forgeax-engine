import { describe, expect, it } from 'vitest';
import { type BakeOptions, bakeMaps } from '../bake';
import { MATERIAL_ID_PALETTE } from '../compute/bake-ts';
import { model } from '../model';
import { bakeTrimSheet, trimSheet } from '../trim';

const COLORS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 1, 0],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1],
  [0, 0, 0],
  [0.5, 0, 0],
  [0, 0.5, 0],
] as const;
const BYTES = COLORS.map((color) =>
  color.map((channel) => (channel === 0.5 ? 188 : channel * 255)),
);

function bake(order = COLORS.map((_, i) => i), slots?: BakeOptions['slots']) {
  const base = model();
  base.plane({ width: 1, height: 1 });
  const mesh = base.editMesh;
  for (const face of mesh.faces()) {
    for (const half of mesh.faceHalves(face)) {
      const [x, y] = mesh.position(mesh.hVert[half] as number);
      mesh.setCorner('uv0', half, [x + 0.5, y + 0.5]);
    }
  }
  const detail = model();
  for (const i of order) {
    const left = i / COLORS.length - 0.5;
    const right = (i + 1) / COLORS.length - 0.5;
    detail.polygon({
      points: [
        [left, -0.5, 0],
        [right, -0.5, 0],
        [right, 0.5, 0],
        [left, 0.5, 0],
      ],
      material: `slot-${i}`,
    });
  }
  return bakeMaps({
    base,
    detail,
    maps: ['materialId', 'baseColor', 'opacity'],
    resolution: 40,
    samples: 1,
    cage: { offset: 0.01, maxRay: 0.02 },
    filter: 'none',
    gutter: 0,
    mips: false,
    ...(slots === undefined ? {} : { slots }),
  });
}

describe('authored material IDs', () => {
  it('keeps ten slot identities across slot order and appearance changes', () => {
    const slots = Object.fromEntries(
      COLORS.map((materialId, i) => [
        `slot-${i}`,
        { materialId, baseColor: [1, 0, 0, 1] as const },
      ]),
    );
    const first = bake(undefined, slots);
    const reversed = bake(
      COLORS.map((_, i) => COLORS.length - i - 1),
      Object.fromEntries(
        Object.entries(slots).map(([name, slot]) => [
          name,
          { ...slot, baseColor: [0, 1, 0, 1] as const },
        ]),
      ),
    );
    if (!first.ok) throw first.error;
    if (!reversed.ok) throw reversed.error;
    expect(reversed.value.textures.materialId?.data).toEqual(first.value.textures.materialId?.data);
    expect(reversed.value.textures.baseColor?.data).not.toEqual(
      first.value.textures.baseColor?.data,
    );
    const data = first.value.textures.materialId?.data as Uint8Array;
    for (const [i, color] of COLORS.entries()) {
      expect(
        first.value.provenance.materials.find((material) => material.slot === `slot-${i}`)?.color,
      ).toEqual(color);
      const at = (20 * 40 + i * 4 + 2) * 4;
      expect(Array.from(data.subarray(at, at + 3))).toEqual(BYTES[i]);
    }
  });

  it('uses the wildcard only for slots without an explicit ID and preserves legacy defaults', () => {
    const override = bake(undefined, {
      '*': { materialId: [0, 1, 1] },
      'slot-0': { materialId: [1, 0, 0] },
    });
    const legacy = bake();
    if (!override.ok) throw override.error;
    if (!legacy.ok) throw legacy.error;
    expect(override.value.textures.baseColor?.data).toEqual(legacy.value.textures.baseColor?.data);
    expect(override.value.textures.opacity?.data).toEqual(legacy.value.textures.opacity?.data);
    for (const material of override.value.provenance.materials) {
      expect(material.color).toEqual(material.slot === 'slot-0' ? [1, 0, 0] : [0, 1, 1]);
    }
    for (const [i, material] of legacy.value.provenance.materials.entries()) {
      expect(material.color).toEqual(MATERIAL_ID_PALETTE[i % MATERIAL_ID_PALETTE.length]);
    }
  });

  it.each([
    [1, 0],
    [1, 0, 0, 1],
    [NaN, 0, 0],
    [Infinity, 0, 0],
    [-0.1, 0, 0],
    [1.1, 0, 0],
    ['1', 0, 0],
    null,
  ])('rejects malformed IDs %j', (materialId) => {
    const result = bake(undefined, { 'slot-0': { materialId } } as never);
    expect(result.ok ? undefined : result.error.code).toBe('model-invalid-argument');
  });

  it('uses authored IDs in analytic and mesh trim regions', () => {
    const mesh = model();
    mesh.plane({ width: 0.1, height: 0.1, center: [0.05, 0.05, 0.002], material: 'mesh-slot' });
    const sheet = trimSheet({
      key: 'ids',
      size: 32,
      density: 80,
      modules: [
        {
          id: 'analytic',
          size: [0.1, 0.1],
          source: { kind: 'analytic', height: () => 0, material: () => 'analytic-slot' },
        },
        { id: 'mesh', size: [0.1, 0.1], source: { kind: 'mesh', detail: mesh } },
      ],
    });
    if (!sheet.ok) throw sheet.error;
    const result = bakeTrimSheet(sheet.value, {
      maps: ['materialId'],
      samples: 1,
      slots: {
        'analytic-slot': { materialId: [0, 1, 0] },
        'mesh-slot': { materialId: [1, 0, 1] },
      },
    });
    if (!result.ok) throw result.error;
    const bytes = result.value.textures.materialId?.data as Uint8Array;
    for (const [id, slot, color] of [
      ['analytic', 'analytic-slot', [0, 1, 0]],
      ['mesh', 'mesh-slot', [1, 0, 1]],
    ] as const) {
      expect(result.value.materials.find((material) => material.slot === slot)?.color).toEqual(
        color,
      );
      const region = sheet.value.regions[id];
      if (region === undefined) throw new Error(`Missing trim region ${id}`);
      const [x, y, width, height] = region.rect;
      const at = ((y + Math.floor(height / 2)) * 32 + x + Math.floor(width / 2)) * 4;
      expect(Array.from(bytes.subarray(at, at + 3))).toEqual(color.map((channel) => channel * 255));
    }
  });

  it('rejects sparse ID channels before rasterizing an analytic trim field', () => {
    const sheet = trimSheet({
      key: 'sparse-id',
      size: 16,
      density: 80,
      modules: [{ id: 'flat', size: [0.1, 0.1], source: { kind: 'flat', material: 'paint' } }],
    });
    if (!sheet.ok) throw sheet.error;
    const result = bakeTrimSheet(sheet.value, {
      maps: ['materialId'],
      slots: { paint: { materialId: new Array(3) } } as never,
    });
    expect(result.ok ? undefined : result.error.code).toBe('model-invalid-argument');
  });
});
