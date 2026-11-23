import { createFileStore, requireStorage, StorageError } from '@forgeax/engine-platform';

async function namespace(projectId: string, purpose: string) {
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.getDirectory !== 'function') throw new StorageError('unavailable');
  const root = await storage.getDirectory();
  const name = encodeURIComponent(JSON.stringify([projectId, purpose]));
  return root.getDirectoryHandle(`forgeax-v1-${name}`, { create: true });
}

async function remove(directory: FileSystemDirectoryHandle, id: string): Promise<void> {
  try {
    await directory.removeEntry(id);
  } catch (cause) {
    if (!(cause instanceof DOMException) || cause.name !== 'NotFoundError') throw cause;
  }
}

/** OPFS runs in the document or Engine Worker and reads only the requested slice. */
export function createBrowserFileStore(projectId: string, purpose: string) {
  const directory = () => namespace(projectId, purpose);
  return createFileStore({
    async open(ref) {
      const file = await (await (await directory()).getFileHandle(ref.id)).getFile();
      requireStorage(file.size === ref.byteLength, 'io');
      return {
        async read(offset, target, signal) {
          const bytes = await file.slice(offset, offset + target.byteLength).arrayBuffer();
          signal.throwIfAborted();
          target.set(new Uint8Array(bytes));
          return bytes.byteLength;
        },
        async close() {},
      };
    },
    async create(_byteLength, signal) {
      const root = await directory();
      signal.throwIfAborted();
      const id = crypto.randomUUID();
      const file = await root.getFileHandle(id, { create: true });
      try {
        if (typeof file.createWritable !== 'function') throw new StorageError('unavailable');
        const stream = await file.createWritable();
        return {
          id,
          async append(_offset, bytes, current) {
            current.throwIfAborted();
            await stream.write(bytes);
          },
          async seal(current) {
            current.throwIfAborted();
            await stream.close();
          },
          async discard() {
            try {
              await stream.abort();
            } finally {
              await remove(root, id);
            }
          },
        };
      } catch (cause) {
        await remove(root, id);
        throw cause;
      }
    },
    async remove(ref, signal) {
      const root = await directory();
      signal.throwIfAborted();
      await remove(root, ref.id);
    },
  });
}
