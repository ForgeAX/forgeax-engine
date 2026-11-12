import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding, type Importer, ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createPluginPackInternal } from '../plugin-pack.js';

it('reuses the existing Meta product DDC across dev owners and invalidates producer inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-dev-meta-product-'));
  const previous = process.cwd();
  const assets = join(root, 'assets');
  const source = join(assets, 'paint.scene');
  const guid = '01900000-0000-7000-8000-0000000000f1';
  let imports = 0,
    cooks = 0,
    revision = '1',
    producer = 'sealed-fixture/1';
  const native = createMaterialPackCooker([], { profile: 'webgpu-storage' });
  const identity = native.cacheIdentity;
  if (identity === undefined) throw Error('missing material identity');
  const importer: Importer = {
    key: 'fixture',
    async import(context) {
      imports++;
      const bytes = await context.readSource();
      if (!bytes.ok) return bytes;
      return ok({
        assets: [
          {
            guid,
            kind: 'material',
            refs: [],
            artifacts: {},
            payload: {
              kind: 'material',
              passes: [{ name: 'forward', program: { module: 'forgeax::default-unlit' } }],
              values: { baseColor: [(bytes.value[0] ?? 0) / 255, 0.2, 0.3, 1] },
            },
          },
        ],
        sourceDependencies: [],
      });
    },
  };
  const serve = async (scope: string, editCookerInPlace = false) => {
    const plugin = createPluginPackInternal({
      roots: [assets],
      importers: [importer],
      producerIdentity: producer,
      cookers: [
        {
          ...native,
          cacheIdentity: async () => `${revision}:${await identity()}`,
          async cook(input) {
            cooks++;
            return native.cook(input);
          },
        },
      ],
      runtimeBinding: createStandaloneRuntimeAssetBinding(scope),
      ddc: {
        buildCacheRoot: join(root, 'ddc'),
        identityRoot: root,
        projectDdcRoot: join(root, 'runtime-ddc'),
      },
    });
    try {
      plugin.configureServer({ middlewares: { use() {} }, ws: { send() {} } });
      await plugin.ready();
      const rows = plugin.catalogSnapshot();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.publication?.outputs[0]?.guid).toBe(guid);
      if (editCookerInPlace) {
        revision = 'in-place';
        await plugin.rebuildCatalogInPlace([source]);
        expect({ imports, cooks }).toEqual({ imports: 2, cooks: 2 });
      }
      return rows[0]?.publication?.outputs[0]?.digest;
    } finally {
      await plugin.closeBundle();
    }
  };
  try {
    await mkdir(assets);
    await writeFile(source, new Uint8Array([1]));
    await writeFile(
      `${source}.meta.json`,
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'fixture',
        source: 'paint.scene',
        importSettings: {},
        subAssets: [{ guid, sourceIndex: 0, sourceKey: 'paint', kind: 'material' }],
      }),
    );
    process.chdir(root);
    const first = await serve('cold');
    expect(await serve('warm')).toBe(first);
    expect({ imports, cooks }).toEqual({ imports: 1, cooks: 1 });
    await serve('in-place', true);
    await writeFile(source, new Uint8Array([2]));
    expect(await serve('edited')).not.toBe(first);
    await serve('edited-warm');
    expect({ imports, cooks }).toEqual({ imports: 3, cooks: 3 });
    revision = '2';
    await serve('new-cooker');
    expect({ imports, cooks }).toEqual({ imports: 4, cooks: 4 });
    producer = 'sealed-fixture/2';
    await serve('new-program');
    expect({ imports, cooks }).toEqual({ imports: 5, cooks: 5 });
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
