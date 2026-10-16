import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import type { SpriteInstancesSnapshot } from '../render-system-extract';
import { worldEntityKey } from './frame-snapshot';
import { INSTANCE_UBO_FULL_ARRAY_BYTES } from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';

export type { SpriteInstancesSnapshot } from '../render-system-extract';

/**
 * Build the interleaved sprite instance payload consumed by this record owner.
 * The extract stage validates the two packed arrays before they reach this
 * function, so the record path has one source of count-mismatch errors.
 */
export function interleaveSpriteInstanceBuffer(
  transforms: Float32Array,
  regions: Float32Array,
  includePrevious = false,
): Float32Array {
  const count = transforms.length / 16;
  const stride = includePrevious ? 36 : 20;
  const regionOffset = includePrevious ? 32 : 16;
  const out = new Float32Array(count * stride);
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

/**
 * feat-20260704 M3/w19: resolve the interleaved SpriteInstances (@group(3))
 * buffer + instanceCount for a sprite entity in the LDR blend sub-pass,
 * extracted verbatim from recordSpriteEntityDraws. Uploads the interleaved
 * mat4 + per-instance UV region transforms (cache-keyed on the snapshot); on
 * over-cap fires the structured limit-exceeded error and leaves the passed-in
 * fallback buffer/count. Returns the resolved (or unchanged) buffer + count.
 *
 * @internal
 */
export function resolveSpriteInstancesBuffer(
  c: Pick<_InternalRenderPipelineContext, 'runtime' | 'frameState'>,
  spriteEntry: _InternalRenderPipelineContext['validatedOrdered'][number],
  fallbackBuffer: Buffer,
  fallbackCount: number,
): { buffer: Buffer; count: number } {
  const { runtime } = c;
  let buffer = fallbackBuffer;
  let count = fallbackCount;
  const spriteInstancesSnap: SpriteInstancesSnapshot | undefined =
    spriteEntry.source.spriteInstances;
  if (spriteInstancesSnap !== undefined) {
    if (spriteInstancesSnap.instanceCount === 0) return { buffer, count: 0 };
    const uniformFallback = runtime.device.caps.storageBuffer === false;
    const interleaved = interleaveSpriteInstanceBuffer(
      spriteInstancesSnap.transforms,
      spriteInstancesSnap.regions,
      !uniformFallback,
    );
    const uploaded = uploadSpriteInstanceBuffer(
      c,
      spriteEntry.source.worldId,
      spriteInstancesSnap,
      interleaved,
      (uniformFallback ? GPU_BUFFER_USAGE_UNIFORM : GPU_BUFFER_USAGE_STORAGE) |
        GPU_BUFFER_USAGE_COPY_DST,
      uniformFallback
        ? 'reduce SpriteInstances instance count to 128 (uniform fallback array, 80 bytes per instance: mat4 64B + region 16B) or use a storage-capable backend'
        : 'reduce SpriteInstances instance count to fit within device.limits.maxStorageBufferBindingSize (144 bytes per instance: current mat4 64B + previous mat4 64B + region 16B)',
    );
    if (uploaded !== null) {
      buffer = uploaded;
      count = spriteInstancesSnap.instanceCount;
    }
  }
  return { buffer, count };
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
  const cached = frameState.instanceBuffers.get(key);
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
    frameState.instanceBuffers.set(key, active);
  }
  if (active === null || requestedBytes === 0) return null;
  const writeRes = runtime.device.queue.writeBuffer(active.buffer.handle, 0, payload);
  if (!writeRes.ok) {
    runtime.errorRegistry.fire(writeRes.error);
    return null;
  }
  return active.buffer.handle;
}
