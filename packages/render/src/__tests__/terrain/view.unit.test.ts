import { terrainHeightBounds, terrainSurfaceVertex } from '@forgeax/engine-terrain';
import { cookTerrain } from '@forgeax/engine-terrain/cook';
import type { TerrainAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { CameraSnapshot } from '../../render-contract.js';
import type { ExtractedFrame, RenderableSnapshot } from '../../render-system-extract.js';
import { projectTerrainView } from '../../terrain/view.js';

it('encloses quantized section vertices even when another section owns the global height maximum', () => {
  for (const n of [2, 8]) {
    const columns = (n - 1) * 2 + 1;
    const heights = new Float32Array(columns * n).fill(0.1);
    heights[columns - 1] = 10000;
    heights[columns * n - 1] = 0;
    const cooked = cookTerrain({
      columns,
      rows: n,
      spacing: 1,
      subsectionVertices: n,
      heights,
      weights: new Float32Array(columns * n).fill(1),
      layers: [{ material: 'material', blend: 'weight' }],
    }).unwrap();
    const section = defined(cooked.sections[0]);
    const bounds = new Float32Array(
      terrainHeightBounds(section.minHeight, section.maxHeight, cooked.heightRange),
    );
    const asset = {
      ...cooked.source,
      kind: 'terrain',
      materialEncoding: { kind: 'weights' },
      heightRange: cooked.heightRange,
      sections: cooked.sections,
    } as unknown as TerrainAsset;
    const source = {
      worldId: 0,
      entityKey: 42,
      transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      materials: cooked.sections.map(() => ({ materialHandle: 1 })),
      terrain: {
        asset,
        grids: Array.from({ length: Math.log2(n) }, (_, i) => i + 10),
        heightTextures: [4, 5],
        weightTextures: [6, 7],
        passes: [[], []],
        forcedLod: 0,
        lod0Diameter: 1,
        layer: 0,
      },
    } as unknown as RenderableSnapshot;
    const projected = projectTerrainView(
      {
        renderables: [source],
        dispatch: [],
        cameras: [{}],
      } as unknown as ExtractedFrame,
      new Map(),
    );
    const aabb = defined(defined(projected.renderables[0]).localAabb);
    expect(aabb[1]).toBe(bounds[0]);
    expect(aabb[4]).toBe(bounds[1]);
    const maxLod = Math.log2(n) - 1;
    for (const lod of [0, Math.min(0.5, maxLod), maxLod]) {
      const surface = {
        vertices: n,
        width: n - 1,
        lod,
        neighbors: [maxLod, lod, maxLod, lod],
        heightRange: cooked.heightRange,
        heights: section.height.data,
      };
      for (let z = 0; z < n / 2 ** Math.floor(lod); z++)
        for (let x = 0; x < n / 2 ** Math.floor(lod); x++) {
          const h = terrainSurfaceVertex(surface, x, z)[1];
          // The old author-only bounds are deliberately falsified by this source.
          expect(h).toBeGreaterThan(section.maxHeight);
          expect(h).toBeGreaterThanOrEqual(defined(bounds[0]));
          expect(h).toBeLessThanOrEqual(defined(bounds[1]));
        }
    }
  }
});

it('derives each view and boundary LOD from one terrain entity without adopting unsubmitted candidates', () => {
  const asset = {
    kind: 'terrain',
    materialEncoding: { kind: 'weights' },
    columns: 15,
    rows: 8,
    subsectionVertices: 8,
    spacing: 1,
    heightRange: [0, 1],
    sections: [
      { x: 0, z: 0, minHeight: 0, maxHeight: 1 },
      { x: 7, z: 0, minHeight: 0, maxHeight: 1 },
    ],
  } as unknown as TerrainAsset;
  const source = {
    worldId: 0,
    entityKey: 42,
    transform: { world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    materials: [{ materialHandle: 1 }, { materialHandle: 2 }],
    terrain: {
      asset,
      handle: 3,
      grids: [10, 11, 12],
      heightTextures: [4, 5],
      weightTextures: [6, 7],
      passes: [[], []],
      lod0Diameter: 1,
      forcedLod: -1,
      layer: 0,
    },
  } as unknown as RenderableSnapshot;
  const camera = (z: number) =>
    ({
      position: new Float32Array([3.5, 2, z]),
      near: 0.1,
      fov: Math.PI / 3,
      projection: 'perspective',
    }) as CameraSnapshot;
  const frame = (z: number) =>
    ({ renderables: [source], dispatch: [], cameras: [camera(z)] }) as unknown as ExtractedFrame;
  const accepted = new Map<string, RenderableSnapshot>();
  const near = projectTerrainView(frame(12), accepted),
    far = projectTerrainView(frame(100), accepted);
  expect(near.renderables.map((draw) => draw.entityKey)).toEqual([42, 42]);
  expect(defined(defined(far.renderables[0]).terrainSection).lod).toBeGreaterThan(
    defined(defined(near.renderables[0]).terrainSection).lod,
  );
  expect(defined(defined(near.renderables[0]).terrainSection).neighbors[1]).toBe(
    defined(defined(near.renderables[1]).terrainSection).lod,
  );
  expect(defined(defined(near.renderables[1]).terrainSection).neighbors[0]).toBe(
    defined(defined(near.renderables[0]).terrainSection).lod,
  );
  expect(defined(near.renderables[0]).temporal?.reactive).toBe(true);
  expect(accepted.size).toBe(0);
});

function defined<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected defined test value');
  return value;
}
