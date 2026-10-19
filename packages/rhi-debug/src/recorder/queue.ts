// @forgeax/engine-rhi-debug/src/recorder/queue -- queue proxy owner.

import {
  type Buffer,
  type CommandBuffer,
  type RhiQueue,
  textureCopyOrigin,
} from '@forgeax/engine-rhi';
import { projectTextureExtent, textureBlockLayout } from '../texel-layout';
import type { RhiCallEventWriteTexture } from '../types';
import type { RecorderInternal } from './core';
import {
  getHandleId,
  invalidateTinyTextureShadow,
  pushEvent,
  shouldRecord,
  storeOwnedBlob,
} from './core';

function rememberTinyTextureUpload(
  s: RecorderInternal,
  destination: Parameters<RhiQueue['writeTexture']>[0],
  data: Parameters<RhiQueue['writeTexture']>[1],
  dataLayout: Parameters<RhiQueue['writeTexture']>[2],
  copySize: Parameters<RhiQueue['writeTexture']>[3],
): void {
  const handleId = s.handleMap.get(destination.texture as object)?.handleId;
  if (handleId === undefined) return;
  const entry = s.descriptorTable.get(handleId);
  const extent = projectTextureExtent(entry?.size);
  const copy = projectTextureExtent(copySize);
  const block = textureBlockLayout(entry?.format);
  const origin = textureCopyOrigin(destination.origin);
  const zeroOrigin = origin.x === 0 && origin.y === 0 && origin.z === 0;
  if (
    entry?.kind !== 'texture' ||
    extent === undefined ||
    copy === undefined ||
    (entry.usage & (0x08 | 0x10)) !== 0 ||
    extent.width !== 1 ||
    extent.height !== 1 ||
    copy.width !== 1 ||
    copy.height !== 1 ||
    copy.layerCount !== extent.layerCount ||
    (entry.mipLevelCount ?? 1) !== 1 ||
    (destination.mipLevel ?? 0) !== 0 ||
    !zeroOrigin ||
    block === undefined ||
    block.blockWidth !== 1 ||
    block.blockHeight !== 1 ||
    block.bytesPerBlock > 16
  ) {
    s.tinyTextureShadow.delete(handleId);
    return;
  }
  const raw = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const rowBytes = dataLayout.bytesPerRow ?? block.bytesPerBlock;
  const imageStride = rowBytes * (dataLayout.rowsPerImage ?? 1);
  const offset = dataLayout.offset ?? 0;
  const lastByte = offset + (extent.layerCount - 1) * imageStride + block.bytesPerBlock;
  if (rowBytes < block.bytesPerBlock || imageStride < rowBytes || lastByte > raw.byteLength) {
    s.tinyTextureShadow.delete(handleId);
    return;
  }
  const tight = new Uint8Array(extent.layerCount * block.bytesPerBlock);
  for (let layer = 0; layer < extent.layerCount; layer += 1) {
    tight.set(
      raw.subarray(
        offset + layer * imageStride,
        offset + layer * imageStride + block.bytesPerBlock,
      ),
      layer * block.bytesPerBlock,
    );
  }
  s.tinyTextureShadow.set(handleId, tight);
}

export function createQueueProxy(s: RecorderInternal, realQueue: RhiQueue): RhiQueue {
  return {
    writeBuffer(
      buffer: Buffer,
      bufferOffset: number,
      data: ArrayBufferView | ArrayBuffer,
      dataOffset?: number,
      size?: number,
    ) {
      // Idle fast-path: when not recording, skip getHandleId + slice + the
      // storeOwnedBlob hash-and-copy entirely (they would only feed a
      // pushEvent that the state gate drops, and blobPool is reset on arm()).
      // Same-condition-as-pushEvent, so a recording call still records.
      const recording = shouldRecord(s);
      const shadowId = s.handleMap.get(buffer as object)?.handleId;
      const shadow = shadowId === undefined ? undefined : s.indexBufferShadow.get(shadowId);
      if (!recording && shadow === undefined) {
        return realQueue.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
      }
      const raw = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const sz = size ?? raw.byteLength - (dataOffset ?? 0);
      const slice = raw.slice(dataOffset ?? 0, (dataOffset ?? 0) + sz);
      const result = realQueue.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
      if (!result.ok) return result;
      if (shadowId !== undefined && s.indexBufferShadow.has(shadowId)) {
        if (shadow !== null && shadow !== undefined && bufferOffset + sz <= shadow.byteLength)
          shadow.set(slice, bufferOffset);
        else if (bufferOffset === 0 && sz === s.descriptorTable.get(shadowId)?.size)
          s.indexBufferShadow.set(shadowId, slice);
        else s.indexBufferShadow.set(shadowId, null);
      }
      if (recording) {
        const hId = getHandleId(s, buffer as object, 'buffer');
        const dataHash = storeOwnedBlob(s, slice.buffer as ArrayBuffer);
        pushEvent(s, { kind: 'writeBuffer', handleId: hId, bufferOffset, dataHash, size: sz });
      }
      return result;
    },

    writeTexture(destination, data, dataLayout, copySize) {
      // Idle fast-path (see writeBuffer): skip storeOwnedBlob hash+copy when the
      // recorded event would be dropped anyway.
      if (!shouldRecord(s)) {
        const result = realQueue.writeTexture(destination, data, dataLayout, copySize);
        if (result.ok) rememberTinyTextureUpload(s, destination, data, dataLayout, copySize);
        return result;
      }
      const hId = getHandleId(s, destination.texture as object, 'texture');
      const raw = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      // Store exactly the view: a subarray upload (one mip of a packed chain)
      // must not record its whole backing buffer.
      const dataHash = storeOwnedBlob(s, raw.slice().buffer as ArrayBuffer);

      pushEvent(s, {
        kind: 'writeTexture',
        destination: {
          textureHandleId: hId,
          mipLevel: destination.mipLevel,
          origin: destination.origin,
          aspect: destination.aspect,
        },
        dataHash,
        dataLayout: {
          offset: dataLayout.offset,
          bytesPerRow: dataLayout.bytesPerRow,
          rowsPerImage: dataLayout.rowsPerImage,
        },
        size: copySize,
      } as RhiCallEventWriteTexture);
      const result = realQueue.writeTexture(destination, data, dataLayout, copySize);
      if (result.ok) rememberTinyTextureUpload(s, destination, data, dataLayout, copySize);
      return result;
    },

    copyExternalImageToTexture(source, destination, copySize) {
      if (!shouldRecord(s)) {
        const result = realQueue.copyExternalImageToTexture(source, destination, copySize);
        if (result.ok) invalidateTinyTextureShadow(s, destination.texture as object);
        return result;
      }
      const hId = getHandleId(s, destination.texture as object, 'texture');
      pushEvent(s, {
        kind: 'copyExternalImageToTexture',
        source: { origin: source.origin, flipY: source.flipY },
        destination: {
          textureHandleId: hId,
          mipLevel: destination.mipLevel,
          origin: destination.origin,
          aspect: destination.aspect,
          colorSpace: destination.colorSpace,
          premultipliedAlpha: destination.premultipliedAlpha,
        },
        copySize,
      });
      const result = realQueue.copyExternalImageToTexture(source, destination, copySize);
      if (result.ok) invalidateTinyTextureShadow(s, destination.texture as object);
      return result;
    },

    submit(commandBuffers: readonly CommandBuffer[]) {
      if (!shouldRecord(s)) {
        return realQueue.submit(commandBuffers);
      }
      const cmdHandleIds = commandBuffers.map((cb) =>
        getHandleId(s, cb as object, 'commandBuffer'),
      );
      pushEvent(s, { kind: 'submit', cmdHandleIds });
      return realQueue.submit(commandBuffers);
    },

    onSubmittedWorkDone() {
      return realQueue.onSubmittedWorkDone();
    },
  };
}
