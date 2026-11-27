// Real local browser entry; production content is cooked before serving consumer requests.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
  buildEngineShaderManifest,
  buildEngineShaderTemplateManifest,
} from '../../packages/vite-plugin-shader/dist/index.mjs';
import { createLevelStreamingPack } from './fixtures/level-streaming-pack.mjs';
import { createWorldPack } from './fixtures/level-streaming-world-pack.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const output = resolve(process.argv[2] ?? '/tmp/forgeax-level-runtime-browser-20261118.json');
if (output === root || output.startsWith(`${root}/`))
  throw Error('raw measurements must stay outside checkout');
const profileText = await readFile(
  new URL('./level-streaming-profile.json', import.meta.url),
  'utf8',
);
const profile = JSON.parse(profileText);
let fixture;
let playFixture;
let origin;
const playHtml = await readFile(new URL('./level-streaming-world.html', import.meta.url));
// Static distribution serves the same immutable manifest to both Workers.
// Serialize it before App startup so concurrent consumers do not make the
// preview host repeatedly encode the full fleet on its request loop.
const shaders = Buffer.from(JSON.stringify(await buildEngineShaderManifest()));
const playShaders = Buffer.from(JSON.stringify(await buildEngineShaderTemplateManifest()));
const hostLoad = () => ({ load: os.loadavg(), freeMemoryBytes: os.freemem() });
const hostIdentity = {
  cpu: os.cpus()[0]?.model,
  os: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
  profileSha256: createHash('sha256').update(profileText).digest('hex'),
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceStatus: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
};
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Level streaming M1 qualification</title>
<style>body{margin:24px;background:#17191e;color:#e5e8ef;font:15px system-ui}button{padding:10px 18px}canvas{display:block;width:1280px;height:720px;margin-top:16px;background:#000}pre{white-space:pre-wrap}</style>
<h1>Level streaming M1</h1><p>Original content, quality and budgets. Results remain unqualified until every gate passes.</p>
<button>Run original M1 workload</button><pre id="status">Ready. The full workload can take several minutes.</pre>
<canvas width="1280" height="720"></canvas><script type="module" src="/scripts/bench/level-streaming-browser.mjs"></script></html>`;
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};
function json(response, value, status = 200) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}
async function serveCatalog(response, { producer }) {
  json(response, {
    schemaVersion: 'runtime-catalog-snapshot-v1',
    ...producer.catalog.expectedScope,
    authority: 'authoritative',
    entries: (await producer.catalog.enumerate()).unwrap(),
  });
}
async function serveCooked(response, { producer }, uri) {
  const content = await producer.fetch(uri);
  response.statusCode = content.status;
  response.setHeader(
    'Content-Type',
    content.headers.get('Content-Type') ?? 'application/octet-stream',
  );
  response.end(new Uint8Array(await content.arrayBuffer()));
}
async function routePlay(url, response) {
  const path = url.pathname;
  playFixture ??= createWorldPack(`${origin}/__level/play/cooked/`).catch((error) => {
    playFixture = undefined;
    throw error;
  });
  const basin = await playFixture;
  if (path === '/__level/play/fixture') {
    json(response, {
      manifest: basin.manifest,
      wildlife: basin.wildlife,
      expectedScope: basin.producer.catalog.expectedScope,
      catalogUrl: `${origin}/__level/play/catalog`,
    });
    return;
  }
  if (path === '/__level/play/catalog') {
    await serveCatalog(response, basin);
    return;
  }
  if (path.startsWith('/__level/play/cooked/')) {
    await serveCooked(response, basin, new URL(url.pathname + url.search, origin).href);
    return;
  }
  json(response, { error: 'unknown measurement route' }, 404);
}

async function route(request, response, next) {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/__level')) return next();
  for (const [name, value] of Object.entries(isolationHeaders)) response.setHeader(name, value);
  const path = url.pathname;
  if (['/__level', '/__level/', '/__level/play', '/__level/play/'].includes(path)) {
    response.setHeader('Content-Type', 'text/html');
    response.end(playHtml);
    return;
  }
  if (path === '/__level/benchmark' || path === '/__level/benchmark/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(html);
    return;
  }
  if (path === '/__level/shaders' || path === '/__level/play/shaders') {
    const manifest = path === '/__level/play/shaders' ? playShaders : shaders;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', manifest.byteLength);
    response.end(manifest);
    return;
  }
  if (path.startsWith('/__level/play/')) return routePlay(url, response);
  if (url.pathname === '/__level/fixture') {
    const entries = (await fixture.producer.catalog.enumerate()).unwrap();
    json(response, {
      profile,
      entries,
      rootGuid: fixture.rootGuid,
      producer: fixture.facts,
      expectedScope: fixture.producer.catalog.expectedScope,
      catalogUrl: `${origin}/__level/catalog`,
      hostIdentity: { ...hostIdentity, hostBefore: hostLoad() },
    });
    return;
  }
  if (url.pathname === '/__level/catalog') {
    await serveCatalog(response, fixture);
    return;
  }
  if (url.pathname === '/__level/package' || url.pathname.startsWith('/__level/cooked/')) {
    const uri =
      url.pathname === '/__level/package'
        ? url.searchParams.get('uri')
        : new URL(request.url, origin).href;
    if (uri === null) {
      json(response, { error: 'missing exact producer URI' }, 400);
      return;
    }
    await serveCooked(response, fixture, uri);
    return;
  }
  if (url.pathname === '/__level/result' && request.method === 'POST') {
    const hostAfter = hostLoad();
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.byteLength;
      if (bytes > 128 * 1024 * 1024) throw Error('measurement response exceeds 128 MiB');
      chunks.push(chunk);
    }
    const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    report.identity.hostAfter = hostAfter;
    await writeFile(output, JSON.stringify(report, null, 2));
    json(response, { path: output, qualified: report.qualified });
    return;
  }
  json(response, { error: 'unknown measurement route' }, 404);
}
const server = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: {
    host: '127.0.0.1',
    port: 0,
    watch: null,
    headers: isolationHeaders,
  },
  plugins: [
    {
      name: 'level-streaming-runtime-preview',
      configureServer(instance) {
        instance.middlewares.use((request, response, next) => {
          void route(request, response, next).catch((cause) =>
            json(response, { error: cause.message }, 500),
          );
        });
      },
    },
  ],
});
await server.listen();
origin = `http://127.0.0.1:${server.httpServer.address().port}`;
try {
  fixture = await createLevelStreamingPack(profile, {
    withInstances: process.argv.includes('--with-instances'),
    baseUrl: `${origin}/__level/cooked/`,
  });
} catch (cause) {
  await server.close();
  throw cause;
}
console.log(
  JSON.stringify({
    url: `${origin}/__level/benchmark/`,
    playUrl: `${origin}/__level/`,
    output,
    profileSha256: hostIdentity.profileSha256,
  }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  await fixture.producer.dispose();
  const basin = await playFixture;
  await basin?.producer.dispose();
}
process.on('SIGINT', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
