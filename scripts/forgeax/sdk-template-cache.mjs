import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const SDK_BUILD_CACHE_SEED = 'build-cache';

// Publication heads and native computation caches depend on the consuming host.
// Only immutable Pack products and their discovery rows seed consumers.
const PRODUCT_STORES = ['scriptable-pack-product-kinds', 'scriptable-pack-products'];

async function directoryNames(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    if (cause?.code === 'ENOENT') return [];
    throw cause;
  }
}

/** Published entries (`<store>/<key>`) in a Pack product cache. */
export async function buildCacheEntries(cache) {
  const rows = [];
  for (const store of PRODUCT_STORES) {
    for (const key of await directoryNames(join(cache, store, 'entries'))) {
      rows.push(`${store}/${key}`);
    }
  }
  return rows;
}

/** Cook a template against an existing shared build cache and discard its transient state. */
export async function seedTemplateBuildCache(template, build) {
  const before = new Set(await readdir(template));
  if (before.has('.forgeax')) throw new Error(`sdk-template-build-cache-preexisting: ${template}`);
  try {
    await build();
  } finally {
    for (const name of await readdir(template)) {
      if (!before.has(name)) await rm(resolve(template, name), { recursive: true, force: true });
    }
  }
}

export async function stageSdkBuildCache(cache, destination, excludedGuids = new Set()) {
  const selected = await Promise.all(
    (await buildCacheEntries(cache)).map(async (entry) => {
      const [store, key] = entry.split('/');
      const path = join(store, 'entries', key);
      if (excludedGuids.size > 0) {
        const receipt = JSON.parse(await readFile(join(cache, path, 'entry.json'), 'utf8')).receipt;
        if (excludedGuids.has(receipt.guid)) return undefined;
      }
      return { entry, path };
    }),
  );
  const entries = selected.filter((row) => row !== undefined);
  if (!entries.some(({ entry }) => entry.startsWith('scriptable-pack-products/')))
    throw new Error('sdk-build-cache-empty');
  for (const { path } of entries)
    await cp(join(cache, path), join(destination, path), { recursive: true });
  return entries.map(({ entry }) => entry);
}
