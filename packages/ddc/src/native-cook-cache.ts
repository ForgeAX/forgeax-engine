import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ByteCache } from '@forgeax/engine-types';

/** Default bound of `<buildCacheRoot>/native-cook`: a few full-scene sets of baked maps. */
export const NATIVE_COOK_CACHE_MAX_BYTES = 4 * 1024 ** 3;

export interface NativeCookCacheOptions {
  /** Least recently used entries beyond this many bytes are swept after each write. */
  readonly maxBytes?: number;
}

export interface NativeCookGcResult {
  readonly deleted: readonly string[];
  readonly retainedBytes: number;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const rootOf = (buildCacheRoot: string) => join(buildCacheRoot, 'native-cook');

function children(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Sweep `<buildCacheRoot>/native-cook` (every namespace) down to `maxBytes`, removing the
 * least recently used entries first. A read refreshes an entry's time, so entries the
 * current build still serves survive; `keep` (a just-written entry) is never removed.
 */
export function collectNativeCookGarbage(
  buildCacheRoot: string,
  options: { readonly maxBytes: number; readonly keep?: string },
): NativeCookGcResult {
  const entries: { path: string; size: number; time: number }[] = [];
  const root = rootOf(buildCacheRoot);
  for (const namespace of children(root))
    for (const shard of children(join(root, namespace)))
      for (const name of children(join(root, namespace, shard))) {
        const path = join(root, namespace, shard, name);
        try {
          const stat = statSync(path);
          if (stat.isFile()) entries.push({ path, size: stat.size, time: stat.mtimeMs });
        } catch {}
      }
  entries.sort((a, b) => b.time - a.time || (a.path < b.path ? -1 : 1));
  const deleted: string[] = [];
  let retainedBytes = 0;
  for (const entry of entries) {
    if (entry.path === options.keep || retainedBytes + entry.size <= options.maxBytes) {
      retainedBytes += entry.size;
      continue;
    }
    try {
      rmSync(entry.path, { force: true });
      deleted.push(entry.path);
    } catch {
      retainedBytes += entry.size;
    }
  }
  return { deleted, retainedBytes };
}

/**
 * Synchronous build-only store under `<buildCacheRoot>/native-cook/<namespace>`. Keys are
 * opaque to DDC: callers verify their own entries, so an unreadable file is a miss and a
 * failed write only costs a later recomputation. Each write sweeps the root to `maxBytes`.
 */
export function createNativeCookCache(
  buildCacheRoot: string,
  namespace: string,
  options: NativeCookCacheOptions = {},
): ByteCache {
  if (namespace.length === 0) throw new TypeError('native cook cache namespace is empty');
  const maxBytes = options.maxBytes ?? NATIVE_COOK_CACHE_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0)
    throw new RangeError('native cook cache maxBytes is a non-negative finite byte count');
  const directory = join(rootOf(buildCacheRoot), sha256(namespace));
  const file = (key: string) => {
    const hash = sha256(key);
    return {
      shard: join(directory, hash.slice(0, 2)),
      path: join(directory, hash.slice(0, 2), hash),
    };
  };
  return {
    get(key) {
      const { path } = file(key);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(path));
      } catch {
        return undefined;
      }
      try {
        const now = new Date();
        utimesSync(path, now, now);
      } catch {}
      return bytes;
    },
    put(key, bytes) {
      const { shard, path } = file(key);
      const staged = `${path}.${randomUUID()}.tmp`;
      try {
        mkdirSync(shard, { recursive: true });
        writeFileSync(staged, bytes);
        renameSync(staged, path);
      } catch {
        try {
          rmSync(staged, { force: true });
        } catch {}
        return;
      }
      collectNativeCookGarbage(buildCacheRoot, { maxBytes, keep: path });
    },
  };
}
