import { createHash } from 'node:crypto';
import { compressZstd } from '@forgeax/engine-codec/encode';
import type { CookedMaterialRecord } from '@forgeax/engine-pack';
import { MATERIAL_PUBLICATION_V1 } from '../program-publication';

/** Store each validated artifact once, even when several passes or material recipes reference it. */
export async function packMaterialPrograms(
  records: readonly CookedMaterialRecord[],
): Promise<string> {
  const windows = new Map<string, readonly [number, number]>();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const entries = records.map((record) => {
    const ranges: Record<string, readonly [number, number]> = Object.create(null);
    const programs = record.programs.map((program) => {
      const { bytes, ...artifact } = program.artifact;
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest)
        throw new Error(`Invalid cooked artifact digest for ${record.guid}`);
      let window = windows.get(artifact.digest);
      if (!window) {
        window = [length, bytes.length];
        windows.set(artifact.digest, window);
        chunks.push(bytes);
        length += bytes.length;
      }
      if (ranges[artifact.path] && ranges[artifact.path] !== window)
        throw new Error(`Conflicting cooked artifact path for ${record.guid}`);
      ranges[artifact.path] = window;
      return { ...program, artifact };
    });
    return { record: { ...record, programs }, ranges };
  });
  const metadata = Buffer.from(JSON.stringify(entries));
  const header = Buffer.alloc(8);
  header.writeUInt32BE(MATERIAL_PUBLICATION_V1);
  header.writeUInt32LE(metadata.length, 4);
  const packed = await compressZstd(Buffer.concat([header, metadata, ...chunks]));
  if (!packed.ok) throw packed.error;
  return Buffer.from(packed.value).toString('base64');
}
