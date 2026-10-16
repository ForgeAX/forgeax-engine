import type { PackageResponse } from '@forgeax/engine-types';

/** Own an immutable response body for retained publications and native file reads. */
export function createPackageResponse(
  source: Uint8Array,
  options: { readonly status?: number; readonly mediaType?: string } = {},
): PackageResponse {
  const bytes = source.slice();
  const status = options.status ?? 200;
  let used = false;
  const consume = (): Uint8Array<ArrayBuffer> => {
    if (used) throw new TypeError('package response body has already been consumed');
    used = true;
    return bytes;
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === 'content-type' ? (options.mediaType ?? null) : null),
    },
    get bodyUsed() {
      return used;
    },
    async arrayBuffer() {
      return consume().buffer;
    },
    async text() {
      return new TextDecoder('utf-8', { fatal: true }).decode(consume());
    },
    async json() {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(consume()));
    },
  };
}
