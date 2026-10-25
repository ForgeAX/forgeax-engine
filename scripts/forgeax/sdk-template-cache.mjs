import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Project-local Pack product cache, relative to a project root. `project new`
 * copies every template file, so entries shipped here seed each new project.
 */
export const TEMPLATE_BUILD_CACHE = '.forgeax/ddc/build-cache';

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

/** Published entries (`<store>/<key>`) of a project's Pack product cache. */
export async function buildCacheEntries(projectRoot) {
  const cache = resolve(projectRoot, TEMPLATE_BUILD_CACHE);
  const rows = [];
  for (const store of await directoryNames(cache)) {
    for (const key of await directoryNames(join(cache, store, 'entries'))) {
      rows.push(`${store}/${key}`);
    }
  }
  return rows;
}

/**
 * Cook an installed SDK template once and keep only its published Pack
 * products. Keys are relative to the project root and bind the Engine release,
 * so a project created from this template with the same Engine and Node hits
 * them on its first `dev start` / `project play`; edited sources re-cook.
 * Every other build output (dist, generated host, project DDC, staging
 * directories) is removed again, leaving the template's files unchanged.
 */
export async function seedTemplateBuildCache(template, build) {
  const before = new Set(await readdir(template));
  if (before.has('.forgeax')) throw new Error(`sdk-template-build-cache-preexisting: ${template}`);
  await build();
  const cache = resolve(template, TEMPLATE_BUILD_CACHE);
  const keep = await mkdtemp(join(tmpdir(), 'forgeax-sdk-template-cache-'));
  try {
    for (const store of await directoryNames(cache)) {
      await cp(join(cache, store, 'entries'), join(keep, store, 'entries'), { recursive: true });
    }
    for (const name of await readdir(template)) {
      if (!before.has(name)) await rm(resolve(template, name), { recursive: true, force: true });
    }
    await cp(keep, cache, { recursive: true });
  } finally {
    await rm(keep, { recursive: true, force: true });
  }
  const entries = await buildCacheEntries(template);
  if (!entries.some((entry) => entry.startsWith('scriptable-pack-products/')))
    throw new Error(`sdk-template-build-cache-empty: ${template}`);
  return entries;
}
