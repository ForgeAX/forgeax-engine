import type { EntityHandle } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';

export const VIDEO_SOURCE_PROVIDER_KEY = 'VideoSourceProvider' as const;

/** Host owns decoding and lifetime. Renderer samples the current source without closing it. */
export interface VideoSourceProvider {
  /** DOM hosts return their element; Workers return a received or decoded VideoFrame. */
  getSource(
    entity: EntityHandle,
    clipHandle: Handle<'VideoAsset', 'shared'>,
  ): HTMLVideoElement | VideoFrame | undefined;
}

/** A video element can have dimensions before a decoded frame is available. */
export function videoSourceExtent(
  source: HTMLVideoElement | VideoFrame,
): { width: number; height: number } | undefined {
  const width = 'videoWidth' in source ? source.videoWidth : source.displayWidth;
  const height = 'videoHeight' in source ? source.videoHeight : source.displayHeight;
  if (width <= 0 || height <= 0 || ('readyState' in source && source.readyState < 2))
    return undefined;
  return { width, height };
}
