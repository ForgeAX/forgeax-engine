import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decodeDocumentText } from '@forgeax/engine-codec';
import { compressZstd } from '@forgeax/engine-codec/encode';
import type { DistArtifact } from './dist.js';

/** Decode the same document representation consumed by runtime asset readers. */
export async function readDeliveryDocument(path: string): Promise<string> {
  const text = await decodeDocumentText(await readFile(path));
  if (!text.ok) throw new Error(`${path}: document decode failed: ${text.error.code}`);
  return text.value;
}

export async function prepareDocuments(
  root: string,
  artifacts: readonly DistArtifact[],
  selected: (path: string) => boolean,
  compress: boolean,
): Promise<DistArtifact[]> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      if (!selected(artifact.path)) return artifact;
      const path = resolve(root, artifact.path);
      const plain = Buffer.from(await readDeliveryDocument(path));
      const result = compress ? await compressZstd(plain) : { ok: true as const, value: plain };
      if (!result.ok)
        throw new Error(`${artifact.path}: zstd compression failed: ${result.error.code}`);
      await writeFile(path, result.value);
      return {
        ...artifact,
        bytes: result.value.byteLength,
        sha256: createHash('sha256').update(result.value).digest('hex'),
      };
    }),
  );
}
