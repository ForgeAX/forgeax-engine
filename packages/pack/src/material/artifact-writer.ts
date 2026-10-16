import { createMaterialArtifactDigest } from '../evidence/material-cook.js';

export interface MaterialArtifactWriteInput {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

export interface MaterialArtifactWriteResult {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly digest: string;
}

/** Pack owns the immutable cooked material artifact tuple. */
export function writeMaterialArtifact(
  input: MaterialArtifactWriteInput,
): MaterialArtifactWriteResult {
  return {
    key: input.key,
    bytes: input.bytes.slice(),
    mediaType: input.mediaType ?? 'application/octet-stream',
    digest: createMaterialArtifactDigest(input.bytes),
  };
}
