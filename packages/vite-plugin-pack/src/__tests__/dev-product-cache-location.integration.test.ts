import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

const authored = (marker: number) => `export default {
  schemaVersion: '2.0.0',
  packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,95]),
  build: () => ({ ok: true, value: { material: {
    kind: 'material', passes: [{ name: 'forward', program: { module: 'fixture::surface' } }],
    parameters: [], marker: ${marker},
  } } }),
};`;

// A copied or freshly created project directory must reuse the products its
// content already produced: the dev server is where every play and dev session
// first waits for Pack cooking.
it('reuses dev Pack products from an equal project at another location and re-cooks edits', async () => {
  const machine = await mkdtemp(join(tmpdir(), 'forgeax-dev-product-cache-location-'));
  const buildCacheRoot = join(machine, 'build-cache');
  let cooks = 0;
  const cooker: NativeCooker = {
    key: 'material',
    cacheIdentity: () => 'location-fixture/1',
    cook(input) {
      cooks++;
      const draft = input as { guid: string; source: unknown };
      return {
        guid: draft.guid,
        payload: draft.source,
        refs: [],
        artifacts: {},
        inputFingerprint: 'location-fixture/1',
      };
    },
  };
  const serve = async (project: string) => {
    const plugin = createPluginPackInternal({
      roots: [join(project, 'assets')],
      cookers: [cooker],
      runtimeBinding: createStandaloneRuntimeAssetBinding('location'),
      ddc: {
        buildCacheRoot,
        projectDdcRoot: join(project, '.forgeax', 'ddc', 'v2'),
        identityRoot: project,
      },
    });
    try {
      plugin.configureServer({ middlewares: { use() {} }, ws: { send() {} } });
      await plugin.ready();
      return plugin.catalogSnapshot().map((entry) => entry.kind);
    } finally {
      await plugin.closeBundle();
    }
  };
  const project = async (name: string, marker: number) => {
    const root = join(machine, name);
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'material.pack.ts'), authored(marker));
    return root;
  };
  try {
    expect(await serve(await project('first', 1))).toEqual(['material']);
    expect(cooks).toBe(1);
    expect(await serve(await project('copy', 1))).toEqual(['material']);
    expect(cooks).toBe(1);
    const edited = await project('edited', 2);
    expect(await serve(edited)).toEqual(['material']);
    expect(cooks).toBe(2);
  } finally {
    await rm(machine, { recursive: true, force: true });
  }
});
