import type { Buffer, RhiDevice } from '@forgeax/engine-rhi';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { ProbeBlendBufferProjection } from '../scene/probe-blend';
import {
  PROBE_BLEND_RECORD_BYTE_SIZE,
  PROBE_BLEND_RECORD_STRIDE,
  type ProbeBlendRecord,
  probeBlendRecordOffset,
} from '../scene/probe-blend-record';
import type { ProbeBlendBufferCacheEntry, RenderFrameState } from './frame-snapshot';

const EMPTY_PROBE_ROWS: readonly ProbeBlendBufferRecord[] = Object.freeze([]);

interface ProbeBlendBufferRecord {
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

type ProbeBufferState = Pick<
  RenderFrameState,
  | 'probeBlendRecordBuffer'
  | 'probeBlendRecordBufferCapacity'
  | 'probeBlendRecordTransfer'
  | 'probeBlendBuffers'
  | 'probeBlendRecordProjection'
>;

/** Publish a sparse revision in one queue operation on the live destination. */
function publishProbeRows(
  device: RhiDevice,
  state: ProbeBufferState,
  destination: Buffer,
  rows: readonly ProbeBlendBufferRecord[],
): void {
  const used = rows.length * PROBE_BLEND_RECORD_BYTE_SIZE;
  let transfer = state.probeBlendRecordTransfer;
  if (transfer === undefined || transfer.bytes.byteLength < used) {
    const capacity = Math.min(
      state.probeBlendRecordBufferCapacity * PROBE_BLEND_RECORD_BYTE_SIZE,
      Math.max(used, (transfer?.bytes.byteLength ?? 0) * 2),
    );
    const bytes = new Uint8Array(capacity);
    const created = device.createBuffer({
      label: 'probe-blend-transfer',
      size: capacity,
      usage: GPU_BUFFER_USAGE_COPY_SRC | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!created.ok) throw created.error;
    if (transfer !== undefined) retireProbeBlendRecordBuffer(transfer.buffer);
    transfer = { buffer: new GpuBuffer(device, created.value), bytes };
    state.probeBlendRecordTransfer = transfer;
  }
  const encoder = device.createCommandEncoder({ label: 'probe-blend-update' });
  if (!encoder.ok) throw encoder.error;
  let offset = 0;
  for (const { record } of rows) {
    if (record.bytes.byteLength !== PROBE_BLEND_RECORD_BYTE_SIZE) {
      throw new Error('probe blend upload requires a complete record');
    }
    transfer.bytes.set(record.bytes, offset);
    encoder.value.copyBufferToBuffer(
      transfer.buffer.handle,
      offset,
      destination,
      probeBlendRecordOffset(record.objectKey),
      PROBE_BLEND_RECORD_BYTE_SIZE,
    );
    offset += PROBE_BLEND_RECORD_BYTE_SIZE;
  }
  const commands = encoder.value.finish();
  if (!commands.ok) throw commands.error;
  const staged = device.queue.writeBuffer(transfer.buffer.handle, 0, transfer.bytes, 0, used);
  if (!staged.ok) throw staged.error;
  const submitted = device.queue.submit([commands.value]);
  if (!submitted.ok) throw submitted.error;
}

function rememberProbeRow(
  receipts: Map<number, ProbeBlendBufferCacheEntry>,
  { cacheKey, record }: ProbeBlendBufferRecord,
): void {
  const previous = receipts.get(cacheKey);
  if (previous !== undefined && previous.bytes.byteLength === record.bytes.byteLength) {
    previous.bytes.set(record.bytes);
    previous.generation = record.generation;
  } else {
    receipts.set(cacheKey, { generation: record.generation, bytes: new Uint8Array(record.bytes) });
  }
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
  frameState: ProbeBufferState,
  input: ProbeBlendBufferProjection | readonly ProbeBlendBufferRecord[] | undefined,
): Buffer {
  let buffer = frameState.probeBlendRecordBuffer;
  if (input === undefined && buffer?.device === device && !buffer.isDestroyed) return buffer.handle;
  const projection = input !== undefined && isProbeBlendProjection(input) ? input : undefined;
  const direct: readonly ProbeBlendBufferRecord[] =
    input !== undefined && !isProbeBlendProjection(input) ? input : EMPTY_PROBE_ROWS;
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
      direct.reduce((capacity, { record }) => Math.max(capacity, record.objectKey + 2), 1),
  );
  const replacesBuffer =
    buffer === undefined ||
    buffer.isDestroyed ||
    buffer.device !== device ||
    frameState.probeBlendRecordBufferCapacity < requiredCapacity ||
    // Reclaim a sparse high-water allocation after the producer's active extent contracts.
    (projection !== undefined &&
      requiredCapacity * 4 < frameState.probeBlendRecordBufferCapacity) ||
    // The last local probe retires every old row at once. A sentinel-only
    // binding keeps unchanged object generations from reading stale GPU bytes.
    (input !== undefined &&
      requiredCapacity === 1 &&
      frameState.probeBlendRecordBufferCapacity > 1);
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
    replacesBuffer || (projection !== undefined && !hasAcceptedBaseline);
  if (requiresCompletePublish) {
    const candidate = createCompleteProbeBlendBuffer(
      device,
      requiredCapacity,
      projection?.records ?? direct,
    );
    const previous = buffer;
    buffer = candidate.buffer;
    frameState.probeBlendRecordBuffer = candidate.buffer;
    frameState.probeBlendRecordBufferCapacity = requiredCapacity;
    frameState.probeBlendBuffers.clear();
    for (const [key, value] of candidate.cache) frameState.probeBlendBuffers.set(key, value);
    if (projection === undefined) delete frameState.probeBlendRecordProjection;
    else frameState.probeBlendRecordProjection = { projection, device, buffer: candidate.buffer };
    const transfer = frameState.probeBlendRecordTransfer;
    if (transfer !== undefined) {
      retireProbeBlendRecordBuffer(transfer.buffer);
      delete frameState.probeBlendRecordTransfer;
    }
    if (previous !== undefined) retireProbeBlendRecordBuffer(previous);
    return candidate.buffer.handle;
  }
  if (buffer === undefined) throw new Error('probe blend record buffer allocation failed');
  // Reading slot zero leaves the accepted scene projection and its uploads intact.
  if (input === undefined) return buffer.handle;
  const changed = projection?.dirtyRecords ?? direct;
  if (projection !== undefined && changed.length > 1) {
    publishProbeRows(device, frameState, buffer.handle, changed);
    for (const row of changed) rememberProbeRow(frameState.probeBlendBuffers, row);
  } else {
    for (const row of changed) {
      const { cacheKey, record } = row;
      const cached = frameState.probeBlendBuffers.get(cacheKey);
      if (
        cached !== undefined &&
        cached.generation === record.generation &&
        cached.bytes.length === record.bytes.length &&
        cached.bytes.every((value, index) => value === record.bytes[index])
      )
        continue;
      const uploaded = device.queue.writeBuffer(
        buffer.handle,
        probeBlendRecordOffset(record.objectKey),
        record.bytes,
      );
      if (!uploaded.ok) throw uploaded.error;
      rememberProbeRow(frameState.probeBlendBuffers, row);
      // An independent write supersedes scene evidence even if a later write fails.
      if (projection === undefined) delete frameState.probeBlendRecordProjection;
    }
  }
  for (const cacheKey of projection?.removedCacheKeys ?? []) {
    frameState.probeBlendBuffers.delete(cacheKey);
  }
  if (projection !== undefined)
    frameState.probeBlendRecordProjection = { projection, device, buffer };
  return buffer.handle;
}
