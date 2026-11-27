import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimePackCacheStore } from '@forgeax/engine-import';
import { createDesktopRecordStore, missingAsUndefined } from './desktop-storage.js';

const maxEntryBytes = 32 * 1024 * 1024;
const maxProjectBytes = 128 * 1024 * 1024;
const maxEntries = 128;
const entryName = /^[0-9a-f]{64}\.bin$/;
const temporaryName = /^[0-9a-f]{64}\.bin\.[0-9a-f-]{36}\.tmp$/;
const temporaryLifetimeMs = 24 * 60 * 60 * 1000;

function fileName(key: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(key)) throw new TypeError('Invalid Runtime Pack cache key');
  return `${key.slice(7)}.bin`;
}

async function prune(root: string, retained: string, signal: AbortSignal): Promise<void> {
  const candidates: { path: string; bytes: number; accessedAt: number }[] = [];
  let total = 0;
  let count = 0;
  const staleBefore = Date.now() - temporaryLifetimeMs;
  for (const name of await readdir(root)) {
    signal.throwIfAborted();
    const committed = entryName.test(name);
    if (!committed && !temporaryName.test(name)) continue;
    const path = join(root, name);
    const info = await missingAsUndefined(lstat(path));
    if (!info?.isFile()) continue;
    if (!committed) {
      if (info.mtimeMs < staleBefore) await rm(path, { force: true });
      continue;
    }
    total += info.size;
    count++;
    if (name !== retained) candidates.push({ path, bytes: info.size, accessedAt: info.mtimeMs });
  }
  candidates.sort((left, right) => left.accessedAt - right.accessedAt);
  for (const candidate of candidates) {
    if (total <= maxProjectBytes && count <= maxEntries) break;
    signal.throwIfAborted();
    await rm(candidate.path, { force: true });
    total -= candidate.bytes;
    count--;
  }
}

/** Node storage for derived Pack records, scoped to the player's writable project cache. */
export function createDesktopRuntimePackCache(root: string): RuntimePackCacheStore {
  const records = createDesktopRecordStore(root, {
    fileName: (name) => name,
    maxBytes: maxEntryBytes,
    touch: true,
  });
  return {
    async read(key, signal) {
      signal.throwIfAborted();
      return (await records.read(fileName(key), signal)).unwrap();
    },
    async write(key, bytes, signal) {
      signal.throwIfAborted();
      const name = fileName(key);
      if (bytes.byteLength > maxEntryBytes) return;
      (await records.replace(name, bytes, signal)).unwrap();
      await prune(root, name, signal);
    },
  };
}
