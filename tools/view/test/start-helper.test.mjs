import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import { launcherProxy } from '../scripts/dev-viewer.mjs';
import {
  defaultHostRoot,
  ensureHost,
  parseArgs,
} from '../skills/forgeax-view-start/scripts/start-view.mjs';

test('startup helper accepts optional G and derives one H from Engine/View identity', () => {
  const without = parseArgs(['--engine', '/engine']);
  const withA = parseArgs(['--engine', '/engine', '--project', '/game-a']);
  const withB = parseArgs(['--engine', '/engine', '--project', '/game-b']);
  assert.equal(without.project, undefined);
  assert.equal(
    defaultHostRoot(withA.engine, withA.view, '/home'),
    defaultHostRoot(withB.engine, withB.view, '/home'),
  );
  assert.notEqual(
    defaultHostRoot('/other-engine', withA.view, '/home'),
    defaultHostRoot(withA.engine, withA.view, '/home'),
  );
  const automatic = parseArgs(['--project', '/game']);
  assert.equal(automatic.engine, join(automatic.view, '../..'));
  assert.equal(automatic.project, '/game');
});

test('managed H stores Engine/View ownership without G and preserves incompatible owners', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'view-start-helper-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = join(root, 'engine');
  const view = join(root, 'view');
  const host = join(root, 'host');
  await mkdir(engine);
  await mkdir(view);
  const markerPath = await ensureHost(host, engine, view, true);
  const bytes = await readFile(markerPath, 'utf8');
  assert.equal(Object.hasOwn(JSON.parse(bytes), 'project'), false);
  assert.equal(await realpath(join(host, 'node_modules/@forgeax/engine')), await realpath(engine));
  await assert.rejects(
    ensureHost(host, join(root, 'foreign-engine'), view, true),
    /another Engine or View/,
  );
  assert.equal(await readFile(markerPath, 'utf8'), bytes);
  // A legacy project field is inert ownership metadata and is not rewritten.
  const legacy = JSON.stringify({ ...JSON.parse(bytes), project: '/legacy-game' });
  await writeFile(markerPath, legacy);
  await ensureHost(host, engine, view, true);
  assert.equal(await readFile(markerPath, 'utf8'), legacy);
  const unmanaged = join(root, 'unmanaged');
  await mkdir(unmanaged);
  await writeFile(join(unmanaged, 'user.txt'), 'preserve');
  await assert.rejects(ensureHost(unmanaged, engine, view, true), /not an empty managed workspace/);
  assert.equal(await readFile(join(unmanaged, 'user.txt'), 'utf8'), 'preserve');
});

test('development launcher proxy translates its own origin and preserves foreign rejection', async (t) => {
  const host = createHttpServer((request, response) => {
    response.statusCode = request.headers.origin === ownerOrigin ? 200 : 403;
    response.end();
  });
  await new Promise((done) => host.listen(0, '127.0.0.1', done));
  const ownerOrigin = `http://127.0.0.1:${host.address().port}`;
  t.after(() => new Promise((done) => host.close(done)));
  const root = await mkdtemp(join(tmpdir(), 'view-dev-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dev = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/__forgeax/view/launch': launcherProxy(ownerOrigin) },
    },
  });
  t.after(() => dev.close());
  await dev.listen();
  const devOrigin = `http://127.0.0.1:${dev.httpServer.address().port}`;
  const request = (origin) =>
    fetch(`${devOrigin}/__forgeax/view/launch`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{}',
    });
  assert.equal((await request(devOrigin)).status, 200);
  assert.equal((await request('http://foreign.example')).status, 403);
});
