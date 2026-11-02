/**
 * Build-only opaque byte store by string key (a host's derived data cache). The store
 * only keeps bytes: producers own their keys and verify every entry they read, so a
 * missing or unreadable entry is a miss and a failed write only costs recomputation.
 */
export interface ByteCache {
  get(key: string): Uint8Array | undefined;
  put(key: string, bytes: Uint8Array): void;
}
