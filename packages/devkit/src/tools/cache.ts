import type { JsonValue } from '@forgeax/engine-tool-runtime';

export interface ServiceCacheEntry {
  readonly artifactDigest: string;
  readonly value?: JsonValue;
}

export interface ServiceCache {
  readonly get: (key: string) => ServiceCacheEntry | undefined;
  readonly set: (key: string, entry: ServiceCacheEntry) => void;
  readonly evict: (key: string) => boolean;
  readonly clear: () => void;
  readonly size: () => number;
}

export function createServiceCache(): ServiceCache {
  const entries = new Map<string, ServiceCacheEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, entry) => entries.set(key, entry),
    evict: (key) => entries.delete(key),
    clear: () => entries.clear(),
    size: () => entries.size,
  };
}
