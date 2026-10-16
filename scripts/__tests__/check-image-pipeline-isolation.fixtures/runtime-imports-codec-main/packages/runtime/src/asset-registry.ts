// Positive fixture (w27 path d): runtime statically imports from the
// runtime-safe @forgeax/engine-codec main entry (decompressZstd / parseKtx2).
// The Path (d) gate must PASS (exit 0) — only the encode subpath is blocked,
// the main entry is allowed for runtime decode.

import { decompressZstd, parseKtx2 } from '@forgeax/engine-codec';

export async function loadZstdAsset(bytes: Uint8Array): Promise<Uint8Array> {
  const res = await decompressZstd(bytes);
  if (!res.ok) throw new Error(res.error.code);
  return res.value;
}

export function checkKtx2(bytes: Uint8Array) {
  return parseKtx2(bytes);
}
