import { readFile } from 'node:fs/promises';
import { decodeDocumentText } from '@forgeax/engine-codec';
import { compressZstd } from '@forgeax/engine-codec/encode';

/** Decode the same document representation consumed by runtime asset readers. */
export async function readDeliveryDocument(path: string): Promise<string> {
  const text = await decodeDocumentText(await readFile(path));
  if (!text.ok) throw new Error(`${path}: document decode failed: ${text.error.code}`);
  return text.value;
}

export async function encodeDeliveryDocument(path: string, plain: Uint8Array): Promise<Uint8Array> {
  const result = await compressZstd(plain, { level: 19 });
  if (!result.ok) throw new Error(`${path}: zstd compression failed: ${result.error.code}`);
  return result.value;
}
