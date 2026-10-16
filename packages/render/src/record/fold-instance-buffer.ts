import type { Buffer } from '@forgeax/engine-rhi';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import {
  type FoldBucket,
  INSTANCE_UBO_FULL_ARRAY_BYTES,
  packInstanceStorageBuffer,
} from './mesh-ssbo';
import type { _InternalRenderPipelineContext } from './render-context';

/** Both transparent draw owners consume one fold payload and resident cache. */
export function resolveFoldInstanceBuffer(
  c: _InternalRenderPipelineContext,
  bucket: FoldBucket,
  headIndex: number,
): Buffer | null {
  const { runtime, frameState } = c;
  const key = -1 - (((bucket.materialHandle & 0xffff) << 16) | (headIndex & 0xffff));
  const uniform = runtime.device.caps.storageBuffer === false;
  const payload = uniform ? bucket.transforms : packInstanceStorageBuffer(bucket.transforms);
  let resident = frameState.instanceBuffers.get(key);
  if (resident === undefined || resident.uploadedByteLength !== payload.byteLength) {
    const created = runtime.device.createBuffer({
      // The uniform fallback binding must expose the shader's full fixed array.
      size: uniform
        ? Math.max(payload.byteLength, INSTANCE_UBO_FULL_ARRAY_BYTES)
        : payload.byteLength,
      usage:
        (uniform ? GPU_BUFFER_USAGE_UNIFORM : GPU_BUFFER_USAGE_STORAGE) | GPU_BUFFER_USAGE_COPY_DST,
      mappedAtCreation: false,
    });
    if (!created.ok) {
      runtime.errorRegistry.fire(created.error);
      return null;
    }
    if (resident !== undefined && !resident.buffer.isDestroyed) {
      const destroyed = resident.buffer.destroy();
      if (!destroyed.ok) runtime.errorRegistry.fire(destroyed.error);
    }
    resident = {
      buffer: new GpuBuffer(runtime.device, created.value),
      uploadedArchVersion: bucket.bucketSize,
      uploadedByteLength: payload.byteLength,
    };
    frameState.instanceBuffers.set(key, resident);
  }
  // Equal bucket size does not imply unchanged transforms (moving sprites).
  const written = runtime.device.queue.writeBuffer(resident.buffer.handle, 0, payload);
  if (!written.ok) {
    runtime.errorRegistry.fire(written.error);
    return null;
  }
  return resident.buffer.handle;
}

/** Attribute a recorded instanced fold to its complete source roster. */
export function createFoldedDrawRecorder(
  c: Pick<_InternalRenderPipelineContext, 'validatedOrdered' | 'onRenderableDraw'>,
) {
  let members: ReadonlyMap<number, NonNullable<(typeof c.validatedOrdered)[number]>> | undefined;
  return (
    entry: NonNullable<(typeof c.validatedOrdered)[number]>,
    submesh?: number,
    receipt?: import('./gpu-draw-receipts').RenderableDrawReceipt,
    bucket?: FoldBucket,
  ): void => {
    if (c.onRenderableDraw === undefined) return;
    if (bucket === undefined) {
      c.onRenderableDraw(entry, submesh, receipt);
      return;
    }
    members ??= new Map(
      c.validatedOrdered.flatMap((row) =>
        row === undefined ? [] : [[row.renderableIndex, row] as const],
      ),
    );
    for (const member of bucket.entries) {
      const presented = members.get(member.renderableIndex);
      if (presented !== undefined) c.onRenderableDraw(presented, submesh, receipt);
    }
  };
}
