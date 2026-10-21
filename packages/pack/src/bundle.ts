import { err, ok, type Result } from '@forgeax/engine-types';

/**
 * Asset Bundle file: `FXBUNDL1`, u32le entry count, u32le entry lengths, then
 * the entries back to back. The table lets a reader split one fetched file into
 * independently releasable entries; descriptors address entries by absolute offset.
 */
const MAGIC = [0x46, 0x58, 0x42, 0x55, 0x4e, 0x44, 0x4c, 0x31] as const;

export interface AssetBundleWindow {
  readonly offset: number;
  readonly length: number;
}

export function encodeAssetBundle(entries: readonly Uint8Array[]): {
  readonly bytes: Uint8Array;
  readonly windows: readonly AssetBundleWindow[];
} {
  const header = 12 + 4 * entries.length;
  const bytes = new Uint8Array(entries.reduce((total, entry) => total + entry.byteLength, header));
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC);
  view.setUint32(8, entries.length, true);
  const windows: AssetBundleWindow[] = [];
  let offset = header;
  entries.forEach((entry, index) => {
    view.setUint32(12 + 4 * index, entry.byteLength, true);
    bytes.set(entry, offset);
    windows.push({ offset, length: entry.byteLength });
    offset += entry.byteLength;
  });
  return { bytes, windows };
}

export function readAssetBundleTable(
  bytes: Uint8Array,
): Result<readonly AssetBundleWindow[], string> {
  if (bytes.byteLength < 12 || MAGIC.some((byte, index) => bytes[index] !== byte))
    return err('missing FXBUNDL1 header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8, true);
  const header = 12 + 4 * count;
  if (header > bytes.byteLength) return err('entry table exceeds the file');
  const windows: AssetBundleWindow[] = [];
  let offset = header;
  for (let index = 0; index < count; index++) {
    const length = view.getUint32(12 + 4 * index, true);
    windows.push({ offset, length });
    offset += length;
  }
  return offset === bytes.byteLength ? ok(windows) : err('entry lengths do not cover the file');
}
