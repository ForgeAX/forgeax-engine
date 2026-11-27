import { createPackageResponse } from '@forgeax/engine-pack/runtime';
import { platformError } from '@forgeax/engine-platform';
import { err, ok, type PackageFetcher, type PackageResponse } from '@forgeax/engine-types';
import URL from 'core-js-pure/actual/url/index.js';
import {
  cacheHash,
  createWechatDownloadCache,
  nativeFile,
  type WechatCacheFiles,
  type WechatDownloadCacheOptions,
  type WechatDownloadFiles,
} from './download-cache.js';

interface BrotliDownload {
  readonly packedBytes: number;
  readonly decodedBytes: number;
}

interface WechatRemoteFiles extends WechatDownloadFiles {
  stat?: WechatCacheFiles['stat'];
  readCompressedFile?: ReturnType<
    import('./package-fetch.js').WechatPackageSource['getFileSystemManager']
  >['readCompressedFile'];
}

export interface WechatDownloadSource {
  readonly env: { readonly USER_DATA_PATH: string };
  getFileSystemManager(): WechatRemoteFiles;
  downloadFile(options: {
    readonly url: string;
    readonly filePath: string;
    readonly timeout: number;
    readonly success: (result: { readonly filePath: string; readonly statusCode: number }) => void;
    readonly fail: (cause: unknown) => void;
  }): { abort(): void };
}

export interface WechatRemotePackageOptions {
  readonly baseUrl: string;
  /** Dedicated Host-owned child of wx.env.USER_DATA_PATH for staging and cache files. */
  readonly directory: string;
  readonly timeoutMs?: number;
  readonly cache?: WechatDownloadCacheOptions;
  /** Published sizes for logical files hosted with a .br suffix. Other files use their original URL. */
  readonly brotli?: (relativePath: string) => BrotliDownload | undefined;
  /** Report recoverable filesystem failures and native cleanup that arrives after cancellation. */
  readonly onError: (cause: unknown) => void;
}

const directoryOwners = new WeakMap<WechatDownloadFiles, Set<string>>();

function resolvePublishedDownload(
  base: URL,
  url: string,
  publishedBrotli: WechatRemotePackageOptions['brotli'],
) {
  const resolved = new URL(url, base);
  const relative = decodeURIComponent(resolved.pathname.slice(base.pathname.length));
  if (
    resolved.origin !== base.origin ||
    !resolved.pathname.startsWith(base.pathname) ||
    resolved.username ||
    resolved.password ||
    resolved.search ||
    resolved.hash ||
    !relative ||
    /[\\\0]/.test(relative) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new TypeError(`remote package URL is outside its published namespace: ${url}`);
  const brotli = publishedBrotli?.(relative);
  if (brotli) {
    if (
      !Number.isSafeInteger(brotli.packedBytes) ||
      brotli.packedBytes <= 0 ||
      !Number.isSafeInteger(brotli.decodedBytes) ||
      brotli.decodedBytes < 0
    )
      throw new TypeError('invalid published Brotli sizes');
    resolved.pathname += '.br';
  }
  return { url: resolved.href, brotli };
}

type PublishedDownload = ReturnType<typeof resolvePublishedDownload>;
type BinaryRead = { readonly data: ArrayBuffer };

class NativeDownloadReadError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown,
  ) {
    super(operation, { cause });
  }
}

function readNativeFile<T>(operation: string, start: Parameters<typeof nativeFile<T>>[0]) {
  return nativeFile<T>(start).catch((cause) => {
    throw new NativeDownloadReadError(operation, cause);
  });
}

async function readDownload(
  files: WechatRemoteFiles,
  filePath: string,
  signal: AbortSignal,
  brotli: BrotliDownload | undefined,
): Promise<Uint8Array> {
  const read = () =>
    readNativeFile<BinaryRead>('FileSystemManager.readFile', (done) =>
      files.readFile({ filePath, ...done }),
    );
  const { data } = brotli
    ? await readBrotliDownload(files, filePath, signal, brotli, read)
    : await read();
  signal.throwIfAborted();
  if (!(data instanceof ArrayBuffer)) throw new TypeError('expected binary file bytes');
  if (brotli && data.byteLength !== brotli.decodedBytes)
    throw new Error('decoded Brotli download size does not match the publication');
  return new Uint8Array(data);
}

async function readBrotliDownload(
  files: WechatRemoteFiles,
  filePath: string,
  signal: AbortSignal,
  brotli: BrotliDownload,
  read: () => Promise<BinaryRead>,
): Promise<BinaryRead> {
  const { stat, readCompressedFile } = files;
  if (typeof stat !== 'function') throw new Error('native Brotli downloads require stat');
  const { stats } = await readNativeFile<{ readonly stats: { readonly size: number } }>(
    'FileSystemManager.stat',
    (done) => stat.call(files, { path: filePath, ...done }),
  );
  signal.throwIfAborted();
  // wx.downloadFile can write decoded HTTP bodies. A distinct decoded size needs no decompressor.
  if (stats.size !== brotli.packedBytes) {
    if (stats.size === brotli.decodedBytes) return read();
    throw new Error('download size does not match the published Brotli or decoded size');
  }
  if (typeof readCompressedFile !== 'function')
    throw new Error('native packed Brotli downloads require readCompressedFile');
  try {
    return await readNativeFile<BinaryRead>('FileSystemManager.readCompressedFile', (done) =>
      readCompressedFile.call(files, { filePath, compressionAlgorithm: 'br', ...done }),
    );
  } catch (cause) {
    signal.throwIfAborted();
    // The sizes can coincide. Only then may a failed decompression be a decoded body.
    if (stats.size !== brotli.decodedBytes) throw cause;
    return read().catch((rawCause) => {
      throw new NativeDownloadReadError(
        'read equal-size Brotli download',
        new AggregateError([cause, rawCause]),
      );
    });
  }
}

/** Read one remote publication namespace through the existing Catalog/Pack contract. */
export function createWechatRemotePackageFetcher(
  source: WechatDownloadSource,
  options: WechatRemotePackageOptions,
): {
  readonly fetch: PackageFetcher;
  dispose(): Promise<void>;
} {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith('/')
  )
    throw new TypeError(
      'remote package base must be an HTTPS directory without credentials, query or fragment',
    );
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new TypeError('download timeout must be a positive integer');
  const files = source.getFileSystemManager();
  for (const operation of ['mkdir', 'readdir', 'readFile', 'unlink'] as const) {
    if (typeof files[operation] !== 'function')
      throw platformError('platform-unavailable', { operation: `FileSystemManager.${operation}` })
        .error;
  }
  if (typeof source.downloadFile !== 'function')
    throw platformError('platform-unavailable', { operation: 'wx.downloadFile' }).error;
  const root = `${source.env.USER_DATA_PATH.replace(/\/$/, '')}/`;
  const directory = options.directory.replace(/\/$/, '');
  if (
    !directory.startsWith(root) ||
    !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(directory.slice(root.length))
  )
    throw new TypeError('download directory must be a dedicated child of wx.env.USER_DATA_PATH');
  if (options.cache) {
    for (const operation of ['stat', 'writeFile', 'rename'] as const) {
      if (typeof (files as WechatCacheFiles)[operation] !== 'function')
        throw platformError('platform-unavailable', { operation: `FileSystemManager.${operation}` })
          .error;
    }
  }
  const directories = directoryOwners.get(files) ?? new Set<string>();
  if (directories.has(directory))
    throw new Error('download directory already has a live Host owner');
  const cache =
    options.cache &&
    createWechatDownloadCache(files as WechatCacheFiles, directory, options.cache, options.onError);
  directories.add(directory);
  directoryOwners.set(files, directories);
  const pending = new Map<AbortController, Promise<PackageResponse>>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let preparation: Promise<void> | undefined;
  let nextDownload = 0;
  const nativeFailure = (operation: string, cause: unknown) =>
    platformError('platform-operation-failed', { operation, cause }).error;
  async function discard(path: string): Promise<void> {
    const { files: names } = await nativeFile<{ files: string[] }>((done) =>
      files.readdir({ dirPath: directory, ...done }),
    );
    if (names.includes(path.slice(directory.length + 1)))
      await nativeFile((done) => files.unlink({ filePath: path, ...done }));
  }
  function prepareDirectory(): Promise<void> {
    if (preparation) return preparation;
    preparation = (async () => {
      const list = () =>
        nativeFile<{ files: string[] }>((done) => files.readdir({ dirPath: directory, ...done }));
      const { files: names } = await list().catch(async (readCause) => {
        try {
          await nativeFile((done) => files.mkdir({ dirPath: directory, recursive: true, ...done }));
          return await list();
        } catch (cause) {
          throw new AggregateError([readCause, cause], 'cannot open or create download directory');
        }
      });
      for (const name of names) {
        if (/^[0-9a-f]{64}-[0-9]+\.download$/.test(name))
          await nativeFile((done) => files.unlink({ filePath: `${directory}/${name}`, ...done }));
      }
    })().catch((cause) => {
      preparation = undefined;
      throw nativeFailure('prepare download directory', cause);
    });
    return preparation;
  }
  async function download(
    publication: PublishedDownload,
    signal: AbortSignal,
    persist: boolean,
    refresh = true,
  ): Promise<PackageResponse> {
    signal.throwIfAborted();
    const { url, brotli } = publication;
    const filePath = `${directory}/${cacheHash(new TextEncoder().encode(url))}-${++nextDownload}.download`;
    let aborted = false;
    let task: { abort(): void } | undefined;
    const downloaded = await new Promise<{ filePath: string; statusCode: number }>(
      (resolve, reject) => {
        let settled = false;
        const finish = (operation: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          operation();
        };
        const abort = () => {
          aborted = true;
          try {
            task?.abort();
          } catch (cause) {
            options.onError(nativeFailure('abort download', cause));
          }
          // The caller rejects immediately at the fetch boundary. Keep the
          // directory lease until the native terminal callback drains its file.
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          finish(() => reject(signal.reason));
          return;
        }
        try {
          task = source.downloadFile({
            url,
            filePath,
            timeout,
            success(result) {
              if (settled) {
                void discard(filePath).catch((cause) =>
                  options.onError(nativeFailure('unlink late download', cause)),
                );
                return;
              }
              finish(() => resolve(result));
            },
            fail: (cause) => finish(() => reject(nativeFailure('wx.downloadFile', cause))),
          });
          if (aborted) abort();
        } catch (cause) {
          finish(() => reject(nativeFailure('wx.downloadFile', cause)));
        }
      },
    ).then(ok, err);
    const outcome = await (async () => {
      signal.throwIfAborted();
      if (!downloaded.ok) throw downloaded.error;
      const result = downloaded.value;
      if (
        !Number.isInteger(result.statusCode) ||
        result.statusCode < 100 ||
        result.statusCode > 599
      )
        throw nativeFailure('wx.downloadFile status', result);
      if (result.filePath !== filePath) throw nativeFailure('wx.downloadFile destination', result);
      if (result.statusCode < 200 || result.statusCode >= 300)
        return createPackageResponse(new Uint8Array(), { status: result.statusCode });
      const bytes = await readDownload(files, filePath, signal, brotli).catch((cause) => {
        if (signal.aborted) throw signal.reason;
        if (cause instanceof NativeDownloadReadError) throw cause;
        throw nativeFailure('read download', cause);
      });
      if (cache && persist) {
        try {
          await cache.write(cache.key(url), bytes, signal);
        } catch (cause) {
          if (signal.aborted) throw signal.reason;
          options.onError(nativeFailure('cache write', cause));
        }
      }
      signal.throwIfAborted();
      return createPackageResponse(bytes);
    })().then(ok, err);
    try {
      await discard(filePath);
    } catch (cause) {
      throw nativeFailure(
        'unlink download',
        outcome.ok
          ? cause
          : new AggregateError(
              [outcome.error, cause],
              'download and temporary file cleanup failed',
            ),
      );
    }
    if (outcome.ok) return outcome.value;
    if (!(outcome.error instanceof NativeDownloadReadError)) throw outcome.error;
    const failure = nativeFailure(outcome.error.operation, outcome.error.cause);
    if (!refresh) throw failure;
    options.onError(failure);
    return download(publication, signal, persist, false);
  }
  const fetch: PackageFetcher = (url, init) => {
    if (disposed)
      return Promise.reject(
        platformError('platform-disposed', { operation: 'remote package read' }).error,
      );
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(init?.signal?.reason);
    init?.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (init?.signal?.aborted) forwardAbort();
    const operation = (async () => {
      controller.signal.throwIfAborted();
      if (init?.method !== undefined && init.method !== 'GET')
        throw new TypeError('remote packages are read-only GET resources');
      if (init && Object.keys(init).some((key) => !['method', 'signal', 'cache'].includes(key)))
        throw new TypeError('remote packages accept only GET and cancellation options');
      if (init?.cache !== undefined && !['default', 'reload', 'no-store'].includes(init.cache))
        throw new TypeError('remote packages support default, reload or no-store cache policy');
      const publication = resolvePublishedDownload(base, url, options.brotli);
      await prepareDirectory();
      controller.signal.throwIfAborted();
      if (cache && init?.cache !== 'reload' && init?.cache !== 'no-store') {
        try {
          const bytes = await cache.read(cache.key(publication.url), controller.signal);
          controller.signal.throwIfAborted();
          if (
            bytes &&
            (!publication.brotli || bytes.byteLength === publication.brotli.decodedBytes)
          )
            return createPackageResponse(bytes);
        } catch (cause) {
          if (controller.signal.aborted) throw controller.signal.reason;
          options.onError(nativeFailure('cache read', cause));
        }
      }
      return download(publication, controller.signal, init?.cache !== 'no-store');
    })();
    pending.set(controller, operation);
    void operation.catch((cause) => {
      if (controller.signal.aborted && cause !== controller.signal.reason) options.onError(cause);
    });
    void operation
      .finally(() => {
        init?.signal?.removeEventListener('abort', forwardAbort);
        pending.delete(controller);
      })
      .catch(() => {});
    // Caller cancellation is immediate; the Host still drains physical file work
    // before retiring its cache lease. A late native read cannot adopt a response.
    return new Promise<PackageResponse>((resolve, reject) => {
      const abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
      void operation
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', abort));
    });
  };
  return {
    fetch,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      const operations = [...pending.values()];
      for (const controller of pending.keys())
        controller.abort(
          platformError('platform-disposed', { operation: 'remote package read' }).error,
        );
      disposal = Promise.allSettled(operations).then(() => {
        directories.delete(directory);
      });
      return disposal;
    },
  };
}
