import { sha256 } from '@noble/hashes/sha2.js';

type Completion<T = unknown> = {
  readonly success: (value: T) => void;
  readonly fail: (cause: unknown) => void;
};

export interface WechatDownloadFiles {
  mkdir(options: { readonly dirPath: string; readonly recursive: true } & Completion): void;
  readdir(options: { readonly dirPath: string } & Completion<{ readonly files: string[] }>): void;
  readFile(
    options: { readonly filePath: string } & Completion<{ readonly data: ArrayBuffer }>,
  ): void;
  unlink(options: { readonly filePath: string } & Completion): void;
}

export interface WechatCacheFiles extends WechatDownloadFiles {
  stat(
    options: { readonly path: string } & Completion<{
      readonly stats: { readonly size: number; readonly lastModifiedTime: number };
    }>,
  ): void;
  writeFile(options: { readonly filePath: string; readonly data: ArrayBuffer } & Completion): void;
  rename(options: { readonly oldPath: string; readonly newPath: string } & Completion): void;
}

export interface WechatDownloadCacheOptions {
  /** Digest of the immutable publication supplied by its producer. */
  readonly publicationDigest: string;
  readonly maxBytes: number;
}

export function nativeFile<T>(operation: (completion: Completion<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => operation({ success: resolve, fail: reject }));
}

export function cacheHash(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** One disposable byte projection. Catalog and loaded resources retain their own lifetimes. */
export function createWechatDownloadCache(
  files: WechatCacheFiles,
  directory: string,
  options: WechatDownloadCacheOptions,
  onError: (cause: unknown) => void,
) {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 33 ||
    !options.publicationDigest.trim()
  )
    throw new TypeError('cache requires a publication digest and a positive byte budget');
  const entries = new Map<string, { size: number; touched: number }>();
  let initialized = false;
  let queue = Promise.resolve();
  const path = (name: string) => `${directory}/${name}`;
  const owned = /^[0-9a-f]{64}\.bin$/;
  const partial = /^[0-9a-f]{64}\.part$/;
  const remove = async (name: string) => {
    await nativeFile((done) => files.unlink({ filePath: path(name), ...done }));
    entries.delete(name);
  };
  const total = () => [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
  const trim = async (reserved: number, signal: AbortSignal) => {
    for (const [name] of [...entries].sort(
      (a, b) => a[1].touched - b[1].touched || a[0].localeCompare(b[0]),
    )) {
      signal.throwIfAborted();
      if (total() + reserved <= options.maxBytes) break;
      await remove(name);
    }
  };
  const initialize = async (signal: AbortSignal) => {
    if (initialized) return;
    signal.throwIfAborted();
    const listing = await nativeFile<{ files: string[] }>((done) =>
      files.readdir({ dirPath: directory, ...done }),
    );
    signal.throwIfAborted();
    entries.clear();
    for (const name of listing.files) {
      signal.throwIfAborted();
      if (partial.test(name)) await remove(name);
      else if (owned.test(name)) {
        const { stats } = await nativeFile<{ stats: { size: number; lastModifiedTime: number } }>(
          (done) => files.stat({ path: path(name), ...done }),
        );
        signal.throwIfAborted();
        if (
          !Number.isSafeInteger(stats.size) ||
          stats.size < 32 ||
          !Number.isFinite(stats.lastModifiedTime)
        )
          await remove(name);
        else entries.set(name, { size: stats.size, touched: stats.lastModifiedTime });
      }
    }
    await trim(0, signal);
    signal.throwIfAborted();
    initialized = true;
  };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  return {
    key(url: string): string {
      return cacheHash(new TextEncoder().encode(`${options.publicationDigest}\n${url}`));
    },
    read(key: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
      return serial(async () => {
        signal.throwIfAborted();
        await initialize(signal);
        signal.throwIfAborted();
        const name = `${key}.bin`;
        const entry = entries.get(name);
        if (!entry) return undefined;
        try {
          const { data } = await nativeFile<{ data: ArrayBuffer }>((done) =>
            files.readFile({ filePath: path(name), ...done }),
          );
          signal.throwIfAborted();
          if (
            !(data instanceof ArrayBuffer) ||
            data.byteLength !== entry.size ||
            data.byteLength < 32
          )
            throw new Error('cached download is incomplete');
          const stored = new Uint8Array(data);
          const body = stored.subarray(32);
          const digest = sha256(body);
          if (!digest.every((byte, index) => byte === stored[index]))
            throw new Error('cached download checksum mismatch');
          entry.touched = Date.now();
          return body.slice();
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          onError(cause);
          await remove(name);
          return undefined;
        }
      });
    },
    write(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
      return serial(async () => {
        signal.throwIfAborted();
        if (bytes.byteLength + 32 > options.maxBytes) return;
        await initialize(signal);
        signal.throwIfAborted();
        const name = `${key}.bin`;
        const staging = `${key}.part`;
        if (entries.has(name)) await remove(name);
        signal.throwIfAborted();
        await trim(bytes.byteLength + 32, signal);
        signal.throwIfAborted();
        const stored = new Uint8Array(bytes.byteLength + 32);
        stored.set(sha256(bytes));
        stored.set(bytes, 32);
        try {
          await nativeFile((done) =>
            files.writeFile({ filePath: path(staging), data: stored.buffer, ...done }),
          );
          signal.throwIfAborted();
          await nativeFile((done) =>
            files.rename({ oldPath: path(staging), newPath: path(name), ...done }),
          );
          entries.set(name, { size: stored.byteLength, touched: Date.now() });
          // A cancellation after native rename cannot adopt bytes into the retired caller.
          signal.throwIfAborted();
        } catch (cause) {
          try {
            const listing = await nativeFile<{ files: string[] }>((done) =>
              files.readdir({ dirPath: directory, ...done }),
            );
            if (listing.files.includes(staging)) await remove(staging);
          } catch (cleanup) {
            throw new AggregateError([cause, cleanup], 'download cache write and cleanup failed');
          }
          throw cause;
        }
      });
    },
  };
}
