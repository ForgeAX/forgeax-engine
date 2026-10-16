// Negative fixture (w27 path d): runtime statically imports from the build-time
// encode subpath. The Path (d) gate must FAIL with the AC-15 (d) FAIL marker:
// runtime static import of @forgeax/engine-codec/encode is forbidden — the encode
// subpath is build-time only.

import { compressZstd } from '@forgeax/engine-codec/encode';

export async function loadCompressedAsset(bytes: Uint8Array): Promise<Uint8Array> {
  return compressZstd(bytes);
}
