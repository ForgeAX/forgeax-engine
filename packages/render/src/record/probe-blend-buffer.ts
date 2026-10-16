import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { ProbeBlendBufferProjection } from '../scene/probe-blend';
import {
  PROBE_BLEND_RECORD_STRIDE,
  type ProbeBlendRecord,
  probeBlendRecordOffset,
} from '../scene/probe-blend-record';
import type { RenderFrameState } from './frame-snapshot';

export interface ProbeBlendBufferRecord {
  readonly cacheKey: number;
  readonly record: ProbeBlendRecord;
}

function isProbeBlendProjection(
  input: ProbeBlendBufferProjection | readonly ProbeBlendBufferRecord[],
): input is ProbeBlendBufferProjection {
  return !Array.isArray(input);
}

function retireProbeBlendRecordBuffer(buffer: GpuBuffer): void {
  const destroy = (): void => {
    if (!buffer.isDestroyed) void buffer.destroy();
  };
  void buffer.device.queue.onSubmittedWorkDone().then(destroy, destroy);
}

function createCompleteProbeBlendBuffer(
  device: RhiDevice,
  requiredCapacity: number,
  records: readonly ProbeBlendBufferRecord[],
): {
  readonly buffer: GpuBuffer;
  readonly cache: ReadonlyMap<number, { readonly generation: number; readonly bytes: Uint8Array }>;
} {
  const created = device.createBuffer({
    label: 'probe-blend-records',
    size: requiredCapacity * PROBE_BLEND_RECORD_STRIDE,
    usage:
      (device.caps.storageBuffer ? GPU_BUFFER_USAGE_STORAGE : GPU_BUFFER_USAGE_UNIFORM) |
      GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!created.ok) throw created.error;
  const candidate = new GpuBuffer(device, created.value);
  const cache = new Map<number, { readonly generation: number; readonly bytes: Uint8Array }>();
  try {
    for (const { cacheKey, record } of records) {
      const uploaded = device.queue.writeBuffer(
        candidate.handle,
        probeBlendRecordOffset(record.objectKey),
        record.bytes,
      );
      if (!uploaded.ok) throw uploaded.error;
      cache.set(cacheKey, {
        generation: record.generation,
        bytes: new Uint8Array(record.bytes),
      });
    }
  } catch (cause) {
    void candidate.destroy();
    throw cause;
  }
  return { buffer: candidate, cache };
}

/**
 * Retain one device buffer for direct and scene-index ProbeBlend consumers.
 * Capacity is settled before any upload so a growth cannot erase records
 * written earlier in the same frame. Slot zero remains the producer sentinel;
 * RenderScene object slot N occupies aligned record N+1. A requested empty
 * projection still binds slot zero for cooked programs with an always-present ABI.
 */
export function ensureProbeBlendRecordBuffer(
  device: RhiDevice,
  frameState: Pick<
    RenderFrameState,
    | 'probeBlendRecordBuffer'
    | 'probeBlendRecordBufferCapacity'
    | 'probeBlendBuffers'
    | 'probeBlendRecordProjection'
  >,
  input: ProbeBlendBufferProjection | readonly ProbeBlendBufferRecord[] | undefined,
): Buffer {
  const projection = input !== undefined && isProbeBlendProjection(input) ? input : undefined;
  const records: readonly ProbeBlendBufferRecord[] =
    input === undefined
      ? []
      : (projection?.records ?? (input as readonly ProbeBlendBufferRecord[]));
  let buffer = frameState.probeBlendRecordBuffer;
  const accepted = frameState.probeBlendRecordProjection;
  if (
    projection !== undefined &&
    accepted?.projection === projection &&
    accepted.device === device
  ) {
    if (accepted.buffer === buffer && buffer !== undefined && !buffer.isDestroyed) {
      return buffer.handle;
    }
  }
  const requiredCapacity = Math.max(
    1,
    projection?.capacity ??
      records.reduce((capacity, { record }) => Math.max(capacity, record.objectKey + 2), 1),
  );
  const grows =
    buffer === undefined ||
    buffer.isDestroyed ||
    buffer.device !== device ||
    frameState.probeBlendRecordBufferCapacity < requiredCapacity;
  const hasAcceptedBaseline =
    projection !== undefined &&
    accepted !== undefined &&
    accepted.device === device &&
    accepted.buffer === buffer &&
    buffer !== undefined &&
    !buffer.isDestroyed &&
    accepted.projection.sourceIdentity === projection.sourceIdentity &&
    accepted.projection.revision === projection.baseRevision;
  const requiresCompletePublish =
    grows ||
    (projection !== undefined && (!hasAcceptedBaseline || projection.dirtyRecords.length > 1));
  if (requiresCompletePublish) {
    const candidate = createCompleteProbeBlendBuffer(device, requiredCapacity, records);
    const previous = buffer;
    buffer = candidate.buffer;
    frameState.probeBlendRecordBuffer = candidate.buffer;
    frameState.probeBlendRecordBufferCapacity = requiredCapacity;
    frameState.probeBlendBuffers.clear();
    for (const [key, value] of candidate.cache) frameState.probeBlendBuffers.set(key, value);
    if (projection === undefined) delete frameState.probeBlendRecordProjection;
    else frameState.probeBlendRecordProjection = { projection, device, buffer: candidate.buffer };
    if (previous !== undefined) retireProbeBlendRecordBuffer(previous);
    return candidate.buffer.handle;
  }
  if (buffer === undefined) throw new Error('probe blend record buffer allocation failed');
  // Reading slot zero leaves the accepted scene projection and its uploads intact.
  if (input === undefined) return buffer.handle;
  const changed = projection?.dirtyRecords ?? records;
  const cacheUpdates: [number, { readonly generation: number; readonly bytes: Uint8Array }][] = [];
  for (const { cacheKey, record } of changed) {
    const cached = frameState.probeBlendBuffers.get(cacheKey);
    const unchanged =
      cached !== undefined &&
      cached.generation === record.generation &&
      cached.bytes.length === record.bytes.length &&
      cached.bytes.every((value, index) => value === record.bytes[index]);
    if (unchanged) continue;
    const uploaded = device.queue.writeBuffer(
      buffer.handle,
      probeBlendRecordOffset(record.objectKey),
      record.bytes,
    );
    if (!uploaded.ok) throw uploaded.error;
    cacheUpdates.push([
      cacheKey,
      { generation: record.generation, bytes: new Uint8Array(record.bytes) },
    ]);
  }
  for (const [cacheKey, value] of cacheUpdates) frameState.probeBlendBuffers.set(cacheKey, value);
  for (const cacheKey of projection?.removedCacheKeys ?? []) {
    frameState.probeBlendBuffers.delete(cacheKey);
  }
  if (projection === undefined) delete frameState.probeBlendRecordProjection;
  else frameState.probeBlendRecordProjection = { projection, device, buffer };
  return buffer.handle;
}
