// @forgeax/engine-rhi-debug/src/recorder/external-texture -- self-contained
// capture of imported textures and per-frame external (video) textures.

/// <reference types="@webgpu/types" />

import type {
  ExternalTexture,
  ExternalTextureDescriptor,
  ExternalTextureSource,
  Result,
  RhiDevice,
  RhiError,
  RhiQueue,
  Texture,
} from '@forgeax/engine-rhi';
import type { HandleId, RhiCallEvent } from '../types';
import type { RecorderInternal } from './core';
import {
  pushEvent,
  registerHandle,
  shouldRecord,
  TEXTURE_USAGE_COPY_DST,
  TEXTURE_USAGE_COPY_SRC,
} from './core';

const RGBA8_BYTES = 4;

/**
 * A borrowed texture enters the tape as an ordinary createTexture event. Its
 * bytes are seeded by the frame-header snapshot only when the caller created
 * it with COPY_SRC; the engine never widens the usage of a texture it does not
 * own, so a non-readable import replays with zero contents.
 */
export async function recordImportTexture(
  s: RecorderInternal,
  realDevice: RhiDevice,
  texture: GPUTexture,
): Promise<Result<Texture, RhiError>> {
  const res = await realDevice.importTexture(texture);
  if (!res.ok) return res;
  const size = {
    width: texture.width,
    height: texture.height,
    depthOrArrayLayers: texture.depthOrArrayLayers,
  };
  const replayUsage = texture.usage | TEXTURE_USAGE_COPY_SRC | TEXTURE_USAGE_COPY_DST;
  const event: RhiCallEvent = {
    kind: 'createTexture',
    handleId: '' as HandleId,
    desc: {
      ...(texture.label === '' ? {} : { label: texture.label }),
      size,
      mipLevelCount: texture.mipLevelCount,
      sampleCount: texture.sampleCount,
      dimension: texture.dimension,
      format: texture.format,
      usage: replayUsage,
    },
  };
  const resource = res.value as object;
  const handleId = registerHandle(s, resource, 'texture', event);
  if ((texture.usage & TEXTURE_USAGE_COPY_SRC) !== 0) {
    s.descriptorTable.set(handleId, {
      kind: 'texture',
      size,
      format: texture.format,
      mipLevelCount: texture.mipLevelCount,
      usage: texture.usage,
      resource,
    });
  }
  pushEvent(s, event);
  return res;
}

function sourceExtent(source: ExternalTextureSource): { width: number; height: number } {
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
    return { width: source.displayWidth, height: source.displayHeight };
  }
  const video = source as HTMLVideoElement;
  return { width: video.videoWidth, height: video.videoHeight };
}

function readSourcePixels(
  source: ExternalTextureSource,
  width: number,
  height: number,
): Uint8ClampedArray | undefined {
  if (typeof OffscreenCanvas === 'undefined' || width === 0 || height === 0) return undefined;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (ctx === null) return undefined;
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * While recording, an external texture is also snapshotted on the CPU into a
 * recorded rgba8unorm texture. Bind groups that sample the external texture
 * record that snapshot view instead, so the tape replays the exact frame on a
 * fresh device without any media object. The snapshot is frame-scoped like
 * the external texture it mirrors.
 */
export function recordImportExternalTexture(
  s: RecorderInternal,
  realDevice: RhiDevice,
  proxy: RhiDevice,
  queue: RhiQueue,
  desc: ExternalTextureDescriptor,
): Result<ExternalTexture, RhiError> {
  const res = realDevice.importExternalTexture(desc);
  if (!res.ok || !shouldRecord(s)) return res;
  const { width, height } = sourceExtent(desc.source);
  const pixels = readSourcePixels(desc.source, width, height);
  if (pixels === undefined) return res;
  const tex = proxy.createTexture({
    label: `rhi-debug:external-snapshot:${desc.label ?? 'video'}`,
    size: { width, height },
    format: 'rgba8unorm',
    usage: 0x04,
  });
  if (!tex.ok) return res;
  queue.writeTexture(
    { texture: tex.value },
    pixels,
    { bytesPerRow: width * RGBA8_BYTES, rowsPerImage: height },
    { width, height },
  );
  const view = proxy.createTextureView(tex.value, {});
  if (!view.ok) {
    proxy.destroyTexture(tex.value);
    return res;
  }
  const viewId = s.textureViewHandleMap.get(view.value);
  if (viewId !== undefined) {
    s.handleMap.set(res.value as object, { handleId: viewId });
    const pending = s.pendingExternalBindings.get(res.value as object);
    s.pendingExternalBindings.delete(res.value as object);
    for (const { event, index } of pending ?? []) {
      if (event.kind !== 'createBindGroup') continue;
      (event.resourceHandleIds as HandleId[])[index] = viewId;
      const entry = event.entries[index];
      if (entry !== undefined) (entry as { resourceKind: string }).resourceKind = 'textureView';
      // The patched bind group now depends on a resource created inside this
      // capture, so it leaves the bootstrap prefix and replays after the view.
      if (s.bootstrapCreates.get(event.handleId) === event)
        s.bootstrapCreates.delete(event.handleId);
      if (!s.events.includes(event)) pushEvent(s, event);
    }
  }
  s.frameEndReleases.push(() => {
    proxy.destroyTexture(tex.value);
  });
  return res;
}
