import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializeCookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication.js';
import { createAssetRegistry, createCatalogSource } from '../../../assets-runtime/src/index.js';
import { materialContribution } from '../../../render/src/assets/asset-decoders.js';
import type { DispatcherHandler } from '../dev/dispatcher.js';
import { createPluginPackInternal } from '../plugin-pack.js';

it.each([
  'legacy',
  'dynamic',
] as const)('omits only external shader bytes in the final served %s DEV Pack and restores the complete material', async (format) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-dev-material-transport-'));
  const packageId = '019f0000-0000-7000-8000-000000000702';
  const parsedPackage = PackageId.parse(packageId);
  if (!parsedPackage.ok) throw parsedPackage.error;
  const guid = AssetGuid.format(AssetGuid.derive(parsedPackage.value, 'material/main'));
  const record = materialRecordFixture({ guid, generation: 1 });
  const original = JSON.parse(serializeCookedMaterialRecord(record));
  const originalBefore = JSON.stringify(original);
  const sourcePath = join(root, format === 'dynamic' ? 'material.pack.ts' : 'material.pack.json');
  const authored = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: record.guid,
        kind: 'material',
        execution: 'cooked',
        payload: { kind: 'material', ...record.resolved },
        refs: [],
        artifacts: {},
      },
    ],
  };
  const source =
    format === 'dynamic'
      ? `import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
export default definePack({ schemaVersion: '2.0.0', packageId: definePackageId('${packageId}'),
  build() { return ok({ 'material/main': ${JSON.stringify({ kind: 'material', ...record.resolved })} }); }
});`
      : JSON.stringify(authored);
  await writeFile(sourcePath, source);
  const middlewares: DispatcherHandler[] = [];
  const plugin = createPluginPackInternal({
    roots: [root],
    watch: false,
    ddc: { projectDdcRoot: join(root, 'ddc') },
    cookers: [
      {
        key: 'material',
        cook: () => ({
          guid: record.guid,
          payload: { kind: 'material', ...record.resolved, cooked: original },
          refs: [],
          artifacts: Object.fromEntries(
            record.programs.map(({ artifact }) => [
              artifact.path,
              { mediaType: artifact.mediaType, bytes: artifact.bytes },
            ]),
          ),
          inputFingerprint: 'dev-material-transport-fixture',
        }),
      },
    ],
  });
  const server = createServer((request, response) => {
    let index = 0;
    const next = (error?: unknown): void => {
      if (error !== undefined) {
        response.statusCode = 500;
        response.end(String(error));
        return;
      }
      const middleware = middlewares[index++];
      if (middleware === undefined) {
        response.statusCode = 404;
        response.end('missing');
        return;
      }
      Promise.resolve(middleware(request, response, next)).catch(next);
    };
    next();
  });
  let registry: ReturnType<typeof createAssetRegistry> | undefined;
  let decoder: ReturnType<ReturnType<typeof createAssetRegistry>['installDecoder']> | undefined;
  try {
    plugin.configResolved({ root, command: 'serve', base: '/' });
    plugin.configureServer({
      middlewares: { use: (middleware) => middlewares.push(middleware) },
      ws: { send: () => {} },
    });
    const binding: RuntimeAssetBinding = {
      schemaVersion: 'runtime-asset-binding-v1',
      gameId: 'dev-material-transport',
      scopeId: 'dev-material-transport',
      generation: 1,
      status: 'unbound',
      catalogUrl: '/__pack/scopes/dev-material-transport/1/catalog.json',
      importUrlBase: '/__pack/scopes/dev-material-transport/1/import',
      packageUrlBase: '/__pack/scopes/dev-material-transport/1/asset',
    };
    const accepted = await plugin.rebind(binding, [root], join(root, 'ddc'));
    await plugin.ready();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing HTTP address');
    const base = `http://127.0.0.1:${address.port}`;
    const catalogResponse = await fetch(new URL(accepted.catalogUrl, base));
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as { entries: PackIndexEntry[] };
    const entry = catalog.entries.find((candidate) => candidate.guid === record.guid);
    if (entry?.publication === undefined) throw new Error('accepted material publication missing');
    const publicationBefore = JSON.stringify(entry.publication);
    const served = await fetch(new URL(entry.packageUrl, base));
    expect(served.status).toBe(200);
    const pack = await served.json();
    expect(pack).toMatchObject({
      scopeId: accepted.scopeId,
      generation: entry.publication.generation,
      digest: entry.publication.digest,
      outputSetDigest: entry.publication.outputSetDigest,
    });
    const material = pack.assets.find((asset: { guid: string }) => asset.guid === record.guid);
    expect(material.refs).toEqual([]);
    const compact = structuredClone(original);
    for (const program of compact.programs) delete program.artifact.bytes;
    expect(material.payload.cooked).toEqual(compact);
    for (const program of material.payload.cooked.programs) {
      expect(program.artifact).not.toHaveProperty('bytes');
      expect(material.artifacts[program.artifact.path]).toBeDefined();
    }
    expect(JSON.stringify(original)).toBe(originalBefore);
    const afterResponse = await fetch(new URL(accepted.catalogUrl, base));
    expect(afterResponse.status).toBe(200);
    const afterCatalog = (await afterResponse.json()) as { entries: PackIndexEntry[] };
    expect(
      JSON.stringify(afterCatalog.entries.find((row) => row.guid === record.guid)?.publication),
    ).toBe(publicationBefore);

    registry = createAssetRegistry({
      scopeId: accepted.scopeId,
      catalog: createCatalogSource({ entries: catalog.entries }),
      fetcher: (input, init) => fetch(new URL(String(input), base), init),
    });
    decoder = registry.installDecoder(materialContribution.kind, materialContribution.decoder);
    const loaded = await registry.load(record.guid, 'material');
    expect(loaded, JSON.stringify(loaded)).toMatchObject({ ok: true });
    if (!loaded.ok) throw loaded.error;
    expect(validateCookedMaterialRecord(Reflect.get(loaded.value as object, 'cooked'))).toEqual({
      ok: true,
      value: record,
    });
  } finally {
    decoder?.dispose();
    registry?.dispose();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await plugin.closeBundle();
    await rm(root, { recursive: true, force: true });
  }
});
