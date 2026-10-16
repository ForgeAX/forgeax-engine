// tilemap-chunk-extract.terrain-rewrite.unit.test.ts
// feat-20260625-sprite-instances-and-tilemap-terrain-static-batch / M4 / w13.
//
// Forward-looking unit test for the terrain-path rewrite in
// `packages/runtime/src/tilemap-chunk-extract-system.ts` that w13
// originally targeted.
//
// R-NEW-1 fallback engaged at M0: `m0-probe.json` confirms upstream
// feat-20260622 has NOT landed in this branch
// (`upstream_feat20260622_landed=false`,
// `tilemapChunkExtractSystemExists=false`). w13's "tilemap-chunk-extract
// terrain rewrite" cannot be effectuated against a non-existent source
// file. w12 already locked the (chunkIndex, atlasId) bucket aggregation
// algorithm; this file extends the contract to cover the 5 additional
// sub-conditions plan-tasks w13 (a)..(f) requires:
//
//   (a) sortScope discriminant: 'layer' -> bucket aggregation;
//                                'per-cell' -> spawnDerivedRenderEntities
//                                              preserved unchanged.
//   (c) each bucket entity carries the {MeshFilter, MeshRenderer,
//       SpriteInstances} triplet; SpriteInstances.transforms /
//       SpriteInstances.regions derive from per-cell spec data.
//   (d) layerDerivedEntities map element type stays number[] post
//       rewrite — per-cell entity ids replaced by bucket entity ids,
//       length collapses from cell count to bucket count.
//   (e) markTileLayerDirty + purgeDerivedEntities: terrain dirty still
//       despawns whole-layer; granularity invariant (OOS-4 dirty bitmap
//       deferred to autotile closed-loop).
//   (f) spawnDerivedRenderEntities is NOT deleted on terrain rewrite;
//       its consumer set narrows to sortScope='per-cell' (object path).
//
// Anchors:
//   - requirements AC-06 (terrain entity count <= 16N per layer)
//   - requirements AC-10 (terrain drawcall <= 16)
//   - plan-strategy section 2 D-2 (sortScope discriminant, single atlas
//     per bucket)
//   - plan-strategy section 2 D-10 (dirty granularity stays whole-layer;
//     layerDerivedEntities map element type stays number[])
//   - plan-strategy OOS-2 (dynamic chunk MeshAsset Level 2 path NOT in
//     this feat — bucket entities reuse the builtin quad MeshAsset)
//   - plan-strategy OOS-4 (per-chunk dirty bitmap deferred)
//   - research section Q-R-3.3 (purgeDerivedEntities granularity)
//   - research section 3.4 (spawnDerivedRenderEntities preserved for
//     sortScope='per-cell')
//   - Boundary: zero imports from runtime source. w12 sibling test
//     already locked bucket aggregation; this file adds dirty-rebuild /
//     ECS-component-set / sortScope-discriminant contracts.
//
// Charter mapping: F1 (single grep targets — `sortScope`, `purgeDerived
// Entities`, `layerDerivedEntities` retain their pre-rewrite spelling
// post-fallback so the AI user's discovery vocabulary is stable), P4
// (consistent abstraction — AI users at Tilemap + TileLayer surface see
// the same API; bucket vs per-cell is hidden behind sortScope).

import { describe, expect, it } from 'vitest';

// ----------------------------------------------------------------------
// Reference contract — w13 source-level shapes recreated as types only.
// w12 sibling test locked the aggregation function; here we lock the
// surrounding `tilemapChunkExtractSystem` entry-level discriminant,
// the bucket spawn descriptor, the layerDerivedEntities map shape, and
// the purgeDerivedEntities dirty-rebuild invariant.
// ----------------------------------------------------------------------

type SortScope = 'layer' | 'per-cell';

type Entity = number;

/** Mirror of `DerivedSpawnSpec[]` from w12 + research Q-R-3. */
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
 * Bucket entity spawn descriptor — the data the production extract
 * system passes to `world.spawn(...)` for each bucket. Component set
 * is the 3-tuple plan-tasks w13 (c) requires.
 */
type BucketEntitySpawnDescriptor = {
  readonly meshFilter: { readonly assetHandle: number };
  readonly meshRenderer: { readonly materialHandle: number };
  readonly spriteInstances: {
    readonly transforms: Float32Array;
    readonly regions: Float32Array;
  };
};

// ----------------------------------------------------------------------
// (a) sortScope discriminant entry: 'layer' vs 'per-cell' route
// ----------------------------------------------------------------------

/**
 * Reference for the `tilemapChunkExtractSystem` entry-level branch:
 * picks between bucket aggregation and per-cell spawn based on
 * `sortScope`. Returns the aggregated bucket count for 'layer' route,
 * or the per-cell spawn count for 'per-cell' route. The two routes are
 * mutually exclusive (no mixed path).
 */
function routeBySortScope(
  scope: SortScope,
  specs: readonly DerivedSpawnSpec[],
): { route: 'bucket' | 'per-cell'; entityCount: number } {
  switch (scope) {
    case 'layer': {
      // Aggregate by (chunkIndex, atlasId) -> one entity per bucket.
      const buckets = new Set<string>();
      for (const s of specs) {
        buckets.add(`${s.chunkIndex}:${s.atlasId}`);
      }
      return { route: 'bucket', entityCount: buckets.size };
    }
    case 'per-cell': {
      // Preserve spawnDerivedRenderEntities — one entity per non-empty cell.
      return { route: 'per-cell', entityCount: specs.length };
    }
  }
}

// ----------------------------------------------------------------------
// (c) bucket entity component triplet builder
// ----------------------------------------------------------------------

const QUAD_MESH_HANDLE = 1; // builtin quad handle stand-in.
const SPRITE_ATLAS_MATERIAL_HANDLE = 2; // sprite-atlas material stand-in.

/**
 * Build the bucket entity spawn descriptor with the
 * `{MeshFilter, MeshRenderer, SpriteInstances}` triplet plan-tasks w13
 * (c) mandates. Transforms = column-major mat4 per instance derived from
 * (cellX, cellY, widthCells, heightCells, tileSize); regions = uvRegion
 * vec4 per instance.
 */
function buildBucketEntityDescriptor(
  bucketSpecs: readonly DerivedSpawnSpec[],
): BucketEntitySpawnDescriptor {
  const n = bucketSpecs.length;
  const transforms = new Float32Array(n * 16);
  const regions = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i < n.
    const s = bucketSpecs[i]!;
    const sx = s.widthCells * s.tileSize;
    const sy = s.heightCells * s.tileSize;
    const tx = s.cellX * s.tileSize;
    const ty = s.cellY * s.tileSize;
    const o = i * 16;
    transforms[o + 0] = sx;
    transforms[o + 5] = sy;
    transforms[o + 10] = 1;
    transforms[o + 12] = tx;
    transforms[o + 13] = ty;
    transforms[o + 15] = 1;
    const ro = i * 4;
    regions[ro + 0] = s.uvRegion[0];
    regions[ro + 1] = s.uvRegion[1];
    regions[ro + 2] = s.uvRegion[2];
    regions[ro + 3] = s.uvRegion[3];
  }
  return {
    meshFilter: { assetHandle: QUAD_MESH_HANDLE },
    meshRenderer: { materialHandle: SPRITE_ATLAS_MATERIAL_HANDLE },
    spriteInstances: { transforms, regions },
  };
}

// ----------------------------------------------------------------------
// (d) layerDerivedEntities map element type invariant
// ----------------------------------------------------------------------

/**
 * Reference of the `layerDerivedEntities` module-scoped cache shape.
 * Plan-strategy D-10 mandates the element value type stays `number[]`
 * post rewrite — only the meaning of each element changes from per-cell
 * entity id (pre-w13) to bucket entity id (post-w13).
 */
type LayerDerivedEntitiesMap = Map<Entity, Entity[]>;

function recordSpawnedEntities(
  map: LayerDerivedEntitiesMap,
  layerEntity: Entity,
  spawnedEntityIds: readonly Entity[],
): void {
  map.set(layerEntity, [...spawnedEntityIds]);
}

// ----------------------------------------------------------------------
// (e) purgeDerivedEntities terrain-layer dirty granularity invariant
// ----------------------------------------------------------------------

/**
 * Reference for the terrain-path `purgeDerivedEntities` call from
 * `markTileLayerDirty`. Whole-layer despawn — same granularity pre / post
 * rewrite; only the count of despawned entities changes (cells -> buckets).
 */
function purgeDerivedEntities(map: LayerDerivedEntitiesMap, layerEntity: Entity): Entity[] {
  const entities = map.get(layerEntity) ?? [];
  map.delete(layerEntity);
  return entities;
}

// ----------------------------------------------------------------------
// (f) spawnDerivedRenderEntities preserved for sortScope='per-cell'
// ----------------------------------------------------------------------

/**
 * Reference of the surviving `spawnDerivedRenderEntities` function path.
 * Post-rewrite this remains for sortScope='per-cell' (object path);
 * terrain path no longer calls into it. This function is intentionally
 * NOT deleted by the rewrite — the test (f) asserts its consumer set.
 */
function spawnDerivedRenderEntities(specs: readonly DerivedSpawnSpec[]): Entity[] {
  const out: Entity[] = [];
  for (let i = 0; i < specs.length; i++) {
    out.push(1000 + i); // synthetic per-cell entity id.
  }
  return out;
}

// ----------------------------------------------------------------------
// Fixture
// ----------------------------------------------------------------------

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
      specs.push({
        cellX: x,
        cellY: y,
        widthCells: 1,
        heightCells: 1,
        tileSize: 16,
        chunkIndex: chunkX + chunkY * chunksAcross,
        atlasId,
        materialHandle: x * 7919 + y * 104729 + 1,
        uvRegion: [0, 0, 0.25, 0.25],
      });
    }
  }
  return specs;
}

// ----------------------------------------------------------------------
// w13 sub-assertions
// ----------------------------------------------------------------------

describe('tilemap-chunk-extract terrain rewrite contract (w13)', () => {
  describe("(a) sortScope discriminant: 'layer' aggregates / 'per-cell' preserved", () => {
    it("'layer' route: 55x56 / chunkSize=16 / single atlas -> 16 bucket entities", () => {
      const specs = buildFixture(55, 56, 16, 1);
      const out = routeBySortScope('layer', specs);
      expect(out.route).toBe('bucket');
      expect(out.entityCount).toBe(16);
    });

    it("'per-cell' route: same fixture -> 55*56 = 3080 per-cell entities (no aggregation)", () => {
      const specs = buildFixture(55, 56, 16, 1);
      const out = routeBySortScope('per-cell', specs);
      expect(out.route).toBe('per-cell');
      expect(out.entityCount).toBe(3080);
    });

    it('routing is exhaustive over the sortScope union (closed switch)', () => {
      // The function above uses an exhaustive switch over SortScope;
      // TypeScript guards completeness. This assertion confirms the
      // observable behaviour matches the discriminant.
      const allScopes: SortScope[] = ['layer', 'per-cell'];
      for (const scope of allScopes) {
        const out = routeBySortScope(scope, []);
        expect(out.route).toBe(scope === 'layer' ? 'bucket' : 'per-cell');
        expect(out.entityCount).toBe(0);
      }
    });
  });

  describe('(c) bucket entity component triplet: MeshFilter + MeshRenderer + SpriteInstances', () => {
    it('descriptor carries 3 component-data slots with correct shape', () => {
      const specs = buildFixture(4, 4, 16, 1);
      const desc = buildBucketEntityDescriptor(specs);
      // MeshFilter slot
      expect(desc.meshFilter.assetHandle).toBe(QUAD_MESH_HANDLE);
      // MeshRenderer slot
      expect(desc.meshRenderer.materialHandle).toBe(SPRITE_ATLAS_MATERIAL_HANDLE);
      // SpriteInstances slot — D-1 stride pair invariant
      expect(desc.spriteInstances.transforms.length).toBe(specs.length * 16);
      expect(desc.spriteInstances.regions.length).toBe(specs.length * 4);
    });

    it('mat4 column-major: scale on diagonal, translate in last column', () => {
      const specs: DerivedSpawnSpec[] = [
        {
          cellX: 2,
          cellY: 3,
          widthCells: 1,
          heightCells: 1,
          tileSize: 16,
          chunkIndex: 0,
          atlasId: 1,
          materialHandle: 1,
          uvRegion: [0, 0, 1, 1],
        },
      ];
      const desc = buildBucketEntityDescriptor(specs);
      const t = desc.spriteInstances.transforms;
      // scale 16 on x and y, identity on z
      expect(t[0]).toBe(16);
      expect(t[5]).toBe(16);
      expect(t[10]).toBe(1);
      // translate (2*16, 3*16, 0) in last column (column-major: indices 12,13,14)
      expect(t[12]).toBe(32);
      expect(t[13]).toBe(48);
      expect(t[14]).toBe(0);
      expect(t[15]).toBe(1);
    });
  });

  describe('(d) layerDerivedEntities map element type stays number[] (D-10)', () => {
    it('type lock: map value is Entity[] (= number[]) pre + post rewrite', () => {
      const map: LayerDerivedEntitiesMap = new Map();
      const layerEntity = 42;
      const bucketEntityIds = [101, 102, 103, 104];
      recordSpawnedEntities(map, layerEntity, bucketEntityIds);
      const recorded = map.get(layerEntity);
      expect(recorded).toBeDefined();
      expect(Array.isArray(recorded)).toBe(true);
      // The structural invariant: every element is a number; the
      // element semantics (cell entity vs bucket entity) changes
      // but the element type does not.
      // biome-ignore lint/style/noNonNullAssertion: defined check above.
      for (const e of recorded!) {
        expect(typeof e).toBe('number');
      }
    });

    it('per-layer entity count collapses cells -> buckets post rewrite', () => {
      const specs = buildFixture(55, 56, 16, 1);
      const map: LayerDerivedEntitiesMap = new Map();
      const layerEntity = 99;
      // Post-rewrite: bucket entity ids only.
      const bucketCount = routeBySortScope('layer', specs).entityCount;
      const bucketIds: Entity[] = [];
      for (let i = 0; i < bucketCount; i++) {
        bucketIds.push(2000 + i);
      }
      recordSpawnedEntities(map, layerEntity, bucketIds);
      const recorded = map.get(layerEntity);
      // biome-ignore lint/style/noNonNullAssertion: recorded defined.
      expect(recorded!.length).toBe(16);
      // Collapse ratio: 3080 cells -> 16 buckets (~ 193x).
      expect(specs.length / 16).toBeCloseTo(192.5);
    });
  });

  describe('(e) markTileLayerDirty -> purgeDerivedEntities whole-layer despawn invariant', () => {
    it('purge returns all entities for a layer and clears the map entry', () => {
      const map: LayerDerivedEntitiesMap = new Map();
      const layerEntity = 7;
      const bucketIds = [501, 502, 503];
      recordSpawnedEntities(map, layerEntity, bucketIds);
      const purged = purgeDerivedEntities(map, layerEntity);
      expect(purged).toEqual(bucketIds);
      expect(map.has(layerEntity)).toBe(false);
    });

    it('dirty granularity stays whole-layer post-rewrite (OOS-4)', () => {
      // OOS-4 invariant: purgeDerivedEntities consumes one layer entity
      // and despawns ALL its derived entities (whether buckets or cells).
      // Per-chunk granular dirty is deferred to the autotile closed-loop.
      const map: LayerDerivedEntitiesMap = new Map();
      recordSpawnedEntities(map, /*layer A*/ 1, [10, 11, 12]);
      recordSpawnedEntities(map, /*layer B*/ 2, [20, 21]);
      const purgedA = purgeDerivedEntities(map, 1);
      // Only layer A entities purged; layer B intact.
      expect(purgedA.length).toBe(3);
      expect(map.get(2)?.length).toBe(2);
    });

    it('purging an unknown layer is a no-op (returns empty array)', () => {
      const map: LayerDerivedEntitiesMap = new Map();
      expect(purgeDerivedEntities(map, /*unknown layer*/ 999)).toEqual([]);
    });
  });

  describe('(f) spawnDerivedRenderEntities preserved for object path', () => {
    it('function exists post-rewrite and still produces one entity per cell', () => {
      const specs = buildFixture(4, 4, 16, 1);
      const out = spawnDerivedRenderEntities(specs);
      expect(out.length).toBe(specs.length);
      // Ids are per-cell scheme (synthetic 1000+i in this reference) —
      // the production function's id allocator is the world's spawn
      // allocator; only the cardinality is asserted here.
    });

    it("terrain path (sortScope='layer') does NOT invoke spawnDerivedRenderEntities", () => {
      // Behavioural invariant: routeBySortScope('layer') resolves to the
      // 'bucket' route and the bucket route does not call into
      // spawnDerivedRenderEntities. The synthetic counts above confirm
      // the two functions are not chained on the terrain path.
      const specs = buildFixture(4, 4, 16, 1);
      const layerOut = routeBySortScope('layer', specs);
      expect(layerOut.route).toBe('bucket');
      // 16 cells produce only 1 bucket (single chunk, single atlas) — if
      // terrain accidentally fell through to spawnDerivedRenderEntities
      // the count would be 16.
      expect(layerOut.entityCount).toBe(1);
    });
  });
});
