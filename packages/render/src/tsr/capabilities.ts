import { RenderGraphError } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { TSR_RASTER_ATTACHMENT_BYTES_PER_SAMPLE } from './layout';

export function tsrUnavailable(): RenderGraphError {
  return new RenderGraphError({
    code: 'resource-resolution-failed',
    expected: 'TSR requires compute/storage textures or three HDR raster attachments',
    hint: 'select spatial antialiasing or a device with HDR MRT support',
    detail: { resourceLabel: 'tsr' },
  });
}

export function usesTsrCompute(caps: {
  readonly compute: boolean;
  readonly storageTexture?: boolean | undefined;
}): boolean {
  return caps.compute && caps.storageTexture === true;
}

/** Reject unsupported devices before the temporal owner allocates any surfaces. */
export function requireTsrCapabilities(device: RhiDevice): void {
  const compute = usesTsrCompute(device.caps);
  const raster =
    device.caps.rgba16floatRenderable &&
    device.caps.maxColorAttachments >= 3 &&
    (device.limits.maxColorAttachmentBytesPerSample ?? 32) >=
      TSR_RASTER_ATTACHMENT_BYTES_PER_SAMPLE;
  if (!compute && !raster) throw tsrUnavailable();
}
