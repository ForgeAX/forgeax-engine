import { createServer } from 'node:http';
import { createLevelStreamingPack } from '../../../scripts/bench/fixtures/level-streaming-pack.mjs';

const fixtures = new Map();

export async function openLevelRuntimeFixture() {
  let fixture;
  let rows;
  let origin;
  let acknowledgeDownload;
  let releaseDownload;
  const downloading = new Promise((resolve) => { acknowledgeDownload = resolve; });
  const holdDownload = new Promise((resolve) => { releaseDownload = resolve; });
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    try {
      if (request.url === '/catalog') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          schemaVersion: 'runtime-catalog-snapshot-v1',
          ...fixture.producer.catalog.expectedScope,
          authority: 'authoritative',
          entries: rows,
        }));
        return;
      }
      acknowledgeDownload();
      await holdDownload;
      const resource = await fixture.producer.fetch(new URL(request.url, origin).href);
      response.statusCode = resource.status;
      response.setHeader('Content-Type', resource.headers.get('Content-Type') ?? 'application/octet-stream');
      response.end(new Uint8Array(await resource.arrayBuffer()));
    } catch (cause) {
      response.statusCode = 500;
      response.end(String(cause));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    releaseDownload();
    await new Promise((resolve) => server.close(resolve));
    await fixture?.producer.dispose();
  };
  try {
    fixture = await createLevelStreamingPack({
      streetBlock: {
        meshEntities: 4,
        meshAssets: 1,
        materialAssets: 1,
        textureAssets: 1,
        textureExtent: [32, 32],
        maskedEntities: 0,
        hierarchyDepth: 4,
        nestedInstances: 1,
        colliders: { cuboid: 2 },
      },
    }, { baseUrl: `${origin}/` });
    rows = (await fixture.producer.catalog.enumerate()).unwrap();
  } catch (cause) {
    await close();
    throw cause;
  }
  fixtures.set(origin, { close, downloading, releaseDownload });
  return {
    origin,
    catalog: `${origin}/catalog`,
    rootGuid: fixture.rootGuid,
    scope: fixture.producer.catalog.expectedScope,
  };
}

export async function closeLevelRuntimeFixture(origin) {
  const fixture = fixtures.get(origin);
  fixtures.delete(origin);
  await fixture?.close();
}

export async function waitForLevelRuntimeDownload(origin) {
  const fixture = fixtures.get(origin);
  if (!fixture) throw Error('Unknown cooked Level fixture');
  let timer;
  try {
    await Promise.race([
      fixture.downloading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Cooked Pack had no runtime download')), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function releaseLevelRuntimeDownload(origin) {
  fixtures.get(origin)?.releaseDownload();
}
