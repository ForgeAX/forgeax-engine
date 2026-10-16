import type { ReplayReadbackResult } from '@forgeax/engine-rhi-debug';

export function formatBufferHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

export function formatBufferTyped(bytes: Uint8Array): string {
  if (bytes.byteLength < 4 || bytes.byteLength % 4 !== 0) return 'unavailable';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 4)
    values.push(view.getUint32(offset, true));
  return `uint32 [${values.join(', ')}]`;
}

export function bufferRange(result: ReplayReadbackResult): {
  readonly offset: number;
  readonly size: number;
} {
  const request = result.provenance.subresource;
  if (result.kind !== 'buffer' || request === null || !('offset' in request))
    return { offset: 0, size: result.bytes.byteLength };
  return { offset: request.offset, size: request.size ?? result.bytes.byteLength };
}
