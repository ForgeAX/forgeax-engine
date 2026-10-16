import { RhiError } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { gpuDrivenSourceDrawItemIndex } from '../extract/gpu-driven';
import { worldEntityKey } from '../record/frame-snapshot';
import type { RenderSceneSlot } from '../scene/render-scene-types';

/** One submitted raster address resolves through that frame's scene projection. */
export const VISIBLE_SURFACE_RECORD_WORDS = 16;

export interface VisibleSurfaceProjection {
  /** 64-byte rows; zero is reserved for uncovered pixels, addresses start at one. */
  readonly records: Uint32Array;
  /** Entity base + drawItemIndex * instanceCount + instanceOrdinal. */
  readonly slotBases: ReadonlyMap<number, number>;
  readonly entityBases: ReadonlyMap<number, number>;
}

export interface VisibleSurfaceIdentity {
  readonly slot: number;
  readonly generation: number;
  readonly worldId: number;
  readonly entityKey: number;
  readonly instanceOrdinal: number;
  /** Zero means a non-instanced entity; actual instances require owner generations. */
  readonly instanceGeneration: number;
  readonly drawItemIndex: number;
  readonly materialHandle: number;
  readonly assetHandle: number;
  readonly indexed: boolean;
  /** Element offset in the actual source draw, not a mesh-global primitive ID. */
  readonly firstElement: number;
  readonly baseVertex: number;
}

function invalid(expected: string, hint: string): Result<never, RhiError> {
  return err(new RhiError({ code: 'rhi-descriptor-invalid', expected, hint }));
}

/**
 * A disposable projection of RenderScene identities, never a second identity
 * allocator. Keep it with its submitted frame; a later frame may reuse rows.
 * Draw holes preserve the original submesh address after transparent filtering.
 */
export function projectVisibleSurfaces(
  slots: readonly RenderSceneSlot[],
  maxRecords: number,
): Result<VisibleSurfaceProjection, RhiError> {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 0 || maxRecords > 0xffff_fffe) {
    return invalid(
      'a bounded u32 visible-surface row budget',
      'set the renderer row budget before projection',
    );
  }
  const slotBases = new Map<number, number>();
  const entityBases = new Map<number, number>();
  const ordered = [...slots].sort((a, b) => a.slot - b.slot);
  let count = 0;
  for (const slot of ordered) {
    const source = slot.snapshot;
    const draws = source.gpuDrivenDraws ?? [];
    if (source.authorVisible === false || draws.length === 0) continue;
    if (slotBases.has(slot.slot)) {
      return invalid(
        'one retained RenderScene record per slot',
        'rebuild the scene projection from the owning renderer',
      );
    }
    // Deformed and LOD draws publish no rows until their producers publish matching
    // raster addresses: their pixels read as uncovered (row 0) instead of failing
    // every frame of a scene that also holds a skinned character.
    if (source.skin !== undefined || source.morph !== undefined || (source.lods?.length ?? 0) > 0)
      continue;
    const instances = source.instances;
    const instanceCount = instances?.instanceCount ?? 1;
    if (!Number.isSafeInteger(instanceCount) || instanceCount < 1) {
      return invalid(
        'a positive admitted instance count',
        'repair the Instances producer before preparing visible surfaces',
      );
    }
    if (instances !== undefined) {
      const generations = instances.generations;
      if (
        generations?.length !== instanceCount ||
        new Set(generations).size !== instanceCount ||
        generations.some((generation) => generation === 0)
      ) {
        return invalid(
          'unique nonzero owner generations for every instance',
          'publish stable Instances generations; ordinals alone cannot prove history after reordering or reuse',
        );
      }
    }
    let drawCount = 0;
    const seen = new Set<number>();
    for (const [index, draw] of draws.entries()) {
      const drawItem = gpuDrivenSourceDrawItemIndex(draw, index);
      if (
        !Number.isSafeInteger(drawItem) ||
        drawItem < 0 ||
        seen.has(drawItem) ||
        draw.topology !== 'triangle-list' ||
        !Number.isInteger(draw.first) ||
        draw.first < 0 ||
        !Number.isInteger(draw.count) ||
        draw.count < 0 ||
        draw.count % 3 !== 0 ||
        draw.first + draw.count > 0xffff_ffff ||
        !Number.isInteger(draw.baseVertex) ||
        draw.baseVertex < -0x8000_0000 ||
        draw.baseVertex > 0x7fff_ffff
      ) {
        return invalid(
          'unique triangle-list source draw ranges',
          'repair source submesh identities and triangle ranges before raster admission',
        );
      }
      seen.add(drawItem);
      drawCount = Math.max(drawCount, drawItem + 1);
    }
    const required = drawCount * instanceCount;
    if (!Number.isSafeInteger(required) || required > maxRecords - count) {
      return invalid(
        'the complete visible-surface projection fits its row budget',
        'increase the explicit renderer budget or reduce admitted content; do not truncate contributors',
      );
    }
    slotBases.set(slot.slot, count + 1);
    entityBases.set(worldEntityKey(slot.worldId, slot.entityKey), count + 1);
    count += required;
  }
  const records = new Uint32Array(count * VISIBLE_SURFACE_RECORD_WORDS);
  for (const slot of ordered) {
    const base = slotBases.get(slot.slot);
    if (base === undefined) continue;
    const source = slot.snapshot;
    const instanceCount = source.instances?.instanceCount ?? 1;
    for (const [index, draw] of (source.gpuDrivenDraws ?? []).entries()) {
      const drawItemIndex = gpuDrivenSourceDrawItemIndex(draw, index);
      const material = source.materials[draw.materialSlot];
      if (material === undefined) {
        return invalid(
          'each visible draw resolves its own material slot',
          'repair the mesh/material binding before preparing the raster frame',
        );
      }
      for (let instanceOrdinal = 0; instanceOrdinal < instanceCount; instanceOrdinal++) {
        const offset =
          (base - 1 + drawItemIndex * instanceCount + instanceOrdinal) *
          VISIBLE_SURFACE_RECORD_WORDS;
        records.set(
          [
            slot.slot,
            slot.generation,
            slot.worldId,
            slot.entityKey,
            instanceOrdinal,
            source.instances?.generations?.[instanceOrdinal] ?? 0,
            drawItemIndex,
            material.materialHandle ?? 0,
            source.assetHandle,
            draw.first,
            draw.count,
            draw.baseVertex,
            draw.kind === 'indexed' ? 1 : 0,
          ],
          offset,
        );
      }
    }
  }
  return ok({ records, slotBases, entityBases });
}

/** Debug/reference decode of the same row the GPU consumes; no triangle search. */
export function resolveVisibleSurface(
  projection: Pick<VisibleSurfaceProjection, 'records'>,
  row: number,
  primitive: number,
): Result<VisibleSurfaceIdentity | undefined, RhiError> {
  if (row === 0) return ok(undefined);
  const offset = (row - 1) * VISIBLE_SURFACE_RECORD_WORDS;
  const words = projection.records;
  if (
    !Number.isInteger(row) ||
    row < 1 ||
    offset + VISIBLE_SURFACE_RECORD_WORDS > words.length ||
    // RenderScene generations start at zero. A hole has no source elements;
    // generation zero must never be used as a missing-record sentinel.
    words[offset + 10] === 0
  ) {
    return invalid(
      'a covered raster row from the same submitted frame',
      'use the projection retained with this capture/receipt, not the latest live scene',
    );
  }
  if (!Number.isInteger(primitive) || primitive < 0 || primitive >= (words[offset + 10] ?? 0) / 3) {
    return invalid(
      'a draw-local primitive inside the captured source range',
      'inspect the selected raster draw and its matching frame projection',
    );
  }
  return ok({
    slot: words[offset] ?? 0,
    generation: words[offset + 1] ?? 0,
    worldId: words[offset + 2] ?? 0,
    entityKey: words[offset + 3] ?? 0,
    instanceOrdinal: words[offset + 4] ?? 0,
    instanceGeneration: words[offset + 5] ?? 0,
    drawItemIndex: words[offset + 6] ?? 0,
    materialHandle: words[offset + 7] ?? 0,
    assetHandle: words[offset + 8] ?? 0,
    firstElement: (words[offset + 9] ?? 0) + primitive * 3,
    baseVertex: (words[offset + 11] ?? 0) | 0,
    indexed: words[offset + 12] === 1,
  });
}
