import type { TerrainSource } from '@forgeax/engine-types';
import { type Asset, type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { buildTerrainAssets, terrainDerivedClosureValid } from '../closure.js';
import { cookTerrain } from '../cook.js';
import { terrainLayerWeights } from '../layers.js';
import { terrainVertexCoordinates } from '../lod.js';
import { terrainHeight, terrainHeightfield } from '../query.js';
import { terrainSurfaceHeight, terrainSurfaceVertex } from '../submitted-surface.js';
import { validateTerrain } from '../validation.js';

const source = (columns: number, rows: number, heights: number[]): TerrainSource => ({
  columns,
  rows,
  spacing: 1,
  subsectionVertices: 2,
  heights: Float32Array.from(heights),
  weights: new Float32Array(columns * rows).fill(1),
  layers: [{ material: 'material', blend: 'weight' }],
});
describe('Landscape foundation falsifiers', () => {
  it('reconstructs shader f32 height cancellation and preserves tiny nondegenerate triangles', () => {
    const cancellation = cookTerrain(source(2, 2, [-1e8, -0.1, -1e8, -0.1])).unwrap();
    const surface = {
      vertices: 2,
      width: 1,
      lod: 0,
      neighbors: [0, 0, 0, 0],
      heightRange: cancellation.heightRange,
      heights: defined(cancellation.sections[0]).height.data,
    };
    expect(terrainSurfaceVertex(surface, 1, 1)[1]).toBe(Math.fround(-0.1));
    expect(terrainSurfaceHeight(surface, 1, 1)).toBe(Math.fround(-0.1));
    const shifted = cookTerrain(source(2, 2, [0.1, 0.1, 0.1, 10000])).unwrap();
    const shiftedSurface = {
      ...surface,
      heightRange: shifted.heightRange,
      heights: defined(shifted.sections[0]).height.data,
    };
    const local = terrainSurfaceVertex(shiftedSurface, 0, 0);
    const posed = terrainSurfaceVertex(shiftedSurface, 0, 0, [7, 13], [100, 10000, 200]);
    expect(posed).toEqual([107, Math.fround(local[1] + 10000), 213]);
    expect(terrainSurfaceHeight(shiftedSurface, 107, 213, [7, 13], [100, 10000, 200])).toBe(
      posed[1],
    );
    expect(
      terrainSurfaceHeight(shiftedSurface, 107.25, 213.25, [7, 13], [100, 10000, 200]),
    ).not.toBe(local[1] + 10000);
    const tiny = cookTerrain({ ...source(2, 2, [1, 1, 1, 1]), spacing: 1e-7 }).unwrap();
    expect(
      terrainSurfaceHeight(
        {
          ...surface,
          width: 1e-7,
          heightRange: tiny.heightRange,
          heights: defined(tiny.sections[0]).height.data,
        },
        5e-8,
        5e-8,
      ),
    ).toBeCloseTo(1, 6);
  });
  it('rejects a successful source whose cooked range is not representable', () => {
    expect(cookTerrain(source(2, 2, [1e12, 1e12, 1e12, 1e12]))).toMatchObject({
      ok: false,
      error: { code: 'terrain-input-invalid', detail: { field: 'heightRange' } },
    });
    expect(cookTerrain(source(2, 2, [-3e38, 3e38, -3e38, 3e38])).ok).toBe(false);
    expect(
      cookTerrain(source(2, 2, [0, 3.4028234663852886e38, 0, 3.4028234663852886e38])),
    ).toMatchObject({
      ok: false,
      error: { code: 'terrain-input-invalid', detail: { field: 'heightRange' } },
    });
    const doubleRoundedOverflow = {
      ...source(11, 2, new Array(22).fill(0)),
      spacing: 3.4028234663852886e38 / 10,
    };
    expect(Math.fround(10 * doubleRoundedOverflow.spacing)).toBe(3.4028234663852886e38);
    expect(validateTerrain(doubleRoundedOverflow)).toMatchObject({
      ok: false,
      error: { code: 'terrain-input-invalid', detail: { field: 'spacing' } },
    });
    for (const spacing of [Number.MIN_VALUE, 1e39, 2e38]) {
      expect(validateTerrain({ ...source(3, 2, [0, 0, 0, 0, 0, 0]), spacing })).toMatchObject({
        ok: false,
        error: { code: 'terrain-input-invalid', detail: { field: 'spacing' } },
      });
    }
  });
  it('builds deterministic GUID-linked Standard arrays and rejects unsupported layer shaders', () => {
    const terrain = source(2, 2, [0, 0, 0, 1]);
    const material: MaterialAsset = {
      kind: 'material',
      colorSpace: 'linear',
      parameters: standardSurfaceParameters([]),
      values: { baseColor: [0.25, 0.5, 0.75, 1], roughness: 0.8 },
      passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
    };
    const built = buildTerrainAssets(terrain, (key) => key, { material }).unwrap();
    expect(built.terrain).toMatchObject({
      kind: 'terrain',
      materialEncoding: { kind: 'weights' },
      grids: ['grid/0'],
      sections: [{ heightTexture: 'section/0/height', material: 'section/0/material' }],
    });
    expect(built['section/0/terrain-color-layers']).toMatchObject({
      kind: 'texture',
      format: 'rgba16float',
      shape: { viewDimension: '2d-array', extent: { layers: 4 } },
    });
    expect(
      buildTerrainAssets(terrain, (key) => key, {
        material: { ...material, passes: [{ name: 'custom', program: { module: 'custom' } }] },
      }).ok,
    ).toBe(false);
    expect(
      buildTerrainAssets(terrain, (key) => key, {
        material: {
          ...material,
          values: { baseColorTexture: { texture: 'texture', sampler: 'sampler' } },
        },
      }).ok,
    ).toBe(false);
  });
  it('queries the actual quantized and morphed triangles rather than author heights', () => {
    const n = 8,
      heights = Array.from(
        { length: n * n },
        (_, i) => Math.sin((i % 8) * 2.3 + Math.floor(i / 8) * 1.7) * 2,
      );
    const terrain = { ...source(n, n, heights), subsectionVertices: n };
    const cooked = cookTerrain(terrain).unwrap(),
      section = defined(cooked.sections[0]);
    const surface = {
      vertices: n,
      width: n - 1,
      lod: 1.5,
      neighbors: [2, 1.5, 1.5, 1.5],
      heightRange: cooked.heightRange,
      heights: section.height.data,
    };
    const vertex = terrainSurfaceVertex(surface, 2, 1);
    expect(terrainSurfaceHeight(surface, vertex[0], vertex[2])).toBeCloseTo(vertex[1], 5);
    expect(terrainSurfaceHeight(surface, 2.25, 2.25)).not.toBeCloseTo(
      defined(terrainHeight(terrain, 2.25, 2.25)),
      3,
    );
    for (const lod of [0, 0.25, 1, 1.75, 2]) {
      const edge = terrainSurfaceVertex(
        { ...surface, lod, neighbors: [lod, lod, lod, lod] },
        n / 2 ** Math.floor(lod) - 1,
        0,
      );
      expect(edge[0]).toBe(n - 1);
    }
  });
  it('distinguishes the real diagonal from bilinear and the opposite diagonal', () => {
    const terrain = source(2, 2, [0, 0, 0, 1]);
    expect(terrainHeight(terrain, 0.5, 0.5)).toBe(0);
    expect(terrainHeight(terrain, 0.8, 0.4)).toBeCloseTo(0.2, 5);
    expect(terrainHeight(terrain, -0.01, 0.5)).toBeUndefined();
    expect(terrainHeight(terrain, 1, 1)).toBe(1);
  });
  it('converts an asymmetric rectangle into the actual column-major matrix', () => {
    const data = terrainHeightfield(source(3, 2, [1, 2, 4, 8, 16, 32]));
    expect([...data.heights]).toEqual([1, 8, 2, 16, 4, 32]);
    expect(data).toMatchObject({ rows: 1, columns: 2, scale: [2, 1, 1], origin: [1, 0, 0.5] });
  });
  it('rejects holes, incomplete subsections and invalid author sums', () => {
    expect(validateTerrain(source(2, 2, [0, NaN, 0, 1])).ok).toBe(false);
    expect(validateTerrain({ ...source(3, 2, [0, 0, 0, 0, 0, 0]), subsectionVertices: 4 }).ok).toBe(
      false,
    );
    const bad = source(2, 2, [0, 0, 0, 1]);
    bad.weights[0] = 0.5;
    expect(validateTerrain(bad).ok).toBe(false);
  });
  it('morphs XZ and height sample coordinates with 2^k-1 normalization', () => {
    expect(
      terrainSurfaceVertex(
        {
          vertices: 128,
          width: 254,
          lod: 0.5,
          neighbors: [0.5, 0.5, 0.5, 0.5],
          heightRange: [0, 1],
          heights: new Uint8Array(128 * 128 * 8),
        },
        111,
        20,
      )[0],
    ).toBe(221.87303161621094);
    const p = terrainVertexCoordinates(3, 5, 32, 0, 0.5);
    expect(p.currentX).toBeCloseTo(3 / 31);
    expect(p.nextX).toBeCloseTo(1 / 15);
    expect(p.x).toBeCloseTo((3 / 31 + 1 / 15) / 2);
    expect(p.x).not.toBe(p.currentX);
    for (let k = 0; k < 5; k++) {
      const edge = terrainVertexCoordinates(31, 31, 32, 0, k + 0.25);
      expect(edge.x).toBe(1);
      expect(edge.z).toBe(1);
    }
  });
  it('retains default channels for zero weight and applies alpha in list order', () => {
    const out = new Float32Array(3);
    const layers = [
      { material: 'a', blend: 'weight' },
      { material: 'b', blend: 'alpha' },
      { material: 'c', blend: 'alpha' },
    ] as const;
    expect(terrainLayerWeights(layers, [0, 0.5, 0.25], [], out).defaultWeight).toBe(0.375);
    expect([...out]).toEqual([0, 0.375, 0.25]);
  });
  it('normalizes the height-adjusted group and preserves zero-weight height epsilon', () => {
    const out = new Float32Array(2);
    terrainLayerWeights(
      [
        { material: 'a', blend: 'height', height: 'h', heightRange: [0, 1] },
        { material: 'b', blend: 'weight' },
      ],
      [0, 1],
      [0, 0],
      out,
    );
    expect(out[0]).toBeGreaterThan(0);
    expect((out[0] ?? 0) + (out[1] ?? 0)).toBeCloseTo(1, 5);
  });
  it('cooks identical shared-edge bytes and retains conservative source bounds', () => {
    const terrain = source(3, 2, [0, 1, 2, 3, 4, 5]);
    const cooked = cookTerrain(terrain).unwrap();
    const [a, b] = cooked.sections;
    expect(a?.height.data.slice(4, 8)).toEqual(b?.height.data.slice(0, 4));
    expect(a?.height.data.slice(12, 16)).toEqual(b?.height.data.slice(8, 12));
    expect(a).toMatchObject({ minHeight: 0, maxHeight: 4 });
    expect(cooked.heightError).toBeLessThan(0.0001);
    expect(cookTerrain(terrain).unwrap().sections[0]?.height.data).toEqual(a?.height.data);
  });
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}

it.each([
  2, 8,
])('preserves decimal-spacing author endpoints and each cooked subsection (n=%i)', (n) => {
  const columns = (n - 1) * 3 + 1;
  const root: TerrainSource = {
    columns,
    rows: n,
    spacing: 0.1,
    subsectionVertices: n,
    heights: Float32Array.from({ length: columns * n }, (_, i) =>
      i % columns === columns - 1 ? 1 : 0,
    ),
    weights: new Float32Array(columns * n).fill(1),
    layers: [{ material: 'material', blend: 'weight' }],
  };
  const width = (columns - 1) * root.spacing,
    depth = (n - 1) * root.spacing;
  expect(validateTerrain(root).ok).toBe(true);
  expect(terrainHeight(root, width, depth)).toBe(1);
  expect(terrainHeight(root, width, 0)).toBe(1);
  expect(terrainHeight(root, width + 1e-12, depth)).toBeUndefined();
  expect(terrainHeight(root, width, depth + 1e-12)).toBeUndefined();
  expect(terrainHeight(root, width - root.spacing * 0.3, depth * 0.37)).toBeCloseTo(0.7, 6);
  const cooked = cookTerrain(root).unwrap();
  for (const [index, section] of cooked.sections.entries()) {
    const surface = {
      vertices: n,
      width: (n - 1) * root.spacing,
      lod: 0,
      neighbors: [0, 0, 0, 0],
      heightRange: cooked.heightRange,
      heights: section.height.data,
    };
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) {
        const sample = z * columns + index * (n - 1) + x;
        expect(terrainSurfaceVertex(surface, x, z, [section.x, section.z])[1]).toBe(
          root.heights[sample],
        );
      }
  }
  const physical = terrainHeightfield(root);
  expect(physical.heights[(columns - 1) * n]).toBe(1);
  expect(physical.heights[columns * n - 1]).toBe(1);
});

it.each([
  'no-shadow',
  'surface-slot',
  'custom-program',
] as const)('rejects a noncanonical derived terrain material program: %s', (mutation) => {
  const guid = (key: string) => key;
  const layer: MaterialAsset = {
    kind: 'material',
    parameters: standardSurfaceParameters([]),
    passes: [{ name: 'forward', program: { module: 'forgeax_material::standard' } }],
  };
  const outputs = buildTerrainAssets(source(2, 2, [0, 0, 0, 1]), guid, {
    material: layer,
  }).unwrap();
  const root = outputs.terrain;
  if (root?.kind !== 'terrain') throw new Error('expected terrain');
  const closure = new Map<string, Asset>(Object.entries({ material: layer, ...outputs }));
  expect(terrainDerivedClosureValid(root, closure)).toBe(true);
  const material = outputs['section/0/material'];
  if (material?.kind !== 'material' || material.parent !== undefined)
    throw new Error('expected root material');
  const passes =
    mutation === 'no-shadow'
      ? defined(material.passes).filter((pass) => pass.name !== 'shadow-caster')
      : defined(material.passes).map((pass, i) =>
          i === 0
            ? {
                ...pass,
                program: {
                  ...pass.program,
                  ...(mutation === 'custom-program'
                    ? { module: 'custom' }
                    : { moduleSlots: { surface: 'custom_surface' } }),
                },
              }
            : pass,
        );
  const [first, ...rest] = passes;
  if (first === undefined) throw new Error('expected a raster pass');
  closure.set('section/0/material', { ...material, passes: [first, ...rest] });
  expect(terrainDerivedClosureValid(root, closure)).toBe(false);
});
