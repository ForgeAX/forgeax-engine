import { DEFERRED_ATTACHMENT_BYTES, DEFERRED_COLOR_FORMATS } from '../standard-attachments';

/** Base Deferred admission shared by device-default and camera-feature selection. */
export function supportsStandardDeferred(
  caps: { readonly storageBuffer: boolean; readonly maxColorAttachments: number },
  bytesPerSample: number | undefined,
): boolean {
  return (
    caps.storageBuffer &&
    caps.maxColorAttachments >= DEFERRED_COLOR_FORMATS.length &&
    (bytesPerSample ?? 32) >= DEFERRED_ATTACHMENT_BYTES.surface
  );
}
