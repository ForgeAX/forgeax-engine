import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it, onTestFinished } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

const authored = (marker: number) => `export default {
  schemaVersion: '2.0.0',
  packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,95]),
  build: () => ({ ok: true, value: { material: {
    kind: 'material', passes: [{ name: 'forward', program: { module: 'fixture::surface' } }],
    parameters: [], marker: ${marker},
  } } }),
};`;

it.each([
  'shared',
  'template copy',
] as const)('reuses dev Pack products after relocation (%s)', async (topology) => {
  const machine = await mkdtemp(join(tmpdir(), 'forgeax-dev-product-cache-relocation-'));
  const cache = (project: string) =>
    topology === 'shared'
      ? join(machine, 'build-cache')
      : join(project, '.forgeax', 'ddc', 'build-cache');
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
        buildCacheRoot: cache(project),
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
  const project = async (name: string, marker: number, source?: string) => {
    const root = join(machine, name);
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'material.pack.ts'), authored(marker));
    if (source && topology === 'template copy')
      await cp(cache(source), cache(root), { recursive: true });
    return root;
  };
  onTestFinished(() => rm(machine, { recursive: true, force: true }));
  const first = await project('first', 1);
  expect(await serve(first)).toEqual(['material']);
  expect(cooks).toBe(1);
  expect(await serve(await project('copy', 1, first))).toEqual(['material']);
  expect(cooks).toBe(1);
  const edited = await project('edited', 2, first);
  expect(await serve(edited)).toEqual(['material']);
  expect(cooks).toBe(2);
});
