import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, it } from 'vitest';
import { STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS, scanInventory } from '../scanner.js';
import {
  createScriptablePackMetadataCache,
  createScriptablePackSourceSnapshot,
} from '../scriptable-pack-node.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pack = (id: string, imports = '', name = 'cached') => `
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
${imports}
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-0000000000${id}'),
  build() { return ok({ '${name}': { kind: 'scene', entities: {} } }); },
});`;

/** Counts real metadata Workers by the source each one is asked to load. */
async function scanLoads(
  root: string,
  cache: ReturnType<typeof createScriptablePackMetadataCache>,
): Promise<string[]> {
  const loads: string[] = [];
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (...args: Parameters<Worker['postMessage']>): void {
    const message = args[0] as { kind?: string; sourcePath?: string } | undefined;
    if (message?.kind === 'load' && message.sourcePath !== undefined)
      loads.push(message.sourcePath);
    Reflect.apply(postMessage, this, args);
  };
  try {
    const scanned = await scanInventory([root], {
      scriptablePack: {
        ...STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
        metadataOnly: true,
        sourceSnapshot: createScriptablePackSourceSnapshot({ metadataCache: cache }),
      },
    });
    expect(scanned.ok).toBe(true);
    if (scanned.ok) expect(scanned.value.declarations.size).toBe(2);
  } finally {
    Worker.prototype.postMessage = postMessage;
  }
  return loads.sort();
}

it('reuses metadata across snapshots only for byte-identical source closures', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-metadata-cache-')));
  roots.push(root);
  // Author dependencies belong to the fixture project, never the Pack loader.
  const modules = join(root, 'node_modules/@forgeax');
  await mkdir(modules, { recursive: true });
  const here = dirname(fileURLToPath(import.meta.url));
  await symlink(resolve(here, '../..'), join(modules, 'engine-pack'), 'junction');
  await symlink(resolve(here, '../../../types'), join(modules, 'engine-types'), 'junction');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'metadata-cache-fixture',
      private: true,
      dependencies: {
        '@forgeax/engine-pack': 'workspace:*',
        '@forgeax/engine-types': 'workspace:*',
      },
    }),
  );
  const first = join(root, 'first.pack.ts');
  const second = join(root, 'second.pack.ts');
  const shared = join(root, 'shared.ts');
  await writeFile(shared, 'export const label = 1;');
  await writeFile(first, pack('71', "import { label } from './shared.ts'; void label;"));
  await writeFile(second, pack('72'));
  const cache = createScriptablePackMetadataCache();

  expect(await scanLoads(root, cache)).toEqual([first, second]);
  expect(await scanLoads(root, cache)).toEqual([]);

  await writeFile(second, pack('72', '', 'cachee'));
  expect(await scanLoads(root, cache)).toEqual([second]);

  await writeFile(shared, 'export const label = 2;');
  expect(await scanLoads(root, cache)).toEqual([first]);

  cache.clear();
  expect(await scanLoads(root, cache)).toEqual([first, second]);
}, 60_000);

it('evicts the least recently used closure beyond its bound', () => {
  const cache = createScriptablePackMetadataCache(2);
  const definition = { schemaVersion: '2.0.0' } as never;
  cache.set('a', definition);
  cache.set('b', definition);
  expect(cache.get('a')).toBe(definition);
  cache.set('c', definition);
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')).toBe(definition);
  expect(cache.get('c')).toBe(definition);
});
