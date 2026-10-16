// @forgeax/engine-runtime / instance-buffer-cache
//
// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M-4 / w16.
//
// SSOT for the per-RenderSystem instance-transform GPU storage cache:
//   - the cache entry shape (buffer + uploaded bookkeeping fingerprints)
//   - the dispose-path walk that releases every entry's GpuBuffer
//
// Moved out of render-system-record.ts so the entry shape stays
// independent of the record pipeline (architecture-principles §4 pipeline
// isolation: a cache structure that 4+ consumers share is decoupled from
// the consumer that records frames). Per-frame Map.delete cleanup keeps
// its existing semantics inline at the record stage (plan-strategy D-7
// + OOS-11: dispose path is the new branch, per-frame stays as-is).

import type { GpuBuffer } from './gpu-resource';

/**
 * One entry of the per-RenderSystem instance-transform GPU storage cache.
 *
 * The `buffer` field is a `GpuBuffer` wrapper (feat-20260612 M-2/M-3): it
 * holds the raw RHI handle, owns the lifecycle (`destroy()` + `isDestroyed`)
 * and routes dispose through the RHI shim's destroy bookkeeping SSOT. The
 * two `uploaded*` fields are the cache invalidation fingerprint -- when the
 * archetype version bumps or the byte length changes, the record stage
 * allocates a fresh GpuBuffer and replaces the entry. World-authored Instances
 * use renderer-private projection identity; sprite/fold snapshots use entity
 * identity. Neither cache key is an authoring handle.
 */
export interface InstanceBufferCacheEntry {
  readonly buffer: GpuBuffer;
  readonly uploadedByteLength: number;
  readonly uploadedArchVersion: number;
  /** Accepted instance-projection revision uploaded into this buffer. */
  readonly uploadedRevision?: number;
  /** See `InstanceResidentUpload.uploadedMotionRows`. */
  readonly uploadedMotionRows?: readonly { readonly start: number; readonly end: number }[];
}

/** Each collection owns its numeric chunk starts and releases them together. */
export type InstanceBufferChunks = Map<number, Map<number, InstanceBufferCacheEntry>>;

function destroyInstanceBufferEntries(
  entries: Iterable<InstanceBufferCacheEntry>,
  errorRegistry?: InstanceBufferCacheErrorSink,
): void {
  for (const entry of entries) {
    if (entry.buffer.isDestroyed) continue;
    const r = entry.buffer.destroy();
    if (!r.ok && errorRegistry) errorRegistry.fire(r.error);
  }
}

/**
 * Minimal error-registry surface accepted by disposeInstanceBuffers —
 * only needs `fire`, matching RhiErrorListenerRegistry (feat-20260619 D-6).
 */
export interface InstanceBufferCacheErrorSink {
  fire(e: { code: string }): void;
}

/**
 * Walk an instance-buffer cache Map, destroy every entry's GpuBuffer, then
 * clear the Map. Called from `Renderer.dispose()` (M-5) as the per-frame
 * instance-buffer release step in the dispose chain
 * (plan-strategy D-2: gpuStore.destroyAll -> graph.drain ->
 * frameState.instanceBuffers cleanup -> ...).
 *
 * Idempotent (architecture-principles §6): a second call after the Map was
 * cleared is a no-op. Each `.destroy()` routes through the RHI shim's
 * per-handle bookkeeping; a stray second-destroy on a handle that the
 * runtime did not flip surfaces as the structured 'destroy-after-destroy'
 * RhiError from the shim. That error is *not* re-thrown -- this helper
 * is a sweep that tolerates per-handle failures so the dispose chain can
 * make progress (mirrors `GpuResidencyCache.destroyAll`'s policy;
 * plan-strategy D-3 / D-8).
 *
 * feat-20260619 M4 (D-6): the optional `errorRegistry` parameter unifies
 * the dispose path with the per-frame path — destroy failures fire
 * errorRegistry + sweep continues. Callers that lack an error registry
 * (unit tests of the helper itself) omit the parameter safely.
 *
 * Per-frame Map.delete cleanup at the record stage keeps its existing
 * 'just delete the key' semantics (plan-strategy D-7 + OOS-11): the
 * per-frame path bumps fingerprints when the archetype version changes,
 * letting the next record stage replace the entry; only the dispose
 * exit path walks-then-destroys.
 */
export function disposeInstanceBuffers(
  map: Map<number, InstanceBufferCacheEntry>,
  errorRegistry?: InstanceBufferCacheErrorSink,
): void {
  destroyInstanceBufferEntries(map.values(), errorRegistry);
  map.clear();
}

/** Destroy the renderer-owned buffers used by internal large-instance chunks. */
export function disposeInstanceBufferChunks(
  map: InstanceBufferChunks,
  errorRegistry?: InstanceBufferCacheErrorSink,
): void {
  for (const chunks of map.values()) destroyInstanceBufferEntries(chunks.values(), errorRegistry);
  map.clear();
}

/** Destroy transient uniform-fallback chunks allocated for the previous frame. */
export function disposeTransientInstanceBuffers(
  entries: InstanceBufferCacheEntry[],
  errorRegistry?: InstanceBufferCacheErrorSink,
): void {
  destroyInstanceBufferEntries(entries, errorRegistry);
  entries.length = 0;
}
