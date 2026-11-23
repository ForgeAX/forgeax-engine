import {
  createFileStore,
  createRecordStore,
  requireStorage,
  StorageError,
} from '@forgeax/engine-platform';
import { sha256 } from '@noble/hashes/sha2.js';

type Bytes = Uint8Array<ArrayBuffer>;
type StorageMethod =
  | 'mkdir'
  | 'open'
  | 'close'
  | 'fstat'
  | 'read'
  | 'write'
  | 'rename'
  | 'unlink'
  | 'readFile'
  | 'writeFile';

export interface WechatStorageSource {
  readonly env?: { readonly USER_DATA_PATH?: string };
  getFileSystemManager?(): object;
}

function nativeError(cause: unknown): StorageError {
  const message = (cause as { errMsg?: string } | null)?.errMsg ?? '';
  if (/no such file|not exist|not found/i.test(message)) return new StorageError('missing', cause);
  if (/quota|storage limit|no space|maximum size/i.test(message))
    return new StorageError('quota', cause);
  return new StorageError('io', cause);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function keyName(value: string): string {
  // Preserve distinct UTF-16 keys including unpaired surrogates.
  return hex(sha256(new TextEncoder().encode(JSON.stringify(value))));
}

function sandbox(source: WechatStorageSource, projectId: string, purpose: string) {
  const id = keyName(JSON.stringify([projectId, purpose]));
  function location(): string {
    const root = source.env?.USER_DATA_PATH;
    if (!root) throw new StorageError('unavailable');
    return `${root}/forgeax-storage-v1/${id}`;
  }

  async function call<T>(method: StorageMethod, options: object): Promise<T> {
    const manager = source.getFileSystemManager?.() as Record<string, unknown> | undefined;
    const native = manager?.[method];
    if (typeof native !== 'function') throw new StorageError('unavailable');
    return new Promise((resolve, reject) =>
      native.call(manager, {
        ...options,
        success: resolve,
        fail: (cause: unknown) => reject(nativeError(cause)),
      }),
    );
  }

  async function prepare() {
    try {
      await call('mkdir', { dirPath: location(), recursive: true });
    } catch (cause) {
      const message = (cause as { cause?: { errMsg?: string } }).cause?.errMsg ?? '';
      if (!/already exists|file exists/i.test(message)) throw cause;
    }
  }

  async function unlink(name: string) {
    try {
      await call('unlink', { filePath: `${location()}/${name}` });
    } catch (cause) {
      if (!(cause instanceof StorageError) || cause.code !== 'missing') throw cause;
    }
  }

  return { location, call, prepare, unlink };
}

const headerBytes = 37;

function encodeRecord(version: number, bytes: Bytes | undefined): Bytes {
  const result = new Uint8Array(headerBytes + (bytes?.byteLength ?? 0));
  new DataView(result.buffer).setUint32(32, version, true);
  result[36] = bytes === undefined ? 0 : 1;
  if (bytes !== undefined) result.set(bytes, headerBytes);
  result.set(sha256(result.subarray(32)));
  return result;
}

function decodeRecord(buffer: ArrayBuffer) {
  if (buffer.byteLength < headerBytes) return undefined;
  const bytes = new Uint8Array(buffer);
  const version = new DataView(buffer).getUint32(32, true);
  const deleted = bytes[36] === 0;
  if (
    version === 0 ||
    (deleted && bytes.byteLength !== headerBytes) ||
    (!deleted && bytes[36] !== 1)
  )
    return undefined;
  if (!sha256(bytes.subarray(32)).every((byte, index) => byte === bytes[index])) return undefined;
  return { version, bytes: deleted ? undefined : new Uint8Array(buffer, headerBytes) };
}

// A single native game realm owns records, including overlapping App generations.
const pendingRecords = new Map<string, Promise<unknown>>();

async function serializeRecord<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const before = pendingRecords.get(path) ?? Promise.resolve();
  const after = before.catch(() => {}).then(operation);
  pendingRecords.set(path, after);
  try {
    return await after;
  } finally {
    if (pendingRecords.get(path) === after) pendingRecords.delete(path);
  }
}

/** Alternate self-validating slots so an interrupted write leaves a complete previous record. */
export function createWechatRecordStore(
  source: WechatStorageSource,
  projectId: string,
  purpose: string,
) {
  const disk = sandbox(source, projectId, purpose);
  async function slot(key: string, index: number) {
    try {
      const filePath = `${disk.location()}/${key}.${index}`;
      const { data } = await disk.call<{ data: ArrayBuffer }>('readFile', { filePath });
      const value = decodeRecord(data);
      return value === undefined ? undefined : { ...value, index };
    } catch (cause) {
      if (cause instanceof StorageError && cause.code === 'missing') return undefined;
      throw cause;
    }
  }

  async function latest(key: string, signal: AbortSignal) {
    const first = await slot(key, 0);
    signal.throwIfAborted();
    const second = await slot(key, 1);
    signal.throwIfAborted();
    return (first?.version ?? 0) >= (second?.version ?? 0) ? first : second;
  }

  function replace(key: string, bytes: Bytes | undefined, signal: AbortSignal) {
    const name = keyName(key);
    const base = `${disk.location()}/${name}`;
    return serializeRecord(base, async () => {
      signal.throwIfAborted();
      const previous = await latest(name, signal);
      if (bytes === undefined && previous?.bytes === undefined) return;
      const version = (previous?.version ?? 0) + 1;
      requireStorage(version <= 0xffffffff, 'quota');
      await disk.prepare();
      signal.throwIfAborted();
      const index = previous?.index === 0 ? 1 : 0;
      await disk.call('writeFile', {
        filePath: `${base}.${index}`,
        data: encodeRecord(version, bytes).buffer,
      });
    });
  }

  return createRecordStore({
    read(key, signal) {
      const name = keyName(key);
      return serializeRecord(
        `${disk.location()}/${name}`,
        async () => (await latest(name, signal))?.bytes,
      );
    },
    replace,
    remove: (key, signal) => replace(key, undefined, signal),
  });
}

let fileSequence = 0;
function versionId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(16)}-${(++fileSequence).toString(16).padStart(8, '0')}-${Math.random().toString(16).slice(2).padStart(13, '0')}`
  );
}

/** Open native descriptors for offset reads and bounded incremental writes. */
export function createWechatFileStore(
  source: WechatStorageSource,
  projectId: string,
  purpose: string,
) {
  const disk = sandbox(source, projectId, purpose);
  return createFileStore({
    async open(ref) {
      const filePath = `${disk.location()}/${ref.id}.bin`;
      const { fd } = await disk.call<{ fd: string }>('open', { filePath, flag: 'r' });
      const close = () => disk.call<void>('close', { fd });
      try {
        const { stats } = await disk.call<{ stats: { size: number } }>('fstat', { fd });
        requireStorage(stats.size === ref.byteLength, 'io');
      } catch (cause) {
        await close();
        throw cause;
      }
      return {
        async read(offset, target, signal) {
          let copied = 0;
          while (copied < target.byteLength) {
            signal.throwIfAborted();
            const { bytesRead, arrayBuffer } = await disk.call<{
              bytesRead: number;
              arrayBuffer: ArrayBuffer;
            }>('read', {
              fd,
              arrayBuffer: target.buffer,
              offset: target.byteOffset + copied,
              length: target.byteLength - copied,
              position: offset + copied,
            });
            requireStorage(bytesRead >= 0 && bytesRead <= target.byteLength - copied, 'io');
            if (bytesRead === 0) break;
            if (arrayBuffer !== target.buffer) {
              target.set(
                new Uint8Array(arrayBuffer, target.byteOffset + copied, bytesRead),
                copied,
              );
            }
            copied += bytesRead;
          }
          return copied;
        },
        close,
      };
    },
    async create(_byteLength, signal) {
      await disk.prepare();
      signal.throwIfAborted();
      const id = versionId();
      const temporary = `${id}.tmp`;
      const filePath = `${disk.location()}/${temporary}`;
      const { fd } = await disk.call<{ fd: string }>('open', { filePath, flag: 'wx' });
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= disk.call<void>('close', { fd }));
      return {
        id,
        async append(offset, bytes, current) {
          let written = 0;
          while (written < bytes.byteLength) {
            current.throwIfAborted();
            const start = bytes.byteOffset + written;
            const data =
              start === 0 && bytes.byteLength === bytes.buffer.byteLength
                ? bytes.buffer
                : bytes.buffer.slice(start, bytes.byteOffset + bytes.byteLength);
            const result = await disk.call<{ bytesWritten: number }>('write', {
              fd,
              data,
              position: offset + written,
            });
            requireStorage(result.bytesWritten > 0 && result.bytesWritten <= data.byteLength, 'io');
            written += result.bytesWritten;
          }
        },
        async seal(current) {
          await close();
          current.throwIfAborted();
          await disk.call('rename', { oldPath: filePath, newPath: `${disk.location()}/${id}.bin` });
        },
        async discard() {
          try {
            await close();
          } finally {
            await disk.unlink(temporary);
          }
        },
      };
    },
    remove: (ref) => disk.unlink(`${ref.id}.bin`),
  });
}
