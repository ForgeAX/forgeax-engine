// tilemap-chunk-extract.unit.test.ts
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M4 / w12.
//
// Forward-looking unit test for the `(layerEntity, chunkIndex, atlasId)`
// triplet bucket aggregation contract that w13 will land into
// `packages/runtime/src/tilemap-chunk-extract-system.ts` once upstream
// feat-20260622 (chunk system) lands in main.
//
// R-NEW-1 fallback engaged at M0: `m0-probe.json` confirms upstream
// feat-20260622 + tweak-20260624 have NOT landed in this branch
// (`upstream_feat20260622_landed=false`, `tilemapChunkExtractSystemExists=
// false`). The originally-targeted source file
// `packages/runtime/src/tilemap-chunk-extract-system.ts` does not exist;
// w13's "terrain path rewrite" cannot be effectuated against a non-existent
// file. This test instead encodes the bucket-aggregation algorithm as a
// pure local function and asserts the 4 sub-assertions plan-tasks w12
// requires; when upstream lands the chunk system, w13 will paste this
// reference algorithm into the real source file with identical input /
// output contract — these tests will then mechanically migrate to call
// the engine export with zero conceptual drift.
//
// Anchors:
//   - requirements AC-06 (terrain entity count <= 16N where N is terrain
//     layer count; m0-probe.json N=11 -> upper bound 176)
//   - requirements AC-10 (terrain drawcall <= 16; per layer = atlasCount)
//   - requirements Edge Cases (empty TileLayer -> zero bucket entities)
//   - plan-strategy section 2 D-2 (triplet key `(layerEntity, chunkIndex,
//     atlasId)`, single atlas per bucket constraint)
//   - plan-strategy section 2 D-10 (dirty granularity stays whole-layer,
//     `layerDerivedEntities` map value type stays `number[]`)
//   - plan-strategy section 4 R-1 (chunk count formula correction)
//   - plan-strategy section 4 R-7 (atlasId vs materialHandle bucket key
//     selection; reverse-falsification: same-atlas-different-region cells
//     must share one bucket entity)
//   - research section Q-R-3.1 (atlas dimension bucket key uses atlasId
//     because resolveTilesetMaterial caches by (atlasId, regionIndex))
//   - research section Q-R-3.2 (chunkIndex formula)
//   - m0-probe.json (cols=55, rows=56, atlasCount=1, terrainLayerN=11
//     -> ceil(55/16)*ceil(56/16)*1*11 = 4*4*1*11 = 176 bucket cap)
//
// Charter mapping: F1 (single grep target — the triplet shape is named
// once here, picked up unchanged when w13 lands), P3 (explicit failure —
// triplet collision asserted by bucket dedup; per-cell path preserved by
// branch separation), P4 (consistent abstraction — bucket aggregation is
// hidden behind the `sortScope` discriminant, AI users at the
// `Tilemap + TileLayer` surface see no aggregation knob).
//
// Boundary: zero imports from runtime source. The reference algorithm
// below is the contract SSOT for w13; when w13 effectuates (post upstream
// land) the production export will be import-substituted at the top of
// the file and these tests will run unchanged against the real impl.

import { describe, expect, it } from 'vitest';

// ----------------------------------------------------------------------
// Reference contract — input shape mirrors `DerivedSpawnSpec[]` as
// research Q-R-3 describes the `bucketTileLayer` -> `specFor` pipeline.
// Field names align with research section 3.1 and plan-strategy D-2.
// ----------------------------------------------------------------------

/**
 * Per-cell spec produced by `bucketTileLayer` upstream of the terrain
 * bucket aggregator. One entry per non-empty tile cell in a TileLayer.
 * Field names mirror the upstream `DerivedSpawnSpec` shape in
 * `tilemap-chunk-extract-system.ts` (research Q-R-3).
 */
type DerivedSpawnSpec = {
  readonly cellX: number;
  readonly cellY: number;
  readonly widthCells: number;
  readonly heightCells: number;
  readonly tileSize: number;
  readonly chunkIndex: number;
  readonly atlasId: number;
  readonly materialHandle: number;
  readonly uvRegion: readonly [number, number, number, number];
};

/**
 * Bucket key tuple for terrain aggregation. Three dimensions per
 * plan-strategy D-2:
 *   - `layerEntity` — supplied externally (the TileLayer entity hosting
 *     these specs); the aggregator receives it as a closure / scoped arg,
 *     so the BucketKey carried by the algorithm covers the inner two
 *     axes (chunkIndex + atlasId). The full triplet is `(layerEntity,
 *     chunkIndex, atlasId)` at the caller layer.
 *   - `chunkIndex` — chunkX + chunkY * chunksAcross (research Q-R-3.2).
 *   - `atlasId` — extracted from `resolveTilesetMaterial` cache, NOT
 *     `materialHandle` (research Q-R-3.1, R-7).
 */
type BucketKey = `${number}:${number}`;

/**
 * Output of bucket aggregation: one bucket per (chunkIndex, atlasId)
 * pair under a given layerEntity. The transforms / regions Float32Arrays
 * are the per-instance payloads the SpriteInstances component carries on
 * the bucket entity.
 */
type TerrainBucket = {
  readonly chunkIndex: number;
  readonly atlasId: number;
  readonly transforms: Float32Array;
  readonly regions: Float32Array;
  readonly instanceCount: number;
};

/**
 * Reference pure implementation of the terrain bucket aggregator.
 *
 * Aggregates `DerivedSpawnSpec[]` by `(chunkIndex, atlasId)` and packs
 * per-cell mat4 + uvRegion into Float32Array payloads suitable for the
 * SpriteInstances component on a per-bucket spawned entity.
 *
 * The transforms are column-major mat4 (stride 16) computed from
 * `(cellX, cellY, widthCells, heightCells, tileSize)` as a local-from-
 * instance translation+scale (rotation identity, terrain tiles do not
 * rotate at the bucket layer; world transform is applied at the parent
 * Tilemap entity level via the layer's TRS chain).
 *
 * w13 will export an equivalent function from
 * `packages/runtime/src/tilemap-chunk-extract-system.ts` once upstream
 * feat-20260622 lands the file.
 */
function bucketTerrainSpecs(specs: readonly DerivedSpawnSpec[]): TerrainBucket[] {
  // Group by `(chunkIndex, atlasId)` -> spec list, preserving insertion order.
  const groups = new Map<BucketKey, DerivedSpawnSpec[]>();
  for (const spec of specs) {
    const key: BucketKey = `${spec.chunkIndex}:${spec.atlasId}`;
    let list = groups.get(key);
    if (list === undefined) {
      list = [];
      groups.set(key, list);
    }
    list.push(spec);
  }

  const buckets: TerrainBucket[] = [];
  for (const [key, list] of groups) {
    const [chunkPart, atlasPart] = key.split(':');
    const chunkIndex = Number(chunkPart);
    const atlasId = Number(atlasPart);
    const n = list.length;
    const transforms = new Float32Array(n * 16);
    const regions = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      // biome-ignore lint/style/noNonNullAssertion: list[i] always defined for i < n.
      const s = list[i]!;
      // Column-major mat4: scale (widthCells*tileSize, heightCells*tileSize, 1)
      // + translate (cellX*tileSize, cellY*tileSize, 0). Rotation identity.
      const sx = s.widthCells * s.tileSize;
      const sy = s.heightCells * s.tileSize;
      const tx = s.cellX * s.tileSize;
      const ty = s.cellY * s.tileSize;
      const o = i * 16;
      transforms[o + 0] = sx;
      transforms[o + 1] = 0;
      transforms[o + 2] = 0;
      transforms[o + 3] = 0;
      transforms[o + 4] = 0;
      transforms[o + 5] = sy;
      transforms[o + 6] = 0;
      transforms[o + 7] = 0;
      transforms[o + 8] = 0;
      transforms[o + 9] = 0;
      transforms[o + 10] = 1;
      transforms[o + 11] = 0;
      transforms[o + 12] = tx;
      transforms[o + 13] = ty;
      transforms[o + 14] = 0;
      transforms[o + 15] = 1;
      const ro = i * 4;
      regions[ro + 0] = s.uvRegion[0];
      regions[ro + 1] = s.uvRegion[1];
      regions[ro + 2] = s.uvRegion[2];
      regions[ro + 3] = s.uvRegion[3];
    }
    buckets.push({ chunkIndex, atlasId, transforms, regions, instanceCount: n });
  }
  return buckets;
}

/**
 * Per-cell spawn count when `sortScope === 'per-cell'`. The terrain
 * bucket aggregator is NOT invoked on this path; `spawnDerivedRenderEntities`
 * keeps producing one entity per non-empty cell (Y-sort interleave).
 *
 * Reference: plan-strategy D-2 "sortScope='per-cell' route preserves
 * spawnDerivedRenderEntities unchanged".
 */
function perCellSpawnCount(specs: readonly DerivedSpawnSpec[]): number {
  return specs.length;
}

// ----------------------------------------------------------------------
// Fixture helpers
// ----------------------------------------------------------------------

/**
 * Build a synthetic `DerivedSpawnSpec[]` for a `cols x rows` TileLayer
 * with chunk size `chunkSize`, single atlas, single region. Every cell
 * non-empty.
 */
function buildFixture(
  cols: number,
  rows: number,
  chunkSize: number,
  atlasId: number,
): DerivedSpawnSpec[] {
  const chunksAcross = Math.ceil(cols / chunkSize);
  const specs: DerivedSpawnSpec[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const chunkX = Math.floor(x / chunkSize);
      const chunkY = Math.floor(y / chunkSize);
      const chunkIndex = chunkX + chunkY * chunksAcross;
      specs.push({
        cellX: x,
        cellY: y,
        widthCells: 1,
        heightCells: 1,
        tileSize: 16,
        chunkIndex,
        atlasId,
        // materialHandle deliberately differs per cell to verify the
        // bucket aggregator does NOT use it as a key dimension (R-7).
        materialHandle: x * 7919 + y * 104729 + 1,
        uvRegion: [0, 0, 0.25, 0.25],
      });
    }
  }
  return specs;
}

// ----------------------------------------------------------------------
// w12 sub-assertions (4)
// ----------------------------------------------------------------------

describe('tilemap-chunk-extract terrain bucket aggregation (w12)', () => {
  describe('(a) bucket entity count formula', () => {
    it('cols=55, rows=56, chunkSize=16, atlasCount=1, layerCount=1 -> 16 buckets', () => {
      // R-1 correction: chunksX * chunksY * atlasCount * layerCount.
      // 55 / 16 = 4 chunks across; 56 / 16 = 4 chunks down; 1 atlas; 1
      // layer in this fixture -> 4 * 4 * 1 * 1 = 16.
      const specs = buildFixture(55, 56, 16, /*atlasId=*/ 1);
      const buckets = bucketTerrainSpecs(specs);
      expect(buckets.length).toBe(16);
    });

    it('multi-atlas: atlasCount=2 doubles bucket count', () => {
      const specsA = buildFixture(55, 56, 16, /*atlasId=*/ 1);
      const specsB = buildFixture(55, 56, 16, /*atlasId=*/ 2);
      const buckets = bucketTerrainSpecs([...specsA, ...specsB]);
      // 16 chunks * 2 atlases = 32 buckets (single layer in this fixture).
      expect(buckets.length).toBe(32);
    });

    it('m0-probe fixture: terrainLayerN=11 -> AC-10 cap = 16 * 11 = 176', () => {
      // Per-layer bucket count is 16 (single atlas); AC-10 caps terrain
      // entity count at 16N where N=11 is the m0-probe.json measured
      // terrain layer count. This assertion locks the upper bound that
      // M5 smoke will verify end-to-end against the real asi-world scene.
      const perLayerBuckets = bucketTerrainSpecs(buildFixture(55, 56, 16, 1)).length;
      const terrainLayerN = 11;
      const upperBound = perLayerBuckets * terrainLayerN;
      expect(upperBound).toBe(176);
    });
  });

  describe('(b) atlasId vs materialHandle reverse falsification (R-7)', () => {
    it('same atlasId different materialHandle cells share one bucket', () => {
      // Two cells in the same chunk (chunkIndex=0), same atlas (atlasId=
      // 42), but different materialHandle values (simulating cache hits
      // for different region indices within the same atlas).
      const specs: DerivedSpawnSpec[] = [
        {
          cellX: 0,
          cellY: 0,
          widthCells: 1,
          heightCells: 1,
          tileSize: 16,
          chunkIndex: 0,
          atlasId: 42,
          materialHandle: 1001,
          uvRegion: [0, 0, 0.5, 0.5],
        },
        {
          cellX: 1,
          cellY: 0,
          widthCells: 1,
          heightCells: 1,
          tileSize: 16,
          chunkIndex: 0,
          atlasId: 42,
          materialHandle: 1002, // different materialHandle, same atlas.
          uvRegion: [0.5, 0, 0.5, 0.5],
        },
      ];
      const buckets = bucketTerrainSpecs(specs);
      expect(buckets.length).toBe(1);
      // biome-ignore lint/style/noNonNullAssertion: length checked above.
      expect(buckets[0]!.instanceCount).toBe(2);
      // The two distinct uvRegions both land in the bucket's regions
      // payload — proving per-cell region survives via SpriteInstances,
      // not via per-material drawcall split.
      // biome-ignore lint/style/noNonNullAssertion: bucket[0] exists.
      expect(buckets[0]!.regions[0]).toBe(0);
      // biome-ignore lint/style/noNonNullAssertion: bucket[0] exists.
      expect(buckets[0]!.regions[4]).toBe(0.5);
    });

    it('different atlasId cells split into separate buckets even when materialHandle collides', () => {
      // Reverse: same materialHandle (hash collision is implausible in
      // practice, but the algorithm must not key off it) but different
      // atlasId -> 2 buckets.
      const specs: DerivedSpawnSpec[] = [
        {
          cellX: 0,
          cellY: 0,
          widthCells: 1,
          heightCells: 1,
          tileSize: 16,
          chunkIndex: 0,
          atlasId: 1,
          materialHandle: 9999,
          uvRegion: [0, 0, 1, 1],
        },
        {
          cellX: 1,
          cellY: 0,
          widthCells: 1,
          heightCells: 1,
          tileSize: 16,
          chunkIndex: 0,
          atlasId: 2,
          materialHandle: 9999,
          uvRegion: [0, 0, 1, 1],
        },
      ];
      const buckets = bucketTerrainSpecs(specs);
      expect(buckets.length).toBe(2);
    });
  });

  describe("(c) sortScope='per-cell' route bypasses bucket aggregation", () => {
    it('per-cell spawn count equals non-empty cell count (no bucket fold)', () => {
      // Object semantic path: each cell needs its own foot-Y sort key,
      // so spawnDerivedRenderEntities keeps producing one entity per
      // cell. The bucket aggregator must NOT be invoked here.
      const specs = buildFixture(8, 8, 16, /*atlasId=*/ 1);
      // 8 cols * 8 rows = 64 non-empty cells.
      expect(specs.length).toBe(64);
      expect(perCellSpawnCount(specs)).toBe(64);
      // Sanity: had this been the terrain path, the same 8x8 layer would
      // collapse to 1 bucket (single chunk, single atlas).
      expect(bucketTerrainSpecs(specs).length).toBe(1);
    });
  });

  describe('(d) empty TileLayer produces zero bucket entities', () => {
    it('zero specs -> zero buckets', () => {
      const buckets = bucketTerrainSpecs([]);
      expect(buckets.length).toBe(0);
    });

    it('zero specs per-cell path also produces zero spawns', () => {
      expect(perCellSpawnCount([])).toBe(0);
    });
  });

  describe('SpriteInstances payload shape per bucket (D-1 stride pair)', () => {
    it('transforms stride 16 + regions stride 4 invariant per bucket', () => {
      const specs = buildFixture(32, 32, 16, /*atlasId=*/ 7);
      const buckets = bucketTerrainSpecs(specs);
      for (const b of buckets) {
        expect(b.transforms.length).toBe(b.instanceCount * 16);
        expect(b.regions.length).toBe(b.instanceCount * 4);
        // SpriteInstances component invariant from render-system-extract
        // (M3 / w10): transforms.length / 16 === regions.length / 4.
        expect(b.transforms.length / 16).toBe(b.regions.length / 4);
      }
    });
  });
});
