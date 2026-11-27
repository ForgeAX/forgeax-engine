import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeCatalogWire,
  decodeMaterialProgramWire,
  serializeCookedMaterialRecord,
} from '@forgeax/engine-pack';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { MaterialAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication.js';
import { AssetRegistry, createCatalogSource } from '../../../assets-runtime/src/index.js';
import { runtimeAssets } from '../../../assets-runtime/src/internal/runtime-assets.js';
import { materialContribution } from '../../../render/src/assets/asset-decoders.js';
import { createPluginPackInternal } from '../plugin-pack.js';
import { installPackAuthorDependencies } from './pack-author-dependencies.js';
import { packHttpFixture } from './vite-fixtures.js';

it.each([
  'direct',
  'dynamic',
] as const)('omits only external shader bytes in the final served %s DEV Pack and restores the complete material', async (format) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-dev-material-transport-'));
  if (format === 'dynamic') await installPackAuthorDependencies(root);
  const packageId = '019f0000-0000-7000-8000-000000000702';
  const parsedPackage = PackageId.parse(packageId);
  if (!parsedPackage.ok) throw parsedPackage.error;
  const guid = AssetGuid.format(AssetGuid.derive(parsedPackage.value, 'material/main'));
  const record = materialRecordFixture({ guid, generation: 1 });
  const original = JSON.parse(serializeCookedMaterialRecord(record));
  const originalBefore = JSON.stringify(original);
  const sourcePath = join(root, format === 'dynamic' ? 'material.pack.ts' : 'material.pack.json');
  const authored = {
    schemaVersion: '3.0.0',
    packageId,
    assets: {
      'material/main': {
        kind: 'material',
        payload: { kind: 'material', ...record.resolved },
        refs: [],
      },
    },
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
  const http = packHttpFixture(plugin);
  let registry: AssetRegistry | undefined;
  let decoder: ReturnType<AssetRegistry['installDecoder']> | undefined;
  try {
    const { base, accepted } = await http.listen(root, 'dev-material-transport');
    const catalogResponse = await fetch(new URL(accepted.catalogUrl, base));
    expect(catalogResponse.status).toBe(200);
    const catalog = decodeCatalogWire(await catalogResponse.json()).unwrap();
    const entry = catalog.find((candidate) => candidate.guid === record.guid);
    if (entry?.publication === undefined) throw new Error('accepted material publication missing');
    const publicationBefore = JSON.stringify(entry.publication);
    const served = await fetch(new URL(entry.packageUrl, base));
    expect(served.status).toBe(200);
    // Shared program ABIs travel interned; the document under test is the decoded Pack.
    const pack = decodeMaterialProgramWire(await served.json()).unwrap();
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
    const afterCatalog = decodeCatalogWire(await afterResponse.json()).unwrap();
    expect(JSON.stringify(afterCatalog.find((row) => row.guid === record.guid)?.publication)).toBe(
      publicationBefore,
    );

    registry = new AssetRegistry({
      scopeId: accepted.scopeId,
      catalog: createCatalogSource({ entries: catalog }),
      fetcher: (input, init) => fetch(new URL(String(input), base), init),
    });
    decoder = registry.installDecoder(materialContribution.kind, materialContribution.decoder);
    const loaded = await registry.load(record.guid, 'material');
    expect(loaded, JSON.stringify(loaded)).toMatchObject({ ok: true });
    if (!loaded.ok) throw loaded.error;
    const payload = registry.read(loaded.value).unwrap();
    expect(payload).not.toHaveProperty('cooked');
    expect(
      registry.getMaterialProjectionForPayload(
        runtimeAssets(registry).borrow<MaterialAsset>(loaded.value).unwrap(),
      ),
    ).toMatchObject({
      materialGuid: record.guid,
      specializationKey: record.specializationKey,
      artifactHash: record.artifactDigest,
    });
    for (const program of record.programs)
      expect(registry.shaderRegistry.findMaterialArtifact(program.specializationKey)).toMatchObject(
        {
          ok: true,
          value: { source: new TextDecoder().decode(program.artifact.bytes) },
        },
      );
  } finally {
    decoder?.dispose();
    registry?.dispose();
    await http.close();
    await rm(root, { recursive: true, force: true });
  }
});
