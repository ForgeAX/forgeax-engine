import { isStripTopology } from '@forgeax/engine-types';
// @forgeax/engine-assets-runtime -- register-time payload validation
// (feat-20260705-runtime-tier2-decomposition M1 / w4, D-4 F1 straight-cut).
// Pure move from asset-registry.ts; zero identifier changes.

import {
  DEFAULT_VERTEX_ATTRIBUTE_MAP,
  deriveVertexCount,
  deriveVertexLayoutProjection,
} from '@forgeax/engine-geometry';
import type {
  Asset,
  AssetErrorDetail,
  TilesetAsset,
  MeshAsset as TypesMeshAsset,
} from '@forgeax/engine-types';
import { ASSET_ERROR_HINTS, AssetError } from '@forgeax/engine-types';

/**
 * Register-stage fail-fast for `kind: 'mesh'` payloads whose vertices buffer
 * does not match the geometry-owned attribute projection.
 *
 * Validation spec (plan-strategy D-3):
 *   (a) asset.kind !== 'mesh' -> return null immediately
 *   (b) vertices.length === 0 && indices.length === 0 -> return null (empty mesh legal)
 *   (c) vertices.byteLength % projection.arrayStride !== 0 -> `AssetError` with
 *       code='mesh-vertex-stride-mismatch', detail = { vertexCount: 0,
 *       floatsPerVertex: vertices.length / projectedFloatsPerVertex } (non-integer)
 *   (d) otherwise compute vertexCount from the same projection;
 *       scan indices for maxIndex;
 *       if maxIndex >= vertexCount -> same AssetError shape with
 *       detail = { vertexCount: maxIndex + 1, floatsPerVertex: vertices.length / (maxIndex + 1) }
 *
 * Isomorphic with `validateMaterialPayload` — both are private module-level helpers,
 * both return `AssetError | null`, and both are called from `register()` at entry.
 *
 * Anchors: charter P3 (structured failure); plan-strategy D-2 (gate at register stage);
 *          plan-strategy D-3 (three-branch validation: empty / non-divisible-12 / maxIndex mismatch);
 *          plan-strategy D-5 (physical location co-located with validateMaterialPayload).
 */
export function validateMeshPayload(asset: Asset): AssetError | null {
  if (asset.kind !== 'mesh') return null;

  // feat-20260604-mesh-topology-debug-draw M5 / w13: semantic topology gate
  // (plan-strategy D-A2).
  //
  // feat-20260608 M2 / w9: topology is now per-submesh (MeshAsset.submeshes[]).
  // All topology + submesh-empty + index-OOB validation runs here.
  const submeshes = (asset as TypesMeshAsset).submeshes;
  if (submeshes.length === 0) {
    // TypesMeshAsset POD does not carry an inline GUID; the registry assigns
    // one on register, but at validation time we only have the payload. Emit
    // a stable sentinel so the closed AssetErrorDetail union still narrows.
    const guid = '<no-guid>';
    return new AssetError({
      code: 'mesh-asset-submeshes-empty',
      expected: 'submeshes array has at least one Submesh entry',
      hint: ASSET_ERROR_HINTS['mesh-asset-submeshes-empty'],
      detail: { meshAssetGuid: guid },
    });
  }

  const materialSlots = (asset as TypesMeshAsset).materialSlots;
  if (!Array.isArray(materialSlots) || materialSlots.length === 0) {
    return new AssetError({
      code: 'mesh-asset-material-slot-index-out-of-range',
      expected: 'a non-empty materialSlots table for a mesh with submeshes',
      hint: ASSET_ERROR_HINTS['mesh-asset-material-slot-index-out-of-range'],
      detail: {
        meshAssetGuid: '<no-guid>',
        submeshIndex: 0,
        materialSlot: -1,
        materialSlotCount: 0,
      },
    });
  }
  const slotNames = new Set<string>();
  const sourceKeys = new Set<string>();
  for (let slotIndex = 0; slotIndex < materialSlots.length; slotIndex++) {
    const slot = materialSlots[slotIndex];
    const slotName = slot?.slotName.trim() ?? '';
    const sourceKey = slot?.sourceKey?.trim();
    if (slotName.length === 0 || slotNames.has(slotName)) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `materialSlots[${slotIndex}].slotName is non-empty and unique`,
        hint: 'give every Mesh material slot a stable unique slotName',
        detail: {
          field: `materialSlots[${slotIndex}].slotName`,
          value: slotName,
          reason: 'empty-or-duplicate',
        },
      });
    }
    slotNames.add(slotName);
    if (sourceKey !== undefined && sourceKey.length > 0) {
      if (sourceKeys.has(sourceKey)) {
        return new AssetError({
          code: 'asset-invalid-value',
          expected: `materialSlots[${slotIndex}].sourceKey is unique when present`,
          hint: 'derive a stable unique source identity for every imported Mesh material slot',
          detail: {
            field: `materialSlots[${slotIndex}].sourceKey`,
            value: sourceKey,
            reason: 'duplicate',
          },
        });
      }
      sourceKeys.add(sourceKey);
    }
  }

  const hasIndices = (asset.indices?.length ?? 0) > 0;
  const indexBufferLength = asset.indices?.length ?? 0;
  for (let i = 0; i < submeshes.length; i++) {
    const sm = submeshes[i];
    if (sm === undefined) continue;
    const topology = sm.topology;
    if (
      !Number.isInteger(sm.materialSlot) ||
      sm.materialSlot < 0 ||
      sm.materialSlot >= materialSlots.length
    ) {
      return new AssetError({
        code: 'mesh-asset-material-slot-index-out-of-range',
        expected: `submesh[${i}].materialSlot in [0, ${materialSlots.length})`,
        hint: ASSET_ERROR_HINTS['mesh-asset-material-slot-index-out-of-range'],
        detail: {
          meshAssetGuid: '<no-guid>',
          submeshIndex: i,
          materialSlot: sm.materialSlot,
          materialSlotCount: materialSlots.length,
        },
      });
    }
    if (isStripTopology(topology) && !hasIndices) {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `submesh[${i}] strip topology carries an index buffer`,
        hint: 'line-strip / triangle-strip meshes must provide indices; add MeshAsset.indices or use line-list / triangle-list',
        detail: {
          field: `submeshes[${i}].topology`,
          value: topology,
          reason: 'strip-topology-without-indices',
        },
      });
    }
    if (asset.vertices.length === 0 && topology !== 'triangle-list') {
      return new AssetError({
        code: 'asset-invalid-value',
        expected: `submesh[${i}]: empty geometry uses 'triangle-list'`,
        hint: 'a zero-vertex mesh has nothing to draw; change submesh topology to triangle-list or provide vertices',
        detail: {
          field: `submeshes[${i}].topology`,
          value: topology,
          reason: 'empty-geometry-non-default-topology',
        },
      });
    }
    // feat-20260608 M2 / w9: index-range-out-of-bounds per submesh
    if (sm.indexOffset + sm.indexCount > indexBufferLength) {
      // TypesMeshAsset POD does not carry an inline GUID; the registry assigns
      // one on register, but at validation time we only have the payload. Emit
      // a stable sentinel so the closed AssetErrorDetail union still narrows.
      const guid = '<no-guid>';
      return new AssetError({
        code: 'mesh-submesh-index-range-out-of-bounds',
        expected: `submesh[${i}].indexOffset + indexCount <= index buffer length (${indexBufferLength})`,
        hint: ASSET_ERROR_HINTS['mesh-submesh-index-range-out-of-bounds'],
        detail: {
          submeshIndex: i,
          indexOffset: sm.indexOffset,
          indexCount: sm.indexCount,
          indexBufferLength,
          meshAssetGuid: guid,
        },
      });
    }
  }

  // indices is optional (vertex-only meshes omit it); read defensively. The
  // stride invariant below stays null-safe for vertex-only meshes (D-A4).
  if (asset.vertices.length === 0 && (asset.indices?.length ?? 0) === 0) return null;

  const attrs = (asset as TypesMeshAsset).attributes;
  const candidateProjection =
    attrs !== undefined && Object.keys(attrs).length > 0
      ? deriveVertexLayoutProjection(attrs)
      : deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP);
  const projection =
    candidateProjection.attributes.length > 0
      ? candidateProjection
      : deriveVertexLayoutProjection(DEFAULT_VERTEX_ATTRIBUTE_MAP);
  const projectedFloatsPerVertex = projection.arrayStride / Float32Array.BYTES_PER_ELEMENT;
  const isSkinned =
    projection.attributes.some((attribute) => attribute.key === 'skinIndex') &&
    projection.attributes.some((attribute) => attribute.key === 'skinWeight');
  const expectedStride =
    isSkinned && projectedFloatsPerVertex === 18
      ? '18 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4 + skinIndex u16x4 + skinWeight vec4)'
      : projectedFloatsPerVertex === 12
        ? '12 floats per vertex (= position vec3 + normal vec3 + uv vec2 + tangent vec4)'
        : `${projectedFloatsPerVertex} floats per vertex from the geometry-owned attribute projection`;
  const vertexCount = deriveVertexCount(asset.vertices, projection);

  if (vertexCount === undefined) {
    return new AssetError({
      code: 'mesh-vertex-stride-mismatch',
      expected: expectedStride,
      hint: 'repack MeshAsset.vertices with the geometry-owned VertexLayoutProjection',
      detail: {
        vertexCount: 0,
        floatsPerVertex: asset.vertices.length / projectedFloatsPerVertex,
      },
    });
  }

  // Vertex-only meshes (no indices) skip the maxIndex-vs-vertexCount invariant:
  // there is no index buffer to bound-check against the vertex array (D-A4).
  const indices = asset.indices;
  if (indices === undefined || indices.length === 0) return null;
  let maxIndex = 0;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    if (idx !== undefined && idx > maxIndex) maxIndex = idx;
  }

  // Indexed draws may share a larger vertex allocation; unused vertices are legal.
  if (maxIndex >= vertexCount) {
    return new AssetError({
      code: 'mesh-vertex-stride-mismatch',
      expected: expectedStride,
      hint: 'repack MeshAsset.vertices with the geometry-owned VertexLayoutProjection',
      detail: {
        vertexCount: maxIndex + 1,
        floatsPerVertex: vertexCount > 0 ? asset.vertices.length / (maxIndex + 1) : 0,
      },
    });
  }

  return null;
}

// === Tileset / Tilemap / TileLayer validators (feat-20260608 M0 baseline rebuild) ===
//
// R-6 first-error path (plan-strategy §R-6 ordering, M1 extended):
//   (1) `atlases.length >= 1`                -> 'tileset-tile-entry-malformed'
//                                                .field='atlases' .scope='tileset-asset' (M1)
//   (2) region rectangle stays in atlas      -> 'tileset-region-index-out-of-range' (M0)
//   (3) `region.atlasIndex` in atlases range -> 'tileset-tile-entry-malformed'
//                                                .field='atlasIndex' .scope='tileset-asset' (M1)
//   (4) `tiles[i].regionIndex` in regions    -> 'tileset-region-index-out-of-range' (M0)
//   (5) tile entry widthCells / heightCells  -> 'tileset-tile-entry-malformed'
//        / pivotX / pivotY / collider           .field=<field> .scope='tile-entry'
//                                                .tileEntryIndex=i (M1)
//
// Tilemap / TileLayer register-time invariants use `AssetError
// 'asset-invalid-value'` with `.detail = { field, value, reason }` so the
// closed AssetErrorDetail discriminated union narrows uniformly (charter
// P4 consistent abstraction with `validateMeshPayload`).

/**
 * Optional atlas extent for `validateTilesetPayload`. When omitted, the
 * region-rectangle bounds-check is skipped — only the
 * `tiles[].regionIndex` in `[0, regions.length)` invariant runs.
 */
export interface TilesetValidateOptions {
  readonly atlasWidth?: number;
  readonly atlasHeight?: number;
}

/**
 * Construct an `AssetError` for the M1 `tileset-tile-entry-malformed`
 * code with structured `.detail` (closed 7-variant `.field` enum +
 * 2-variant `.scope` + optional `.tileEntryIndex`). The helper centralises
 * the boilerplate so each call site stays a one-liner (charter F1 single
 * affordance) and the `.detail` shape stays SSOT-aligned with
 * `AssetTilesetTileEntryMalformedDetail`.
 */
function tileEntryMalformed(args: {
  tilesetGuid: string;
  field: 'widthCells' | 'heightCells' | 'pivotX' | 'pivotY' | 'collider' | 'atlases' | 'atlasIndex';
  scope: 'tileset-asset' | 'tile-entry';
  tileEntryIndex?: number;
  expected: string;
}): AssetError {
  const detail: AssetErrorDetail = {
    code: 'tileset-tile-entry-malformed',
    field: args.field,
    scope: args.scope,
    tilesetGuid: args.tilesetGuid,
    ...(args.tileEntryIndex !== undefined ? { tileEntryIndex: args.tileEntryIndex } : {}),
    expected: args.expected,
    hint: ASSET_ERROR_HINTS['tileset-tile-entry-malformed'],
  };
  return new AssetError({
    code: 'tileset-tile-entry-malformed',
    expected: args.expected,
    hint: ASSET_ERROR_HINTS['tileset-tile-entry-malformed'],
    detail,
  });
}

/**
 * Validate the shape of a `TilesetTileCollider` value (R-6 step 5d).
 * Returns `null` when the collider is well-formed, otherwise an
 * `AssetError` with code `'tileset-tile-entry-malformed'` and
 * `.detail.field = 'collider'` (charter P3 closed schema).
 *
 * Rules per variant:
 *   - `'none'` -- always accepted.
 *   - `'rect'` -- `rect.length === 4`; each component in `[0, 1]`;
 *     `w > 0`, `h > 0`; `x + w <= 1`, `y + h <= 1`.
 *   - `'polygon'` -- `points.length >= 3`; each point's `x` and `y` in
 *     `[0, 1]`.
 *   - any other `type` discriminator surfaces the same `.field='collider'`
 *     fail-fast (unreachable through the typed surface but defends
 *     against unchecked JSON loaders, charter P4 fail-fast in depth).
 */
function validateColliderShape(
  collider: NonNullable<TilesetTileEntryColliderField>,
  tilesetGuid: string,
  tileEntryIndex: number,
): AssetError | null {
  if (collider.type === 'none') return null;
  if (collider.type === 'rect') {
    const rect = collider.rect;
    if (!Array.isArray(rect) || rect.length !== 4) {
      return tileEntryMalformed({
        tilesetGuid,
        field: 'collider',
        scope: 'tile-entry',
        tileEntryIndex,
        expected: `tiles[${tileEntryIndex}].collider.rect length === 4`,
      });
    }
    const [rx, ry, rw, rh] = rect;
    const valid =
      typeof rx === 'number' &&
      typeof ry === 'number' &&
      typeof rw === 'number' &&
      typeof rh === 'number' &&
      rx >= 0 &&
      ry >= 0 &&
      rw > 0 &&
      rh > 0 &&
      rx + rw <= 1 &&
      ry + rh <= 1;
    if (!valid) {
      return tileEntryMalformed({
        tilesetGuid,
        field: 'collider',
        scope: 'tile-entry',
        tileEntryIndex,
        expected: `tiles[${tileEntryIndex}].collider.rect in [0, 1]^2 with w > 0, h > 0, x + w <= 1, y + h <= 1`,
      });
    }
    return null;
  }
  if (collider.type === 'polygon') {
    const points = collider.points;
    if (!Array.isArray(points) || points.length < 3) {
      return tileEntryMalformed({
        tilesetGuid,
        field: 'collider',
        scope: 'tile-entry',
        tileEntryIndex,
        expected: `tiles[${tileEntryIndex}].collider.points length >= 3`,
      });
    }
    for (let j = 0; j < points.length; j++) {
      const p = points[j];
      if (
        !Array.isArray(p) ||
        p.length !== 2 ||
        typeof p[0] !== 'number' ||
        typeof p[1] !== 'number' ||
        p[0] < 0 ||
        p[0] > 1 ||
        p[1] < 0 ||
        p[1] > 1
      ) {
        return tileEntryMalformed({
          tilesetGuid,
          field: 'collider',
          scope: 'tile-entry',
          tileEntryIndex,
          expected: `tiles[${tileEntryIndex}].collider.points[${j}] in [0, 1]^2`,
        });
      }
    }
    return null;
  }
  // Unknown discriminator (only reachable via unchecked JSON loaders bypassing
  // the typed surface). Closed enum -> fail-fast (charter P3).
  return tileEntryMalformed({
    tilesetGuid,
    field: 'collider',
    scope: 'tile-entry',
    tileEntryIndex,
    expected: `tiles[${tileEntryIndex}].collider.type in {'none', 'rect', 'polygon'}`,
  });
}

/**
 * Internal alias for the optional `collider` field on `TilesetTileEntry`.
 * Localised to keep the validator helper signature math-free.
 */
type TilesetTileEntryColliderField = TilesetAsset['tiles'][number]['collider'];

/**
 * Validate a `TilesetAsset` payload at register time (M0 baseline rebuild
 * + M1 schema extension). Returns `null` on success or an `AssetError`
 * carrying the first-error details (charter P3 fail-fast). R-6 ordering:
 *
 *   1. `atlases.length >= 1` -- 'tileset-tile-entry-malformed' .field='atlases'.
 *   2. Region rectangle escapes atlas extent (when extent is supplied) --
 *      M0 code 'tileset-region-index-out-of-range'.
 *   3. `regions[i].atlasIndex` in `[0, atlases.length)` -- 'tileset-tile-entry-malformed'
 *      .field='atlasIndex'.
 *   4. `tiles[i].regionIndex` in `[0, regions.length)` -- M0 code.
 *   5. Per-tile-entry boundaries -- 'tileset-tile-entry-malformed'
 *      .field=widthCells | heightCells | pivotX | pivotY | collider,
 *      in that order, .scope='tile-entry' .tileEntryIndex=i.
 */
export function validateTilesetPayload(
  asset: TilesetAsset,
  opts: TilesetValidateOptions = {},
): AssetError | null {
  const assetGuid = '<no-guid>';
  // (1) atlases empty fail-fast (M1 R-6 top-level invariant).
  if (asset.atlases.length < 1) {
    return tileEntryMalformed({
      tilesetGuid: assetGuid,
      field: 'atlases',
      scope: 'tileset-asset',
      expected: 'atlases.length >= 1',
    });
  }

  const regionCount = asset.regions.length;
  const atlasesLength = asset.atlases.length;
  // (2) region rectangle bounds-check. Negative coords / non-positive size are
  // rejected regardless of whether an atlas extent is supplied; the optional
  // atlasWidth / atlasHeight tightens the upper bound when present.
  const atlasWidth = opts.atlasWidth;
  const atlasHeight = opts.atlasHeight;
  for (let i = 0; i < regionCount; i++) {
    const region = asset.regions[i];
    if (region === undefined) continue;
    const negativeOrZero = region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0;
    const exceedsAtlas =
      typeof atlasWidth === 'number' &&
      typeof atlasHeight === 'number' &&
      (region.x + region.width > atlasWidth || region.y + region.height > atlasHeight);
    if (negativeOrZero || exceedsAtlas) {
      return new AssetError({
        code: 'tileset-region-index-out-of-range',
        expected: `regions[${i}] rectangle (x/y >= 0, width/height > 0${
          typeof atlasWidth === 'number' && typeof atlasHeight === 'number'
            ? `, x + width <= ${atlasWidth}, y + height <= ${atlasHeight}`
            : ''
        })`,
        hint: ASSET_ERROR_HINTS['tileset-region-index-out-of-range'],
        detail: {
          code: 'tileset-region-index-out-of-range',
          tilesetGuid: assetGuid,
          tileId: 0,
          regionIndex: i,
          regionCount,
        },
      });
    }
    // (3) per-region atlasIndex bounds-check (M1; optional field defaults 0).
    if (region.atlasIndex !== undefined) {
      const ai = region.atlasIndex;
      if (!Number.isInteger(ai) || ai < 0 || ai >= atlasesLength) {
        return tileEntryMalformed({
          tilesetGuid: assetGuid,
          field: 'atlasIndex',
          scope: 'tileset-asset',
          expected: `regions[${i}].atlasIndex in [0, ${atlasesLength})`,
        });
      }
    }
  }
  // (4) tile entry regionIndex in [0, regions.length) (M0 code).
  for (let i = 0; i < asset.tiles.length; i++) {
    const entry = asset.tiles[i];
    if (entry === undefined) continue;
    const ri = entry.regionIndex;
    if (!Number.isInteger(ri) || ri < 0 || ri >= regionCount) {
      return new AssetError({
        code: 'tileset-region-index-out-of-range',
        expected: `tiles[${i}].regionIndex in [0, ${regionCount})`,
        hint: ASSET_ERROR_HINTS['tileset-region-index-out-of-range'],
        detail: {
          code: 'tileset-region-index-out-of-range',
          tilesetGuid: assetGuid,
          tileId: i + 1,
          regionIndex: ri,
          regionCount,
        },
      });
    }
  }
  // (5) per-tile-entry M1 boundaries -- widthCells > heightCells > pivotX >
  // pivotY > collider, per plan-strategy §R-6 first-error order. Each loop
  // iteration runs the full sub-order on entry i before advancing to i+1 so
  // the deterministic global order is (i=0 widthCells, i=0 heightCells, ...,
  // i=0 collider, i=1 widthCells, ...). Tests in tileset-asset-validate.test.ts
  // R-6 block exercise the sub-order on a single entry.
  for (let i = 0; i < asset.tiles.length; i++) {
    const entry = asset.tiles[i];
    if (entry === undefined) continue;
    if (entry.widthCells !== undefined) {
      const w = entry.widthCells;
      if (!Number.isFinite(w) || w <= 0 || w > 64) {
        return tileEntryMalformed({
          tilesetGuid: assetGuid,
          field: 'widthCells',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].widthCells in (0, 64]`,
        });
      }
    }
    if (entry.heightCells !== undefined) {
      const h = entry.heightCells;
      if (!Number.isFinite(h) || h <= 0 || h > 64) {
        return tileEntryMalformed({
          tilesetGuid: assetGuid,
          field: 'heightCells',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].heightCells in (0, 64]`,
        });
      }
    }
    if (entry.pivotX !== undefined) {
      const px = entry.pivotX;
      if (!Number.isFinite(px) || px < 0 || px > 1) {
        return tileEntryMalformed({
          tilesetGuid: assetGuid,
          field: 'pivotX',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].pivotX in [0, 1]`,
        });
      }
    }
    if (entry.pivotY !== undefined) {
      const py = entry.pivotY;
      if (!Number.isFinite(py) || py < 0 || py > 1) {
        return tileEntryMalformed({
          tilesetGuid: assetGuid,
          field: 'pivotY',
          scope: 'tile-entry',
          tileEntryIndex: i,
          expected: `tiles[${i}].pivotY in [0, 1]`,
        });
      }
    }
    if (entry.collider !== undefined) {
      const colliderErr = validateColliderShape(entry.collider, assetGuid, i);
      if (colliderErr !== null) return colliderErr;
    }
  }
  return null;
}

/**
 * Compute the implicit atlas extent of a `TilesetAsset` from its grid metadata
 * (`columns * tileWidth` x `rows * tileHeight`). Used by the register-time
 * region-bounds check when the caller does not supply explicit extents.
 */
export function inferAtlasExtent(asset: TilesetAsset): { atlasWidth: number; atlasHeight: number } {
  return {
    atlasWidth: asset.columns * asset.tileWidth,
    atlasHeight: asset.rows * asset.tileHeight,
  };
}
