import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import type { SpriteInstancesSnapshot } from '../render-system-extract';
import { renderWorldFor } from '../world/render-world';
import { worldEntityKey } from './frame-snapshot';
import { INSTANCE_UBO_FULL_ARRAY_BYTES, MAX_UNIFORM_INSTANCES } from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';

export type { SpriteInstancesSnapshot } from '../render-system-extract';

/**
 * Build the interleaved sprite instance payload consumed by this record owner.
 * The extract stage validates the two packed arrays before they reach this
 * function, so the record path has one source of count-mismatch errors.
 */
export function interleaveSpriteInstanceBuffer(
  out: Float32Array,
  transforms: Float32Array,
  regions: Float32Array,
  includePrevious = false,
): Float32Array {
  const count = transforms.length / 16;
  const stride = includePrevious ? 36 : 20;
  const regionOffset = includePrevious ? 32 : 16;
  if (out.length !== count * stride)
    throw new RangeError('Sprite instance output must match the packed instance count');
  for (let i = 0; i < count; i++) {
    const dstBase = i * stride;
    const transformBase = i * 16;
    const regionBase = i * 4;
    for (let k = 0; k < 16; k++) out[dstBase + k] = transforms[transformBase + k] ?? 0;
    if (includePrevious) {
      for (let k = 0; k < 16; k++) {
        out[dstBase + 16 + k] = transforms[transformBase + k] ?? 0;
      }
    }
    for (let k = 0; k < 4; k++) {
      out[dstBase + regionOffset + k] = regions[regionBase + k] ?? 0;
    }
  }
  return out;
}

/**
 * Check whether the existing per-entity sprite buffer still matches the
 * extract snapshot and interleaved byte count.
 */
export function spriteInstancesCacheHit(
  entry: InstanceBufferCacheEntry | undefined,
  snapshot: Pick<SpriteInstancesSnapshot, 'archVersion'>,
  requestedBytes: number,
): boolean {
  return (
    entry !== undefined &&
    entry.uploadedArchVersion === snapshot.archVersion &&
    entry.uploadedByteLength === requestedBytes
  );
}

export interface SpriteInstanceDraw {
  readonly buffer: Buffer;
  readonly count: number;
  readonly firstInstanceOrdinal: number;
}

/** Native storage keeps one draw; uniform sprites retain contiguous atlas-correct pages. */
export function resolveSpriteInstanceDraws(
  c: Pick<_InternalRenderPipelineContext, 'runtime' | 'frameState'>,
  spriteEntry: _InternalRenderPipelineContext['validatedOrdered'][number],
): readonly SpriteInstanceDraw[] {
  const { runtime } = c;
  const world = renderWorldFor(runtime);
  if (!world.frameArena.isActive)
    return world.withFrameArena(() => ok(resolveSpriteInstanceDraws(c, spriteEntry))).unwrap();
  const snapshot = spriteEntry.source.spriteInstances;
  if (snapshot === undefined) return [];
  if (snapshot.instanceCount === 0) {
    retireSpritePages(c, spriteEntry.source.worldId, snapshot);
    return [];
  }
  const uniform = !runtime.device.caps.storageBuffer;
  const capacity = uniform ? MAX_UNIFORM_INSTANCES : snapshot.instanceCount;
  const draws: SpriteInstanceDraw[] = [];
  for (let start = 0; start < snapshot.instanceCount; start += capacity) {
    const count = Math.min(capacity, snapshot.instanceCount - start);
    const payload = interleaveSpriteInstanceBuffer(
      world.frameArena.alloc(Float32Array, count * (uniform ? 20 : 36)).unwrap(),
      snapshot.transforms.subarray(start * 16, (start + count) * 16),
      snapshot.regions.subarray(start * 4, (start + count) * 4),
      !uniform,
    );
    const buffer = uploadSpriteInstanceBuffer(
      c,
      spriteEntry.source.worldId,
      snapshot,
      payload,
      (uniform ? GPU_BUFFER_USAGE_UNIFORM : GPU_BUFFER_USAGE_STORAGE) | GPU_BUFFER_USAGE_COPY_DST,
      'reduce the sprite collection to fit the device storage binding limit',
      uniform ? start : undefined,
    );
    if (buffer === null) return [];
    draws.push({ buffer, count, firstInstanceOrdinal: start });
  }
  retireSpritePages(c, spriteEntry.source.worldId, snapshot);
  return draws;
}

/** Source shrink and backend recovery release only this collection's obsolete pages. */
function retireSpritePages(
  c: Pick<_InternalRenderPipelineContext, 'runtime' | 'frameState'>,
  worldId: number,
  snapshot: SpriteInstancesSnapshot,
): void {
  const pages = c.frameState.instanceBufferChunks?.get(worldEntityKey(worldId, snapshot.cacheKey));
  if (pages === undefined) return;
  for (const [start, resident] of pages) {
    if (
      !c.runtime.device.caps.storageBuffer &&
      typeof start === 'number' &&
      start < snapshot.instanceCount
    )
      continue;
    const destroyed = resident.buffer.destroy();
    if (!destroyed.ok) c.runtime.errorRegistry.fire(destroyed.error);
    pages.delete(start);
  }
}

/**
 * Sprite-path per-entity instance upload shared by `Instances` and
 * `SpriteInstances`: fire `limit-exceeded` over the storage binding cap, reuse
 * the cached buffer while archVersion and byte length match (otherwise replace
 * and destroy it), then write the payload. Returns the resident handle, or
 * null after a structured failure was fired (or for an empty payload).
 *
 * @internal
 */
export function uploadSpriteInstanceBuffer(
  c: Pick<_InternalRenderPipelineContext, 'runtime' | 'frameState'>,
  worldId: number,
  snapshot: Pick<SpriteInstancesSnapshot, 'archVersion' | 'cacheKey'>,
  payload: Float32Array,
  usage: number,
  limitHint: string,
  pageStart?: number,
): Buffer | null {
  const { runtime, frameState } = c;
  const requestedBytes = payload.byteLength;
  // The uniform fallback is bounded by the shader's fixed instance array, not
  // by the storage binding limit, which no-storage backends report as zero.
  const uniform = (usage & GPU_BUFFER_USAGE_UNIFORM) !== 0;
  const cap = uniform
    ? INSTANCE_UBO_FULL_ARRAY_BYTES
    : runtime.device.limits.maxStorageBufferBindingSize;
  if (typeof cap === 'number' && requestedBytes > cap) {
    runtime.errorRegistry.fire(
      new RhiError({
        code: 'limit-exceeded',
        expected: uniform
          ? `requestedBytes (${requestedBytes}) <= uniform fallback instance array (${cap})`
          : `requestedBytes (${requestedBytes}) <= maxStorageBufferBindingSize (${cap})`,
        hint: limitHint,
        detail: {
          maxStorageBufferBindingSize: cap,
          requestedBytes,
        },
      }),
    );
    return null;
  }
  const key = worldEntityKey(worldId, snapshot.cacheKey);
  const cache = spritePageCache(frameState, key, pageStart);
  const address = pageStart ?? key;
  const cached = cache.get(address);
  let active: InstanceBufferCacheEntry | null = null;
  if (spriteInstancesCacheHit(cached, snapshot, requestedBytes)) {
    active = cached ?? null;
  } else if (requestedBytes > 0) {
    const bufRes = runtime.device.createBuffer({
      // The uniform fallback binding must expose the shader's full fixed array.
      size: uniform ? Math.max(requestedBytes, INSTANCE_UBO_FULL_ARRAY_BYTES) : requestedBytes,
      usage,
      mappedAtCreation: false,
    });
    if (!bufRes.ok) {
      runtime.errorRegistry.fire(bufRes.error);
      return null;
    }
    // feat-20260619 M4 / F12: destroy the old cached buffer before
    // replacing it with the new one (D-6).
    if (cached !== undefined && !cached.buffer.isDestroyed) {
      const r = cached.buffer.destroy();
      if (!r.ok) runtime.errorRegistry.fire(r.error);
    }
    active = {
      buffer: new GpuBuffer(runtime.device, bufRes.value),
      uploadedArchVersion: snapshot.archVersion,
      uploadedByteLength: requestedBytes,
    };
    cache.set(address, active);
    if (pageStart !== undefined && frameState.instanceBufferChunks === undefined)
      frameState.transientInstanceBuffers.push(active);
  }
  if (active === null || requestedBytes === 0) return null;
  const writeRes = runtime.device.queue.writeBuffer(active.buffer.handle, 0, payload);
  if (!writeRes.ok) {
    runtime.errorRegistry.fire(writeRes.error);
    return null;
  }
  return active.buffer.handle;
}

/** Keep sprite pages in the existing collection-owned chunk cache. */
function spritePageCache(
  frameState: _InternalRenderPipelineContext['frameState'],
  key: number,
  pageStart: number | undefined,
): Map<number, InstanceBufferCacheEntry> {
  let cache = frameState.instanceBuffers;
  if (pageStart !== undefined) {
    cache = frameState.instanceBufferChunks?.get(key) ?? new Map();
    frameState.instanceBufferChunks?.set(key, cache);
  }
  return cache;
}
