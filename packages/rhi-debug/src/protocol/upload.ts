export const RAW_TAPE_ROUTE = '/__forgeax-debug/tape' as const;
export const RHITAPE_MIME = 'application/x-forgeax-rhitape' as const;
export const CHUNK_DIGEST_HEADER = 'x-forgeax-chunk-digest' as const;

export interface RawTapeArtifactRef {
  readonly kind: 'rhi-tape';
  readonly digest: string;
  readonly path: string;
  readonly bytes: number;
}

export interface TapeChunk {
  readonly offset: number;
  readonly length: number;
  readonly digest: string;
}
