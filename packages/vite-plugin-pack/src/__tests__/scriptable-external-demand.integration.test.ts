import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import { expect, it } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';
import { recordIndexedBundle } from './vite-fixtures.js';

it.each([
  'dev',
  'build',
] as const)('prepares an unread native asset once during complete %s publication', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-external-demand-'));
  let plugin: ReturnType<typeof createPluginPackInternal> | undefined;
  try {
    const assets = join(root, 'assets');
    await mkdir(assets);
    const packageId = '019ffa97-0000-7000-8000-000000000081';
    const namespace = PackageId.parse(packageId);
    if (!namespace.ok) throw namespace.error;
    const guid = AssetGuid.format(AssetGuid.derive(namespace.value, 'effect'));
    await writeFile(
      join(assets, 'native.pack.json'),
      JSON.stringify({
        schemaVersion: '3.0.0',
        packageId,
        assets: { effect: { kind: 'sampler', payload: {}, refs: [] } },
      }),
    );
    await writeFile(
      join(assets, 'scene.pack.ts'),
      `export default {
          schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,82]),
          build: () => ({ ok: true, value: {
            scene: { kind: 'scene', entities: [], refs: [{ guid: '${guid}' }] },
          } }),
        };`,
    );
    let cooks = 0;
    const cooker: NativeCooker = {
      key: 'sampler',
      cook(input) {
        cooks++;
        return {
          guid: (input as { readonly guid: string }).guid,
          payload: { kind: 'sampler', compiled: true },
          refs: [],
          artifacts: {},
          inputFingerprint: 'sha256:compiled',
        };
      },
    };
    plugin = createPluginPackInternal({
      roots: [assets],
      cookers: [cooker],
      producerReadiness: 'before-consume',
      ddc: { projectDdcRoot: join(root, 'ddc') },
    });
    if (mode === 'dev') {
      plugin.configureServer({ middlewares: { use() {} }, ws: { send() {} } });
      await plugin.ready();
      expect(plugin.catalogSnapshot().map((entry) => entry.guid)).toContain(guid);
    } else {
      const emitted: Array<{ fileName?: string; name?: string; source: string | Uint8Array }> = [];
      await plugin.generateBundle.call(recordIndexedBundle(emitted));
      const catalog = emitted.find((asset) => asset.fileName === 'pack-index.json');
      expect(decodeCatalogWire(JSON.parse(String(catalog?.source))).unwrap()).toEqual(
        expect.arrayContaining([expect.objectContaining({ guid })]),
      );
    }
    expect(cooks).toBe(1);
  } finally {
    await plugin?.closeBundle();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
