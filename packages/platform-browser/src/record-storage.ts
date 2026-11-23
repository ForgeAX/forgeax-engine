import { createRecordStore, StorageError } from '@forgeax/engine-platform';

export function createIndexedDbTransaction(
  factory: () => IDBFactory | undefined,
  database: string,
  storeName: string,
  durability?: IDBTransactionDurability,
) {
  function open(signal: AbortSignal): Promise<IDBDatabase> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const idb = factory();
      if (!idb) {
        reject(new StorageError('unavailable'));
        return;
      }
      const request = idb.open(database, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        if (signal.aborted || blocked) request.transaction?.abort();
        else request.result.createObjectStore(storeName);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new StorageError('unavailable'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (signal.aborted || blocked) {
          db.close();
          reject(signal.reason);
        } else resolve(db);
      };
    });
  }

  return async function transact<T>(
    mode: IDBTransactionMode,
    signal: AbortSignal,
    operation: (store: IDBObjectStore, accept: (value: T) => void) => void,
  ): Promise<T | undefined> {
    const db = await open(signal);
    try {
      signal.throwIfAborted();
      return await new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(
          storeName,
          mode,
          durability === undefined ? undefined : { durability },
        );
        const abort = () => {
          try {
            tx.abort();
          } catch {
            // A committed transaction can still be waiting for its completion event.
          }
        };
        let result: T | undefined;
        signal.addEventListener('abort', abort, { once: true });
        tx.oncomplete = () => {
          signal.removeEventListener('abort', abort);
          resolve(result);
        };
        tx.onabort = () => {
          signal.removeEventListener('abort', abort);
          reject(signal.aborted ? signal.reason : tx.error);
        };
        try {
          operation(tx.objectStore(storeName), (value) => {
            result = value;
          });
        } catch (cause) {
          abort();
          reject(cause);
        }
      });
    } finally {
      db.close();
    }
  };
}

/** Reads the original JSON strings so old save slots retain their exact storage identity. */
export function createBrowserSaveRecords(factory: () => IDBFactory | undefined, projectId: string) {
  const transact = createIndexedDbTransaction(factory, 'forgeax-game-saves', 'slots', 'strict');
  return createRecordStore({
    async read(key, signal) {
      const value = await transact<unknown>('readonly', signal, (store, accept) => {
        const request = store.get([projectId, key]);
        request.onsuccess = () => accept(request.result);
      });
      if (value === undefined) return undefined;
      if (typeof value !== 'string') throw new TypeError('Invalid stored save bytes');
      return new TextEncoder().encode(value);
    },
    async replace(key, bytes, signal) {
      const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await transact('readwrite', signal, (store) => {
        store.put(value, [projectId, key]);
      });
    },
    async remove(key, signal) {
      await transact('readwrite', signal, (store) => {
        store.delete([projectId, key]);
      });
    },
  });
}

/** Binary records for consumers that own their own versioned namespace. */
export function createBrowserRecordStore(projectId: string, purpose: string) {
  const transact = createIndexedDbTransaction(
    () => globalThis.indexedDB,
    'forgeax-records-v1',
    'records',
  );
  const keyFor = (key: string) => [projectId, purpose, key];
  return createRecordStore({
    async read(key, signal) {
      const value = await transact<unknown>('readonly', signal, (store, accept) => {
        const request = store.get(keyFor(key));
        request.onsuccess = () => accept(request.result);
      });
      if (value === undefined) return undefined;
      if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer))
        throw new StorageError('io');
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    },
    async replace(key, bytes, signal) {
      await transact('readwrite', signal, (store) => {
        store.put(bytes, keyFor(key));
      });
    },
    async remove(key, signal) {
      await transact('readwrite', signal, (store) => {
        store.delete(keyFor(key));
      });
    },
  });
}
