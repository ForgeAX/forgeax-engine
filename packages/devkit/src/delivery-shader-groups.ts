import { compressZstd } from '@forgeax/engine-codec/encode';
import type { ArtifactDescriptor } from '@forgeax/engine-types';

/** Limit shared decompression work; a single larger program remains indivisible. */
export const SHADER_GROUP_TARGET_BYTES = 1024 * 1024;

export interface ShaderGroupEntry {
  readonly identity: string;
  readonly bytes: Uint8Array;
}

/** Whole programs share compression history without parsing or changing WGSL. */
export async function compressShaderGroups(entries: readonly ShaderGroupEntry[]) {
  const groups: ShaderGroupEntry[][] = [];
  let group: ShaderGroupEntry[] = [],
    size = 0;
  for (const entry of entries) {
    if (group.length > 0 && size + entry.bytes.byteLength > SHADER_GROUP_TARGET_BYTES) {
      groups.push(group);
      group = [];
      size = 0;
    }
    group.push(entry);
    size += entry.bytes.byteLength;
  }
  if (group.length > 0) groups.push(group);
  const output: {
    bytes: Uint8Array;
    members: { identity: string; decodedRange: NonNullable<ArtifactDescriptor['decodedRange']> }[];
  }[] = [];
  for (const members of groups) {
    const bytes = new Uint8Array(members.reduce((sum, entry) => sum + entry.bytes.byteLength, 0));
    let offset = 0;
    const windows = members.map((entry) => {
      bytes.set(entry.bytes, offset);
      const decodedRange = { offset, length: entry.bytes.byteLength };
      offset += entry.bytes.byteLength;
      return { identity: entry.identity, decodedRange };
    });
    const compressed = await compressZstd(bytes);
    if (!compressed.ok)
      throw new Error(`shader group compression failed: ${compressed.error.code}`);
    output.push({ bytes: compressed.value, members: windows });
  }
  return output;
}
