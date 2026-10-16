import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSphereGeometry } from '@forgeax/engine-geometry';
import { meshAssetOutputProducer } from '@forgeax/engine-import';
import { generateMeshLods } from '@forgeax/engine-import/mesh-lod-generator';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Materials } from '@forgeax/engine-render';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
export async function startGeneratedLodServer() {
  const guids = [0, 1, 2].map((i) => `019f0000-0000-7000-8000-0000000006${i}1`);
  const parsed = guids.map((text) => {
    const result = AssetGuid.parse(text);
    if (!result.ok) throw result.error;
    return result.value;
  });
  const source = createSphereGeometry(1, 64, 32).unwrap();
  const started = performance.now();
  const generated = (
    await generateMeshLods(source, {
      maxError: 0.02,
      levels: [
        { mesh: required(parsed[1]), triangleRatio: 0.5, screenCoverage: 0.5 },
        { mesh: required(parsed[2]), triangleRatio: 0.25, screenCoverage: 0.45 },
      ],
    })
  ).unwrap();
  const productionMs = performance.now() - started;
  const routes = new Map<string, Uint8Array>();
  const assets = [];
  for (const [i, asset] of [generated.root, ...generated.meshes].entries()) {
    const product = (
      await meshAssetOutputProducer.produce({
        guid: required(guids[i]),
        sourceKey: `sphere/lod${i}`,
        asset,
      })
    ).unwrap();
    const body = required(product.artifacts.body);
    const path = `lod${i}.bin`;
    routes.set(`/${path}`, body.bytes);
    assets.push({
      guid: guids[i],
      kind: 'mesh',
      payload: {},
      refs: product.refs.map((reference) => reference.guid),
      artifacts: {
        body: {
          path,
          mediaType: body.mediaType,
          assetCodec: body.assetCodec,
          byteLength: body.bytes.byteLength,
          integrity: {
            algorithm: 'sha256',
            digest: `sha256:${createHash('sha256').update(body.bytes).digest('hex')}`,
          },
        },
      },
    });
  }
  const materialGuid = '019f0000-0000-7000-8000-000000000641';
  const cooked = await createMaterialPackCooker([
    fileURLToPath(new URL('../../../shader/src/', import.meta.url)),
  ]).cook({
    guid: materialGuid,
    source: Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.8 }),
  });
  const encode = (value: unknown) =>
    new TextEncoder().encode(
      JSON.stringify(value, (_key, item) => (item instanceof Uint8Array ? [...item] : item)),
    );
  routes.set(
    '/material.pack.json',
    encode({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: materialGuid, kind: 'material', payload: cooked.payload, refs: [], artifacts: {} },
      ],
    }),
  );
  routes.set(
    '/mesh.pack.json',
    encode({ schemaVersion: '2.0.0', kind: 'internal-text-package', assets }),
  );
  routes.set(
    '/pack-index.json',
    encode([
      ...guids.map((guid) => ({ guid, kind: 'mesh', packageUrl: '/mesh.pack.json' })),
      { guid: materialGuid, kind: 'material', packageUrl: '/material.pack.json' },
    ]),
  );
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    const path = request.url ?? '';
    const body = routes.get(path);
    if (!body) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader(
      'Content-Type',
      path.endsWith('.bin') ? 'application/octet-stream' : 'application/json',
    );
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP port');
  return {
    url: `http://127.0.0.1:${address.port}/pack-index.json`,
    guids,
    materialGuid,
    productionMs,
    reports: generated.reports,
    triangleCounts: [
      required(source.indices).length / 3,
      ...generated.reports.map((r) => r.triangleCount),
    ],
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
const servers = new Map<string, Awaited<ReturnType<typeof startGeneratedLodServer>>>();
export const generatedLodCommands = {
  async startGeneratedLod(_context: unknown) {
    const server = await startGeneratedLodServer();
    servers.set(server.url, server);
    const { close: _, ...facts } = server;
    return facts;
  },
  async stopGeneratedLod(_context: unknown, url: string) {
    const server = servers.get(url);
    servers.delete(url);
    await server?.close();
  },
};

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
