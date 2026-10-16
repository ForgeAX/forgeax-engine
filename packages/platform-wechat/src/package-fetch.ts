import { createPackageResponse } from '@forgeax/engine-pack/runtime';
import type { PackageFetcher } from '@forgeax/engine-types';
import URL from 'core-js-pure/actual/url/index.js';

export interface WechatPackageSource {
  getFileSystemManager(): {
    readFile(options: {
      readonly filePath: string;
      readonly success: (result: { readonly data: ArrayBuffer }) => void;
      readonly fail: (cause: unknown) => void;
    }): void;
    readCompressedFile?(options: {
      readonly filePath: string;
      readonly compressionAlgorithm: 'br';
      readonly success: (result: { readonly data: ArrayBuffer }) => void;
      readonly fail: (cause: unknown) => void;
    }): void;
  };
}

/** Read the producer's package namespace. Downloads and caches keep their own owners. */
export function createWechatPackageFetcher(
  source: WechatPackageSource,
  options: { readonly root: string; readonly baseUrl: string; readonly encoding?: 'br' },
): PackageFetcher {
  const base = new URL(options.baseUrl);
  if (
    !base.pathname.endsWith('/') ||
    base.search ||
    base.hash ||
    !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(options.root)
  ) {
    throw new TypeError('package root and URL base must name one package directory');
  }
  const root = options.root.replace(/\/$/, '');
  return async (url, init) => {
    init?.signal?.throwIfAborted();
    if (init?.method !== undefined && init.method !== 'GET') {
      throw new Error('package files are read-only GET resources');
    }
    const resolved = new URL(url, base);
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
      throw new Error(`package URL is outside its published namespace: ${url}`);
    }
    const relative = decodeURIComponent(resolved.pathname.slice(base.pathname.length));
    if (
      !relative ||
      relative.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\\0]/.test(relative)
    ) {
      throw new Error(`invalid published package path: ${url}`);
    }
    const logicalPath = root ? `${root}/${relative}` : relative;
    const filePath = options.encoding === 'br' ? `${logicalPath}.br` : logicalPath;
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void): void => {
        if (settled) return;
        settled = true;
        init?.signal?.removeEventListener('abort', abort);
        complete();
      };
      const abort = (): void => finish(() => reject(init?.signal?.reason));
      init?.signal?.addEventListener('abort', abort, { once: true });
      if (init?.signal?.aborted) {
        abort();
        return;
      }
      try {
        const request = {
          filePath,
          success: ({ data }: { readonly data: ArrayBuffer }) =>
            finish(() =>
              data instanceof ArrayBuffer
                ? resolve(data)
                : reject(new Error(`native package read returned non-binary data: ${filePath}`)),
            ),
          fail: (cause: unknown) =>
            finish(() => reject(new Error(`native package read failed: ${filePath}`, { cause }))),
        };
        const files = source.getFileSystemManager();
        if (options.encoding === 'br') {
          if (typeof files.readCompressedFile !== 'function')
            throw new Error('WeChat readCompressedFile is unavailable');
          files.readCompressedFile({ ...request, compressionAlgorithm: 'br' });
        } else files.readFile(request);
      } catch (cause) {
        finish(() => reject(cause));
      }
    });
    init?.signal?.throwIfAborted();
    return createPackageResponse(new Uint8Array(bytes));
  };
}
