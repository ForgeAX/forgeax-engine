export const VFX_DIAGNOSTIC_TAPE_BYTES = 64 * 1024 * 1024;

/** Keep the original byte budget below the Browser command's WebSocket limit. */
export function encodeVfxDiagnosticTape(bytes: Uint8Array): string {
  if (bytes.byteLength > VFX_DIAGNOSTIC_TAPE_BYTES)
    throw new Error('VFX diagnostic tape exceeds 64MiB');
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}
