import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { meshAssetContribution } from '@forgeax/engine-geometry';
import { decodeCatalogWire } from '@forgeax/engine-pack';
import { createWechatPackageFetcher } from '@forgeax/engine-platform-wechat';
import type { PackIndexEntry, PackV2 } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { createPluginPackInternal } from '../../../../vite-plugin-pack/src/plugin-pack.js';
import type { ProjectFacts } from '../../types.js';
import { writeWechatProject } from '../wechat.js';

it('shares identical produced bodies while retaining distinct Catalog assets and integrity checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-wechat-shared-artifacts-'));
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const assets = join(root, 'assets');
  const out = join(root, 'out');
  try {
    await mkdir(assets);
    await mkdir(out);
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
    await writeFile(
      join(assets, 'boxes.pack.ts'),
      `
import { createBoxGeometry } from '@forgeax/engine-geometry';
export default {
  schemaVersion: '2.0.0',
  packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,71]),
  build: () => ({ ok: true, value: {
    first: createBoxGeometry(2, 3, 4).unwrap(),
    second: createBoxGeometry(2, 3, 4).unwrap(),
    different: createBoxGeometry(2, 3, 5).unwrap(),
  } }),
};
`,
    );
    await writeFile(
      join(assets, 'another.pack.ts'),
      `
import { createBoxGeometry } from '@forgeax/engine-geometry';
export default {
  schemaVersion: '2.0.0',
  packageId: new Uint8Array([1,159,250,151,0,0,112,0,128,0,0,0,0,0,0,72]),
  build: () => ({ ok: true, value: { another: createBoxGeometry(2, 3, 4).unwrap() } }),
};
`,
    );
    const emitted = new Map<string, string | Uint8Array>();
    const plugin = createPluginPackInternal({ roots: [assets] });
    try {
      await plugin.generateBundle.call({
        emitFile(asset) {
          const name = asset.fileName ?? `assets/${asset.name ?? 'asset'}`;
          emitted.set(name, asset.source);
          return name;
        },
        getFileName: (reference) => reference,
      });
    } finally {
      await plugin.closeBundle();
    }
    const json = (name: string) => {
      const body = emitted.get(name);
      if (body === undefined) throw new Error(`missing emitted file: ${name}`);
      return JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
    };
    const catalog = decodeCatalogWire(
      json('pack-index.json'),
    ).unwrap() as readonly PackIndexEntry[];
    expect(catalog).toHaveLength(4);
    const entryFor = (key: string) => {
      const entry = catalog.find((candidate) => candidate.sourceKey === key);
      if (entry?.packageUrl === undefined) throw new Error(`missing published entry: ${key}`);
      return entry;
    };
    const descriptorFor = (key: string) => {
      const entry = entryFor(key);
      const pack = json(String(entry.packageUrl).replace(/^\//, '')) as PackV2;
      const body = pack.assets.find((asset) => asset.guid === entry.guid)?.artifacts?.body;
      if (body === undefined) throw new Error(`missing produced body: ${key}`);
      return body;
    };
    const first = descriptorFor('first');
    const second = descriptorFor('second');
    const different = descriptorFor('different');
    expect(descriptorFor('another')).toEqual(first);
    expect(first.path).toBe(second.path);
    expect(first).toEqual(second);
    expect(different.path).not.toBe(first.path);
    expect(different.integrity).not.toEqual(first.integrity);
    expect(emitted.has(`assets/${first.path}`)).toBe(true);
    expect(emitted.has(`assets/${different.path}`)).toBe(true);
    for (const [name, body] of emitted) {
      await mkdir(dirname(join(out, name)), { recursive: true });
      await writeFile(join(out, name), body);
    }
    await writeFile(join(out, 'game.js'), '');
    await writeWechatProject(
      { name: 'Shared artifacts' } as ProjectFacts,
      { target: 'wechat' },
      out,
    );
    const reads: string[] = [];
    const fetcher = createWechatPackageFetcher(
      {
        getFileSystemManager: () => ({
          readFile: () => {
            throw new Error('expected native Brotli read');
          },
          readCompressedFile(options) {
            reads.push(options.filePath);
            void readFile(join(out, options.filePath)).then((bytes) => {
              options.success({ data: new Uint8Array(brotliDecompressSync(bytes)).buffer });
            }, options.fail);
          },
        }),
      },
      { root: 'payload', baseUrl: 'https://published.invalid/', encoding: 'br' },
    );
    const registry = new AssetRegistry({ shaderRegistry: {} as never });
    registry.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
    registry.setCatalogSource(createCatalogSource({ fetch: fetcher, entries: catalog }));
    try {
      const load = async (key: string) => {
        const handle = (await registry.load(entryFor(key).guid, 'mesh')).unwrap();
        try {
          return registry.read(handle).unwrap();
        } finally {
          registry.release(handle).unwrap();
        }
      };
      const a = await load('first');
      for (const key of ['second', 'another']) {
        expect(a.attributes.position).toEqual((await load(key)).attributes.position);
      }
      expect(a.attributes.position).not.toEqual((await load('different')).attributes.position);
      expect(reads).toContain(`payload/assets/${first.path}.br`);
      expect(reads).toContain(`payload/assets/${different.path}.br`);
    } finally {
      registry.dispose();
    }
    const stored = join(out, `payload/assets/${first.path}.br`);
    const corrupt = brotliDecompressSync(await readFile(stored));
    corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
    await writeFile(stored, brotliCompressSync(corrupt));
    const rejected = new AssetRegistry({ shaderRegistry: {} as never });
    rejected.installDecoder(meshAssetContribution.kind, meshAssetContribution.decoder);
    rejected.setCatalogSource(createCatalogSource({ fetch: fetcher, entries: catalog }));
    try {
      for (const key of ['first', 'second', 'another']) {
        expect(await rejected.load(entryFor(key).guid, 'mesh')).toMatchObject({
          ok: false,
          error: { code: 'asset-integrity-failed' },
        });
      }
    } finally {
      rejected.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
