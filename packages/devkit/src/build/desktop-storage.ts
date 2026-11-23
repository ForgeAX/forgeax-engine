import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileStore, createRecordStore, requireStorage } from '@forgeax/engine-platform';
import { writeFileAtomic } from '../filesystem-path.js';

export async function missingAsUndefined<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw cause;
  }
}

async function readBytes(
  file: FileHandle,
  target: Uint8Array<ArrayBuffer>,
  position: number,
  signal: AbortSignal,
): Promise<number> {
  let copied = 0;
  while (copied < target.byteLength) {
    signal.throwIfAborted();
    const result = await file.read(target, copied, target.byteLength - copied, position + copied);
    if (result.bytesRead === 0) break;
    copied += result.bytesRead;
  }
  return copied;
}

export function createDesktopRecordStore(
  root: string,
  options: {
    fileName?: (key: string) => string;
    durable?: boolean;
    maxBytes?: number;
    touch?: boolean;
  } = {},
) {
  function location(key: string): string {
    const name =
      options.fileName?.(key) ?? `${createHash('sha256').update(key, 'utf16le').digest('hex')}.bin`;
    requireStorage(/^[a-z0-9_-]+\.[a-z0-9]+$/i.test(name));
    return join(root, name);
  }

  return createRecordStore({
    async read(key, signal) {
      const file = await missingAsUndefined(open(location(key), 'r'));
      if (!file) return undefined;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > (options.maxBytes ?? Number.MAX_SAFE_INTEGER))
          return undefined;
        const bytes = new Uint8Array(info.size);
        requireStorage((await readBytes(file, bytes, 0, signal)) === info.size, 'io');
        if (options.touch) {
          const now = new Date();
          await file.utimes(now, now).catch(() => {});
        }
        return bytes;
      } finally {
        await file.close();
      }
    },
    async replace(key, bytes, signal) {
      requireStorage(bytes.byteLength <= (options.maxBytes ?? Number.MAX_SAFE_INTEGER), 'quota');
      const path = location(key);
      await mkdir(root, { recursive: true });
      await writeFileAtomic(path, bytes, { signal, syncFile: options.durable ?? false });
    },
    async remove(key) {
      await rm(location(key), { force: true });
    },
  });
}

export function createDesktopFileStore(root: string) {
  return createFileStore({
    async open(ref) {
      const file = await open(join(root, `${ref.id}.bin`), 'r');
      try {
        const info = await file.stat();
        requireStorage(info.isFile() && info.size === ref.byteLength, 'io');
      } catch (cause) {
        await file.close();
        throw cause;
      }
      return {
        read: (offset, target, signal) => readBytes(file, target, offset, signal),
        close: () => file.close(),
      };
    },
    async create(_byteLength, signal) {
      await mkdir(root, { recursive: true });
      signal.throwIfAborted();
      const id = randomUUID();
      const temporary = join(root, `${id}.tmp`);
      const file = await open(temporary, 'wx');
      return {
        id,
        async append(offset, bytes, current) {
          let written = 0;
          while (written < bytes.byteLength) {
            current.throwIfAborted();
            const result = await file.write(
              bytes,
              written,
              bytes.byteLength - written,
              offset + written,
            );
            requireStorage(result.bytesWritten > 0, 'io');
            written += result.bytesWritten;
          }
        },
        async seal(current) {
          await file.close();
          current.throwIfAborted();
          await rename(temporary, join(root, `${id}.bin`));
        },
        async discard() {
          try {
            await file.close();
          } finally {
            await rm(temporary, { force: true });
          }
        },
      };
    },
    async remove(ref) {
      await rm(join(root, `${ref.id}.bin`), { force: true });
    },
  });
}
