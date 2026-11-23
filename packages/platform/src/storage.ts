import { err, ok, type Result } from '@forgeax/engine-types';

export type StorageErrorCode =
  | 'invalid-input'
  | 'missing'
  | 'unavailable'
  | 'quota'
  | 'cancelled'
  | 'closed'
  | 'io'
  | 'commit-unknown';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    cause?: unknown,
  ) {
    super(`Storage: ${code}`, { cause });
    this.name = 'StorageError';
  }
}

type Bytes = Uint8Array<ArrayBuffer>;
export type StorageResult<T> = Promise<Result<T, StorageError>>;

export interface RecordStore {
  read(key: string, signal: AbortSignal): StorageResult<Bytes | undefined>;
  replace(key: string, bytes: Bytes, signal: AbortSignal): StorageResult<void>;
  remove(key: string, signal: AbortSignal): StorageResult<void>;
}

export interface FileRef {
  readonly id: string;
  readonly byteLength: number;
}

export interface FileRead {
  readAt(offset: number, target: Bytes, signal: AbortSignal): StorageResult<number>;
  close(): StorageResult<void>;
}

export interface FileWrite {
  append(bytes: Bytes, signal: AbortSignal): StorageResult<void>;
  commit(signal: AbortSignal): StorageResult<FileRef>;
  abort(): StorageResult<void>;
}

export interface FileStore {
  openRead(ref: FileRef, signal: AbortSignal): StorageResult<FileRead>;
  beginWrite(byteLength: number, signal: AbortSignal): StorageResult<FileWrite>;
  remove(ref: FileRef, signal: AbortSignal): StorageResult<void>;
}

/** Native reads retain one handle until close. A writer has private storage until seal. */
export interface FileStorageBackend {
  open(
    ref: FileRef,
    signal: AbortSignal,
  ): Promise<{
    read(offset: number, target: Bytes, signal: AbortSignal): Promise<number>;
    close(): Promise<void>;
  }>;
  create(
    byteLength: number,
    signal: AbortSignal,
  ): Promise<{
    readonly id: string;
    append(offset: number, bytes: Bytes, signal: AbortSignal): Promise<void>;
    seal(signal: AbortSignal): Promise<void>;
    discard(): Promise<void>;
  }>;
  remove(ref: FileRef, signal: AbortSignal): Promise<void>;
}

export interface RecordStorageBackend {
  read(key: string, signal: AbortSignal): Promise<Bytes | undefined>;
  replace(key: string, bytes: Bytes, signal: AbortSignal): Promise<void>;
  remove(key: string, signal: AbortSignal): Promise<void>;
}

export function requireStorage(condition: boolean, code: StorageErrorCode = 'invalid-input'): void {
  if (!condition) throw new StorageError(code);
}

function storageOffset(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function storageKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= 256;
}

function storageFileId(id: string): boolean {
  return typeof id === 'string' && /^[0-9a-f-]{24,80}$/.test(id);
}

function failure(cause: unknown, signal?: AbortSignal): StorageError {
  if (cause instanceof StorageError) return cause;
  if (signal?.aborted) return new StorageError('cancelled', cause);
  const name = (cause as { name?: unknown } | null)?.name;
  const code = (cause as { code?: unknown } | null)?.code;
  if (name === 'AbortError') return new StorageError('cancelled', cause);
  if (name === 'QuotaExceededError' || code === 'ENOSPC' || code === 'EDQUOT')
    return new StorageError('quota', cause);
  if (name === 'NotFoundError' || code === 'ENOENT') return new StorageError('missing', cause);
  if (name === 'SecurityError' || name === 'NotAllowedError' || code === 'EACCES')
    return new StorageError('unavailable', cause);
  return new StorageError('io', cause);
}

async function run<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): StorageResult<T> {
  try {
    signal?.throwIfAborted();
    return ok(await operation());
  } catch (cause) {
    return err(failure(cause, signal));
  }
}

export function createRecordStore(backend: RecordStorageBackend): RecordStore {
  return {
    read: (key, signal) =>
      run(signal, async () => {
        requireStorage(storageKey(key));
        const value = await backend.read(key, signal);
        signal.throwIfAborted();
        return value;
      }),
    replace: (key, bytes, signal) =>
      run(signal, () => {
        requireStorage(storageKey(key));
        return backend.replace(key, bytes, signal);
      }),
    remove: (key, signal) =>
      run(signal, () => {
        requireStorage(storageKey(key));
        return backend.remove(key, signal);
      }),
  };
}

function checkRef(ref: FileRef): void {
  requireStorage(storageFileId(ref.id) && storageOffset(ref.byteLength));
}

function reader(
  native: Awaited<ReturnType<FileStorageBackend['open']>>,
  byteLength: number,
  released: () => void,
): FileRead {
  let pending: Promise<unknown> = Promise.resolve();
  let retirement: StorageResult<void> | undefined;
  return {
    readAt(offset, target, signal) {
      if (retirement) return Promise.resolve(err(new StorageError('closed')));
      const read = pending.then(() =>
        run(signal, async () => {
          requireStorage(storageOffset(offset));
          const wanted = Math.min(target.byteLength, Math.max(0, byteLength - offset));
          const count =
            wanted === 0 ? 0 : await native.read(offset, target.subarray(0, wanted), signal);
          requireStorage(count === wanted, 'io');
          signal.throwIfAborted();
          return count;
        }),
      );
      pending = read;
      return read;
    },
    close() {
      retirement ??= pending.then(() =>
        run(undefined, async () => {
          try {
            await native.close();
          } finally {
            released();
          }
        }),
      );
      return retirement;
    },
  };
}

function writer(
  native: Awaited<ReturnType<FileStorageBackend['create']>>,
  byteLength: number,
): FileWrite {
  let offset = 0;
  let active = false;
  let closed = false;
  let pending: Promise<unknown> = Promise.resolve();
  let discarded: StorageResult<void> | undefined;
  const discard = () => (discarded ??= run(undefined, () => native.discard()));
  function start<T>(signal: AbortSignal, operation: () => Promise<T>): StorageResult<T> {
    if (closed) return Promise.resolve(err(new StorageError('closed')));
    if (active) return Promise.resolve(err(new StorageError('invalid-input')));
    active = true;
    const result = run(signal, operation).finally(() => {
      active = false;
    });
    pending = result;
    return result;
  }
  return {
    append(bytes, signal) {
      return start(signal, async () => {
        requireStorage(bytes.byteLength <= byteLength - offset);
        try {
          await native.append(offset, bytes, signal);
          signal.throwIfAborted();
        } catch (cause) {
          closed = true;
          await discard();
          throw cause;
        }
        offset += bytes.byteLength;
      });
    },
    commit(signal) {
      return start(signal, async () => {
        requireStorage(offset === byteLength);
        closed = true;
        try {
          await native.seal(signal);
        } catch (cause) {
          if (!(cause instanceof StorageError) || cause.code !== 'commit-unknown') {
            await discard();
          }
          throw cause;
        }
        return { id: native.id, byteLength };
      });
    },
    abort() {
      if (closed) return pending.then(() => discarded ?? ok(undefined));
      closed = true;
      const abort = pending.then(discard);
      pending = abort;
      return abort;
    },
  };
}

export function createFileStore(backend: FileStorageBackend): FileStore {
  const readers = new Map<string, number>();
  const deleting = new Set<string>();
  function release(id: string): void {
    const remaining = (readers.get(id) ?? 1) - 1;
    if (remaining > 0) readers.set(id, remaining);
    else readers.delete(id);
  }
  return {
    openRead(ref, signal) {
      return run(signal, async () => {
        checkRef(ref);
        requireStorage(!deleting.has(ref.id), 'io');
        readers.set(ref.id, (readers.get(ref.id) ?? 0) + 1);
        try {
          const native = await backend.open(ref, signal);
          if (signal.aborted) {
            await native.close();
            signal.throwIfAborted();
          }
          return reader(native, ref.byteLength, () => release(ref.id));
        } catch (cause) {
          release(ref.id);
          throw cause;
        }
      });
    },
    beginWrite(byteLength, signal) {
      return run(signal, async () => {
        requireStorage(storageOffset(byteLength));
        const native = await backend.create(byteLength, signal);
        if (signal.aborted) {
          await native.discard();
          signal.throwIfAborted();
        }
        return writer(native, byteLength);
      });
    },
    remove(ref, signal) {
      return run(signal, async () => {
        checkRef(ref);
        requireStorage(!readers.has(ref.id) && !deleting.has(ref.id), 'io');
        deleting.add(ref.id);
        try {
          await backend.remove(ref, signal);
        } finally {
          deleting.delete(ref.id);
        }
      });
    },
  };
}
