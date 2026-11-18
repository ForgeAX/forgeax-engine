import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** Serve one fixture origin from its emitted tree; preserve native URL transports. */
export function createDistAssetFetch(
  directory,
  { origin = 'http://forgeax-smoke.test', nativeFetch = globalThis.fetch.bind(globalThis) } = {},
) {
  const root = resolve(directory);
  const base = new URL(origin);
  return async (input, init) => {
    const address =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(address, base);
    if (url.protocol !== base.protocol || url.origin !== base.origin)
      return nativeFetch(input, init);
    const path = resolve(root, `.${url.pathname}`);
    assert(path.startsWith(root + sep), 'asset URL must stay inside the emitted build');
    return existsSync(path) ? new Response(readFileSync(path)) : new Response('', { status: 404 });
  };
}
