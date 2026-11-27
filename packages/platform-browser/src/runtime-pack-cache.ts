import { createRecordStore } from '@forgeax/engine-platform';
import { createIndexedDbTransaction } from './record-storage.js';

const storeName = 'packs';
const maxEntryBytes = 32 * 1024 * 1024;
const maxProjectBytes = 128 * 1024 * 1024;
const maxEntries = 128;

interface CachedPack {
  readonly bytes: Blob;
  readonly accessedAt: number;
}

function asCachedPack(value: unknown): CachedPack | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'bytes' in value &&
    value.bytes instanceof Blob &&
    'accessedAt' in value &&
    typeof value.accessedAt === 'number' &&
    Number.isFinite(value.accessedAt)
  ) {
    return { bytes: value.bytes, accessedAt: value.accessedAt };
  }
  return undefined;
}

/** An opaque byte store that can run in the document or in the Engine Worker. */
export function createBrowserRuntimePackRecords(projectId: string) {
  const name = `forgeax.runtime-pack-cache.v1:${projectId}`;

  const transact = createIndexedDbTransaction(() => globalThis.indexedDB, name, storeName);

  async function read(
    key: string,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer> | undefined> {
    const entry = await transact<CachedPack>('readonly', signal, (store, result) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = asCachedPack(request.result);
        if (entry && entry.bytes.size <= maxEntryBytes) result(entry);
      };
    });
    if (!entry) return;
    signal.throwIfAborted();
    const bytes = new Uint8Array(await entry.bytes.arrayBuffer());
    signal.throwIfAborted();
    void transact('readwrite', signal, (store) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const current = asCachedPack(request.result);
        if (current) store.put({ ...current, accessedAt: Date.now() }, key);
      };
    }).catch(() => {});
    return bytes;
  }

  async function write(
    key: string,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (bytes.byteLength > maxEntryBytes) return;
    const entry: CachedPack = { bytes: new Blob([bytes]), accessedAt: Date.now() };
    await transact('readwrite', signal, (store) => {
      const entries: { key: IDBValidKey; size: number; accessedAt: number }[] = [];
      let total = entry.bytes.size;
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          if (cursor.key !== key) {
            const previous = asCachedPack(cursor.value);
            if (previous) {
              total += previous.bytes.size;
              entries.push({
                key: cursor.key,
                size: previous.bytes.size,
                accessedAt: previous.accessedAt,
              });
            } else cursor.delete();
          }
          cursor.continue();
          return;
        }
        entries.sort((left, right) => left.accessedAt - right.accessedAt);
        let retained = entries.length + 1;
        for (const oldest of entries) {
          if (total <= maxProjectBytes && retained <= maxEntries) break;
          store.delete(oldest.key);
          total -= oldest.size;
          retained--;
        }
        store.put(entry, key);
      };
    });
  }

  return createRecordStore({
    read,
    replace: write,
    async remove(key, signal) {
      await transact('readwrite', signal, (store) => {
        store.delete(key);
      });
    },
  });
}

export function createBrowserRuntimePackCache(projectId: string) {
  const records = createBrowserRuntimePackRecords(projectId);
  return {
    async read(key: string, signal: AbortSignal) {
      return (await records.read(key, signal)).unwrap();
    },
    async write(key: string, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
      (await records.replace(key, bytes, signal)).unwrap();
    },
  };
}
