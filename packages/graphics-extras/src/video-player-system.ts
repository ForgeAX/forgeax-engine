// @forgeax/engine-graphics-extras — zero-copy video capability probe.
//
// The per-frame video binding lives in the record stage (`videoTextureView`):
// it reads the host-registered VideoSourceProvider (World Resource). A material
// slot declared `texture_external` binds the frame zero-copy through
// `RhiDevice.importExternalTexture` when this probe is true; every other slot,
// and every device reporting `caps.externalTexture === false`, copies the frame
// through `DynamicTextureStore.uploadFrame` (copyExternalImageToTexture). A
// VideoPlayer entity with no host element fires the structured
// `VideoUploadUnsupportedError` on the engine error channel.

import type { RhiCaps } from '@forgeax/engine-rhi';

/** Minimal device shape the probe inspects; unit tests drive it with a small object. */
export interface VideoCapabilityDevice {
  readonly caps: Pick<RhiCaps, 'externalTexture'>;
}

/**
 * Zero-copy video is capability data: `caps.externalTexture` is true only on a
 * WebGPU device whose realm can import HTMLVideoElement / VideoFrame sources.
 */
export function probeVideoHighPerfUpload(device: VideoCapabilityDevice | undefined): boolean {
  return device?.caps.externalTexture === true;
}
