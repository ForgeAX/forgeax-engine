import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { AssetRegistry } from '../../../packages/assets-runtime/dist/index.mjs';
import { packMeshBin } from '../../../packages/geometry/dist/index.mjs';
import { gltfImporter } from '../../../packages/gltf/dist/importer-entry.mjs';
import { decodeImageForImport } from '../../../packages/image/dist/image-importer.mjs';
import {
  ImporterRegistry,
  projectImportProductForBuild,
  runImport,
} from '../../../packages/import/dist/index.mjs';
import { finalizePackageProduct } from '../../../packages/pack/dist/build.mjs';
import {
  createShaderModuleImmediate,
  rhi as nullRhi,
} from '../../../packages/rhi-null/dist/index.mjs';
import { ShaderRegistry } from '../../../packages/shader/dist/index.mjs';

const source = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const settings = {
  resolution: Number(process.argv[4] ?? 16),
  maxCards: Number(process.argv[5] ?? 24),
};
assert(
  Number.isInteger(settings.resolution) && settings.resolution >= 8 && settings.resolution <= 32,
);
assert(Number.isInteger(settings.maxCards) && settings.maxCards >= 1 && settings.maxCards <= 64);
await mkdir(output, { recursive: true });
const metaBytes = await readFile(`${source}.meta.json`);
const meta = JSON.parse(metaBytes);
const registry = new ImporterRegistry();
registry.register(gltfImporter);
const start = performance.now();
const imported = await runImport(
  {
    ...meta,
    buildPack: false,
    source,
    importSettings: { ...meta.importSettings, meshCards: settings },
  },
  registry,
  {
    readSource: async (path) => ({ ok: true, value: new Uint8Array(await readFile(path)) }),
    decodeImage: decodeImageForImport,
  },
);
assert(imported.ok, JSON.stringify(imported.error));
assert(!('skipped' in imported.value));
const importMs = performance.now() - start;
const { product } = imported.value;
const pack = projectImportProductForBuild(product);
const served = new Map(),
  requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  const value = served.get(request.url);
  response.statusCode = value === undefined ? 404 : 200;
  response.end(value);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const finalized = await finalizePackageProduct(
    {
      assets: pack.assets,
      receipts: product.receipts,
      diagnostics: product.diagnostics,
      sourceRevision: product.sourceRevision,
    },
    {
      base: '/',
      packagePath: 'scene.pack.json',
      artifactPath: (guid, key) => `bodies/${guid}/${key}`,
      sink: async (path, bytes) => {
        const url = new URL(path, `${base}/`);
        served.set(url.pathname, bytes);
        const target = resolve(output, `.${url.pathname}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
      },
    },
  );
  assert(finalized.ok, JSON.stringify(finalized.error));
  const catalog = finalized.value.pack.assets.map((row) => ({
    guid: row.guid,
    kind: row.kind,
    packageUrl: `${base}/scene.pack.json`,
  }));
  served.set('/pack-index.json', Buffer.from(JSON.stringify(catalog)));
  const device = (await (await nullRhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const runtime = new AssetRegistry(
    new ShaderRegistry({
      device: { createShaderModule: (desc) => createShaderModuleImmediate(device, desc) },
      manifestUrl: '',
    }),
  );
  runtime.configurePackIndex(`${base}/pack-index.json`);
  const meshes = [];
  const loadStart = performance.now();
  for (const row of pack.assets.filter((row) => row.kind === 'mesh')) {
    const loaded = await runtime.loadByGuid(runtime.parseGuid(row.guid));
    assert(loaded.ok, JSON.stringify(loaded.error));
    const mesh = loaded.value;
    assert.equal(mesh.kind, 'mesh');
    assert(mesh.cardLayout !== undefined);
    const { cardLayout, ...withoutCards } = mesh;
    const baseline = packMeshBin(withoutCards, row.guid, row.refs).unwrap();
    const rebuilt = packMeshBin(mesh, row.guid, row.refs).unwrap();
    assert.deepEqual(rebuilt, row.artifacts.body.bytes);
    meshes.push({
      guid: row.guid,
      sections: mesh.submeshes.length,
      triangles: (mesh.indices?.length ?? mesh.attributes.position.length / 3) / 3,
      bytes: rebuilt.byteLength,
      withoutCardBytes: baseline.byteLength,
      addedBytes: rebuilt.byteLength - baseline.byteLength,
      cards: cardLayout.cards.length,
      layout: cardLayout,
      sectionsEvidence: mesh.submeshes.map((section, index) => ({
        index,
        materialSlot: section.materialSlot,
      })),
    });
  }
  const report = {
    scope:
      'Full glTF importer and image decoder, shared package finalizer, real HTTP Catalog -> Pack -> body -> loadByGuid; mesh byte round trip. Material program cooking and GPU capture are separate evidence.',
    sourceSha256: createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
    metaSha256: createHash('sha256').update(metaBytes).digest('hex'),
    settings,
    importMs,
    meshLoadAndRepackMs: performance.now() - loadStart,
    peakRssKiB: process.resourceUsage().maxRSS,
    assets: pack.assets.length,
    meshes,
    requests,
  };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      { ...report, meshes: meshes.map(({ sectionsEvidence, ...mesh }) => mesh) },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
