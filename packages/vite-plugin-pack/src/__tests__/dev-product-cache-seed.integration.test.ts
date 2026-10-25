import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

const authored = (marker: number) => `export default {
  schemaVersion: '2.0.0',
  packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,96]),
  build: () => ({ ok: true, value: { material: {
    kind: 'material', passes: [{ name: 'forward', program: { module: 'fixture::surface' } }],
    parameters: [], marker: ${marker},
  } } }),
};`;

// The SDK cooks each template once and ships its project-local build cache;
// `project new` copies it with the template files. A new project's first dev
// session must publish from those entries, and an edited template Pack cooks.
it('publishes a new project from the build cache its template shipped and re-cooks edits', async () => {
  const machine = await mkdtemp(join(tmpdir(), 'forgeax-dev-product-cache-seed-'));
  let cooks = 0;
  const cooker: NativeCooker = {
    key: 'material',
    cacheIdentity: () => 'seed-fixture/1',
    cook(input) {
      cooks++;
      const draft = input as { guid: string; source: unknown };
      return {
        guid: draft.guid,
        payload: draft.source,
        refs: [],
        artifacts: {},
        inputFingerprint: 'seed-fixture/1',
      };
    },
  };
  const buildCache = (project: string) => join(project, '.forgeax', 'ddc', 'build-cache');
  const serve = async (project: string) => {
    const plugin = createPluginPackInternal({
      roots: [join(project, 'assets')],
      cookers: [cooker],
      runtimeBinding: createStandaloneRuntimeAssetBinding('seed'),
      ddc: {
        buildCacheRoot: buildCache(project),
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
  const project = async (name: string, marker: number, seed?: string) => {
    const root = join(machine, name);
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'material.pack.ts'), authored(marker));
    if (seed !== undefined) await cp(buildCache(seed), buildCache(root), { recursive: true });
    return root;
  };
  try {
    const template = await project('template', 1);
    expect(await serve(template)).toEqual(['material']);
    expect(cooks).toBe(1);
    expect(await serve(await project('new-game', 1, template))).toEqual(['material']);
    expect(cooks).toBe(1);
    expect(await serve(await project('edited-game', 2, template))).toEqual(['material']);
    expect(cooks).toBe(2);
  } finally {
    await rm(machine, { recursive: true, force: true });
  }
});
