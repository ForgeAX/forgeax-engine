import {
  type Asset,
  type MaterialAsset,
  standardSurfaceParameters,
  type TerrainSource,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildTerrainAssets, terrainDerivedClosureValid } from '../closure.js';
import { cookTerrain } from '../cook.js';

function source(columns = 2, rows = 2, layers = 4, vertices = 2): TerrainSource {
  return {
    columns,
    rows,
    spacing: 1,
    subsectionVertices: vertices,
    heights: new Float32Array(columns * rows),
    weights: new Float32Array(columns * rows * layers),
    layers: Array.from({ length: layers }, (_, i) => ({
      material: `layer-${i}`,
      blend: 'weight' as const,
    })),
  };
}
const policy = (maxWeightError: number) => ({ kind: 'ids' as const, maxWeightError });
const material: MaterialAsset = {
  kind: 'material',
  parameters: standardSurfaceParameters([]),
  values: { baseColor: [0.5, 0.25, 0.125, 1] },
  passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
};
const assets = (s: TerrainSource): Record<string, Asset> =>
  Object.fromEntries(s.layers.map((layer) => [layer.material, material]));

describe('author weight to bounded ID specialization', () => {
  it('retains complete author values and rejects the actual top-two loss', () => {
    const s = source();
    s.weights.fill(0.25);
    const before = s.weights.slice();
    expect(cookTerrain(s, policy(0.49))).toMatchObject({
      ok: false,
      error: { code: 'terrain-layer-budget-exceeded' },
    });
    const built = buildTerrainAssets(s, (key) => key, assets(s), policy(0.51)).unwrap();
    expect(s.weights).toEqual(before);
    expect(built.terrain).toMatchObject({
      weights: before,
      layers: s.layers,
      materialEncoding: policy(0.51),
    });
    const control = built['section/0/weights'];
    if (control?.kind !== 'texture') throw new Error('ID control missing');
    expect(Array.from(control.data.subarray(0, 4))).toEqual([0, 1, 128, 0]);
    expect(
      terrainDerivedClosureValid(
        built.terrain as Extract<Asset, { kind: 'terrain' }>,
        new Map(Object.entries({ ...assets(s), ...built })),
      ),
    ).toBe(true);
  });
  it('includes bilinear-to-triangle loss even when no author layer is removed', () => {
    const s = source(2, 2, 2);
    s.weights.set([1, 0, 1, 0, 1, 0, 0, 1]);
    expect(cookTerrain(s, policy(0.24))).toMatchObject({
      ok: false,
      error: {
        code: 'terrain-layer-budget-exceeded',
        detail: { actual: { bound: 0.25 } },
      },
    });
    expect(cookTerrain(s, policy(0.25)).ok).toBe(true);
  });
  it('rejects nonlinear blend and mixed zero coverage instead of silently changing semantics', () => {
    for (const blend of ['alpha', 'height'] as const) {
      const s = source(2, 2, 1);
      const layer =
        blend === 'height'
          ? { material: 'layer-0', blend, height: 'height', heightRange: [0, 1] as const }
          : { material: 'layer-0', blend };
      expect(cookTerrain({ ...s, layers: [layer] }, policy(1))).toMatchObject({
        ok: false,
        error: { code: 'terrain-layer-invalid' },
      });
    }
    const mixed = source(2, 2, 1);
    mixed.weights[0] = 1;
    expect(cookTerrain(mixed, policy(1))).toMatchObject({
      ok: false,
      error: { code: 'terrain-layer-invalid', detail: { field: 'weights' } },
    });
    const zero = cookTerrain(source(2, 2, 1), policy(0)).unwrap();
    expect(Array.from(zero.sections[0]?.weights.data.subarray(0, 4) ?? [])).toEqual([
      255, 255, 0, 0,
    ]);
  });
  it('repairs every triangle globally and copies identical shared edges at author resolution', () => {
    const s = source(15, 15, 8, 8);
    for (let z = 0; z < s.rows; z++)
      for (let x = 0; x < s.columns; x++) {
        const bottom = (x + z * 3) % 8,
          top = (bottom + 1 + ((x + z) % 3)) % 8;
        s.weights[(z * s.columns + x) * 8 + bottom] = 0.95;
        s.weights[(z * s.columns + x) * 8 + top] = 0.05;
      }
    const result = cookTerrain(s, policy(1)).unwrap();
    expect(result.sections[0]?.activeLayers.length).toBe(8);
    let offset = 0;
    for (const size of [8]) {
      for (const section of result.sections) {
        const data = section.weights.data;
        for (let z = 0; z < size - 1; z++)
          for (let x = 0; x < size - 1; x++) {
            const p = z * size + x;
            for (const tri of [
              [p, p + 1, p + size],
              [p + size + 1, p + size, p + 1],
            ]) {
              const ids = new Set<number>();
              for (const node of tri) {
                ids.add(data[offset + node * 4] ?? -1);
                if ((data[offset + node * 4 + 2] ?? 0) || (data[offset + node * 4 + 3] ?? 0))
                  ids.add(data[offset + node * 4 + 1] ?? -1);
              }
              expect(ids.size).toBeLessThanOrEqual(3);
            }
          }
      }
      if (size > 1) {
        const a = result.sections[0]?.weights.data,
          b = result.sections[1]?.weights.data,
          c = result.sections[2]?.weights.data;
        if (!a || !b || !c) throw new Error('missing neighboring sections');
        for (let i = 0; i < size; i++) {
          expect(
            a.subarray(offset + (i * size + size - 1) * 4, offset + (i * size + size - 1) * 4 + 4),
          ).toEqual(b.subarray(offset + i * size * 4, offset + i * size * 4 + 4));
          expect(
            a.subarray(
              offset + ((size - 1) * size + i) * 4,
              offset + ((size - 1) * size + i) * 4 + 4,
            ),
          ).toEqual(c.subarray(offset + i * 4, offset + i * 4 + 4));
        }
      }
      offset += size * size * 4;
    }
  });
  it('shares source arrays globally and validates control, array and surface tampering', () => {
    const s = source(3, 3, 32);
    for (let i = 0; i < s.heights.length; i++) s.weights[i * 32 + 31] = 1;
    const built = buildTerrainAssets(s, (key) => key, assets(s), policy(0)).unwrap();
    const root = built.terrain;
    if (root?.kind !== 'terrain') throw new Error('missing root');
    const closure = new Map(Object.entries({ ...assets(s), ...built }));
    expect(root.sections).toHaveLength(4);
    expect(Object.keys(built).filter((key) => key.includes('color-layers'))).toEqual([
      'layers/terrain-color-layers',
    ]);
    const shared = built['layers/terrain-color-layers'];
    expect(shared).toMatchObject({ shape: { extent: { layers: 32 } } });
    expect(terrainDerivedClosureValid(root, closure)).toBe(true);
    if (shared?.kind !== 'texture') throw new Error('missing shared array');
    const originalByte = shared.data[0] ?? 0;
    shared.data[0] = originalByte ^ 1;
    expect(terrainDerivedClosureValid(root, closure)).toBe(false);
    shared.data[0] = originalByte;
    const neighbor = built['section/1/material'];
    if (neighbor?.kind !== 'material' || neighbor.parent !== undefined)
      throw new Error('missing neighbor');
    const neighborGuid = root.sections[1]?.material ?? '';
    const colorLayers = neighbor.values?.terrainColorLayers;
    if (colorLayers === undefined) throw new Error('missing color layers');
    closure.set(neighborGuid, {
      ...neighbor,
      values: {
        ...neighbor.values,
        terrainNormalHeightLayers: colorLayers,
      },
    });
    expect(terrainDerivedClosureValid(root, closure)).toBe(false);
    closure.set(neighborGuid, neighbor);
    const controls = built['section/0/weights'];
    if (controls?.kind !== 'texture') throw new Error('missing control');
    const old = controls.data[0];
    controls.data[0] = 0;
    expect(terrainDerivedClosureValid(root, closure)).toBe(false);
    controls.data[0] = old ?? 31;
    const surface = built['section/0/material'];
    if (surface?.kind !== 'material' || surface.parent !== undefined)
      throw new Error('missing surface');
    const pass = surface.passes?.[0];
    if (!pass) throw new Error('missing pass');
    closure.set(root.sections[0]?.material ?? '', {
      ...surface,
      passes: [
        {
          ...pass,
          program: {
            ...pass.program,
            moduleSlots: { surface: 'forgeax_material::terrain_surface' },
          },
        },
        ...(surface.passes?.slice(1) ?? []),
      ],
    });
    expect(terrainDerivedClosureValid(root, closure)).toBe(false);
  });
  it('retains fine author peaks instead of publishing unbounded coarse controls', () => {
    const s = source(4, 4, 2, 4);
    for (let z = 0; z < 4; z++)
      for (let x = 0; x < 4; x++) {
        s.weights[(z * 4 + x) * 2] = x === 1 ? 0 : 1;
        s.weights[(z * 4 + x) * 2 + 1] = x === 1 ? 1 : 0;
      }
    const result = cookTerrain(s, policy(1e-4)).unwrap();
    const control = result.sections[0]?.weights;
    expect(control?.mips).toEqual({ kind: 'none' });
    expect(control?.data).toHaveLength(4 * 4 * 4);
    expect(control?.data[4]).toBe(1);
    expect(result.sections[0]?.height.mips).toEqual({ kind: 'packed', levelCount: 3 });
  });
  it.each([-1, NaN, Infinity, 1.01])('rejects invalid loss budget %s', (budget) => {
    expect(cookTerrain(source(), policy(budget)).ok).toBe(false);
  });
});
