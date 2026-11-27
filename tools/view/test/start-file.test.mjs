import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { defaultBackendRoot, parseArgs, resolveStartup } from '../start.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'view-file-start-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const engine = join(root, 'node_modules/@forgeax/engine');
  const view = join(root, 'node_modules/@forgeax/view');
  await mkdir(engine, { recursive: true });
  await mkdir(join(view, 'dist/modules'), { recursive: true });
  await mkdir(join(view, 'dist/viewer'), { recursive: true });
  await writeFile(
    join(engine, 'package.json'),
    JSON.stringify({
      name: '@forgeax/engine',
      version: '0.5.2',
      type: 'module',
      exports: { './package.json': './package.json', './*': { import: './*.mjs' } },
    }),
  );
  await writeFile(join(view, 'package.json'), '{"name":"@forgeax/view","type":"module"}');
  await writeFile(join(view, 'host.pack.json'), '{}');
  await writeFile(
    join(view, 'start.mjs'),
    await readFile(new URL('../start.mjs', import.meta.url)),
  );
  await writeFile(join(view, 'dist/viewer/index.html'), '<!doctype html><title>View</title>');
  await build({
    entryPoints: [fileURLToPath(new URL('../src/view-service.ts', import.meta.url))],
    outfile: join(view, 'dist/modules/service.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  });
  await writeFile(
    join(engine, 'devkit.mjs'),
    `
    export const calls = [];
    export async function ensureDevKitView(root, options) {
      calls.push({root, options});
      return {ok:false,error:{code:'fixture-offline',hint:'retained offline Shell'}};
    }
  `,
  );
  return { root, engine, view };
}

test('the View entry parses project and instance intent without Engine CLI flags', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['--project', '/game', '--new-instance']), {
    project: '/game',
    newInstance: true,
  });
  assert.throws(() => parseArgs(['--project']), /requires a directory/);
  assert.throws(() => parseArgs(['--host-pack', '/pack']), /Unknown option/);
});

test('default startup shares an installation root and independent instances allocate temporary roots', async (t) => {
  const { engine, view } = await fixture(t);
  const a = await resolveStartup({ viewRoot: view, project: '/game-a' });
  const b = await resolveStartup({ viewRoot: view, project: '/game-b' });
  assert.equal(a.root, b.root);
  assert.equal(a.root, defaultBackendRoot(engine, view));
  assert.notEqual(a.root, engine);
  assert.notEqual(a.root, process.cwd());
  const independent = await resolveStartup({ viewRoot: view, newInstance: true });
  t.after(() => rm(independent.root, { recursive: true, force: true }));
  assert.notEqual(independent.root, a.root);
  assert.equal(dirname(independent.root), join(tmpdir(), 'forgeax/view-instances'));
  assert.equal(
    (await resolveStartup({ viewRoot: view, newInstance: true, root: a.root })).root,
    a.root,
  );
});

test('the View file starts a retained HTTP presentation directly with its installed Engine API', async (t) => {
  const { engine, view } = await fixture(t);
  const options = await resolveStartup({ viewRoot: view });
  assert.equal(options.enginePackage, engine);
  const entry = await import(pathToFileURL(join(view, 'start.mjs')).href);
  const service = await entry.startView({ project: '/game' });
  t.after(service.close);
  assert.equal(service.enginePackage, engine);
  assert.equal(service.viewRoot, view);
  assert.equal(service.project, '/game');
  const api = await import(pathToFileURL(join(engine, 'devkit.mjs')).href);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].root, options.root);
  assert.equal(api.calls[0].options.project, '/game');
  assert.equal(api.calls[0].options.hostPack, join(view, 'host.pack.json'));
  assert.equal((await fetch(service.url)).status, 200);
  const bootstrap = await (await fetch(new URL('/__forgeax/view/bootstrap', service.url))).json();
  assert.equal(bootstrap.phase, 'offline');
  assert.equal(bootstrap.launcher, true);
  assert.equal(bootstrap.frontendConfig.engineVersion, '0.5.2');
  await service.close();
  assert.equal(api.calls[0].options.signal.aborted, true);
  assert.equal(await readFile(join(view, 'host.pack.json'), 'utf8'), '{}');
});

test('an incomplete installation names the missing output before allocating a Backend workspace', async (t) => {
  const { view, root } = await fixture(t);
  await rm(join(view, 'dist/modules/service.mjs'));
  const backend = join(root, 'must-not-be-created');
  await assert.rejects(resolveStartup({ viewRoot: view, root: backend }), (error) => {
    assert.equal(error.code, 'view-installation-incomplete');
    assert.match(error.message, /service\.mjs/);
    assert.match(error.message, /complete matching SDK/);
    return true;
  });
  await assert.rejects(realpath(backend), { code: 'ENOENT' });
});

test('SDK file startup bootstraps and uses the SDK runtime independently of the game', async (t) => {
  const { root, engine, view } = await fixture(t);
  const sdkView = join(root, 'sdk/tools/view');
  const game = join(root, 'game');
  await mkdir(join(game, 'node_modules/@forgeax/engine'), { recursive: true });
  await writeFile(join(game, 'node_modules/@forgeax/engine/package.json'),
    '{"name":"@forgeax/engine","version":"9.9.9"}');
  await mkdir(sdkView, { recursive: true });
  await mkdir(join(root, 'sdk/bin'), { recursive: true });
  await writeFile(join(root, 'sdk/sdk-manifest.json'), '{"sdkVersion":"1.2.3"}');
  await writeFile(
    join(root, 'sdk/bin/forgeax.mjs'),
    `export async function ensureSdkRuntime() {
      return ${JSON.stringify(root)};
    }`,
  );
  await writeFile(
    join(sdkView, 'start.mjs'),
    await readFile(new URL('../start.mjs', import.meta.url)),
  );
  const entry = await import(pathToFileURL(join(sdkView, 'start.mjs')).href);
  const service = await entry.startView({ project: game });
  t.after(service.close);
  assert.equal(service.enginePackage, engine);
  assert.equal(service.viewRoot, view);
  assert.equal(service.project, game);
  const api = await import(pathToFileURL(join(engine, 'devkit.mjs')).href);
  assert.equal(api.calls[0].options.hostPack, join(view, 'host.pack.json'));
  assert.equal((await fetch(service.url)).status, 200);
  const bootstrap = await (await fetch(new URL('/__forgeax/view/bootstrap', service.url))).json();
  assert.equal(bootstrap.frontendConfig.engineVersion, '0.5.2');
});
