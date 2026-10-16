import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcEntryStore } from '@forgeax/engine-ddc';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

it('uses the existing product cache through the normal production owner and rechecks source/cooker identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-production-product-cache-'));
  const source = join(root, 'material.pack.ts');
  let cooks = 0;
  let identity = 'fixture-cooker/1';
  const cooker: NativeCooker = {
    key: 'material',
    cacheIdentity: () => identity,
    cook(input) {
      cooks++;
      const draft = input as { guid: string; source: unknown };
      return {
        guid: draft.guid,
        payload: draft.source,
        refs: [],
        artifacts: {},
        inputFingerprint: identity,
      };
    },
  };
  const authored = (marker: number) => `export default {
    schemaVersion: '2.0.0',
    packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,92]),
    build: () => ({ ok: true, value: { material: {
      kind: 'material', passes: [{ name: 'forward', program: { module: 'fixture::surface' } }],
      parameters: [], marker: ${marker},
    } } }),
  };`;
  const run = async (generation = 1, cache = true) => {
    const plugin = createPluginPackInternal({
      roots: [root],
      cookers: [cooker],
      runtimeBinding: { ...createStandaloneRuntimeAssetBinding('product-cache'), generation },
      ...(cache ? { ddc: { buildCacheRoot: join(root, 'cache') } } : {}),
      // Cache artifacts are not authoring inputs.
      ignorePath: (path) => path.startsWith(join(root, 'cache')),
    });
    const emitted: Array<{ fileName?: string; name?: string; source: string | Uint8Array }> = [];
    const context = {
      emitFile(asset: (typeof emitted)[number]) {
        emitted.push(asset);
        return String(emitted.length - 1);
      },
      getFileName(id: string) {
        const item = emitted[Number(id)];
        return item?.fileName ?? `assets/${item?.name ?? id}`;
      },
    };
    try {
      plugin.configResolved({ command: 'build', base: '/' });
      await plugin.buildStart.call(context);
      await plugin.generateBundle.call(context);
      return emitted.map((row) => ({
        name: row.fileName ?? row.name,
        source: typeof row.source === 'string' ? row.source : [...row.source],
      }));
    } finally {
      await plugin.closeBundle();
    }
  };
  try {
    await writeFile(source, authored(1));
    const cold = await run();
    expect(cooks).toBe(1);
    const warm = await run();
    expect(cooks).toBe(1);
    // Compare every emitted byte and the complete public catalog, not just producer output.
    expect(warm).toEqual(cold);
    const store = new DdcEntryStore(join(root, 'cache', 'scriptable-pack-products'));
    const keys = await store.listKeys();
    expect(keys).toHaveLength(1);
    const uncached = await run(1, false);
    expect(cooks).toBe(2);
    expect(uncached).toEqual(cold);
    const newGeneration = await run(7);
    expect(cooks).toBe(2);
    const catalog = newGeneration.find((row) => row.name === 'pack-index.json');
    expect(JSON.parse(String(catalog?.source))).toMatchObject({ generation: 7 });
    await writeFile(source, authored(2));
    const edited = await run();
    expect(cooks).toBe(3);
    expect(edited).not.toEqual(cold);
    identity = 'fixture-cooker/2';
    await run();
    expect(cooks).toBe(4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('revalidates current references after a cached material product and retains the uncached failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-production-cache-reference-'));
  const dependency = join(root, 'dependency.pack.json');
  const guid = '019ffa97-0000-7000-8000-000000000093';
  const cache = join(root, 'cache');
  const run = async (cached: boolean) => {
    const plugin = createPluginPackInternal({
      roots: [root],
      cookers: [
        {
          key: 'material',
          cacheIdentity: () => 'reference-fixture/1',
          cook(input) {
            const draft = input as { guid: string; source: unknown };
            return {
              guid: draft.guid,
              payload: draft.source,
              refs: [guid],
              artifacts: {},
              inputFingerprint: 'reference-fixture',
            };
          },
        },
      ],
      ...(cached ? { ddc: { buildCacheRoot: cache } } : {}),
      ignorePath: (path) => path.startsWith(cache),
    });
    const emitted: Array<{ fileName?: string; name?: string; source: string | Uint8Array }> = [];
    try {
      await plugin.generateBundle.call({
        emitFile(asset) {
          emitted.push(asset);
          return String(emitted.length - 1);
        },
        getFileName(id) {
          const item = emitted[Number(id)];
          return item?.fileName ?? `assets/${item?.name ?? id}`;
        },
      });
      return { error: undefined, emitted };
    } catch (error) {
      return { error: error as { code?: string; detail?: unknown }, emitted };
    } finally {
      await plugin.closeBundle();
    }
  };
  try {
    await writeFile(
      dependency,
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{ guid, kind: 'sampler', payload: { magFilter: 'linear' }, refs: [] }],
      }),
    );
    await writeFile(
      join(root, 'material.pack.ts'),
      `export default {
      schemaVersion: '2.0.0',
      packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,94]),
      build: () => ({ ok: true, value: { material: {
        kind: 'material', passes: [{ name: 'forward', program: { module: 'fixture::surface' } }], parameters: [],
      } } }),
    };`,
    );
    const cold = await run(true);
    expect(cold.error).toBeUndefined();
    expect(
      await new DdcEntryStore(join(cache, 'scriptable-pack-products')).listKeys(),
    ).toHaveLength(1);
    await rm(dependency);
    const cachedFailure = await run(true);
    const uncachedFailure = await run(false);
    expect(cachedFailure.error?.code).toBe('pack-output-reference-missing');
    expect(cachedFailure.error?.code).toBe(uncachedFailure.error?.code);
    expect(cachedFailure.error?.detail).toEqual(uncachedFailure.error?.detail);
    expect(cachedFailure.emitted.some((row) => row.fileName === 'pack-index.json')).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
