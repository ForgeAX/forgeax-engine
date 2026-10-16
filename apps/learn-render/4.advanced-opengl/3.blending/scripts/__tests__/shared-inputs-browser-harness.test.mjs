import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeServer,
  isAlphaShaderReady,
  isTargetShaderUrl,
  isTargetViteHmrUpdate,
  parseViteOrigin,
  pollHttpReady,
  probeFailureRecord,
  assertApplicationBootstrap,
  withServerLifecycle,
  withRestoredFile,
} from '../shared-inputs-browser-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smokeScript = join(here, '..', 'smoke-shared-inputs-browser.mjs');
const viteConfig = join(here, '..', '..', 'vite.config.ts');

test('shared-inputs browser probe uses catalog-only inputs', async () => {
  const source = await readFile(smokeScript, 'utf8');
  assert.match(source, /['"]--catalog-only['"]/);
  assert.match(source, /FORGEAX_SHARED_APP_INPUTS_MODE:\s*['"]catalog-only['"]/);
  assert.match(source, /process\.env\.FORGEAX_SHARED_APP_INPUTS_MODE = ['"]catalog-only['"]/);
});

test('parseViteOrigin strips ANSI address output across port chunks', () => {
  const output = [
    '  Local:   http://127.0.0.1:\u001b[1m45021',
    '\u001b[22m/blending/\u001b[39m\n',
  ].join('');
  assert.equal(parseViteOrigin(output), 'http://127.0.0.1:45021');
  assert.equal(parseViteOrigin('http://127.0.0.1:1/blending/'), 'http://127.0.0.1:1');
  assert.equal(parseViteOrigin('http://localhost:45021/blending/'), null);
  assert.equal(parseViteOrigin('http://127.0.0.1:0/blending/'), null);
  assert.equal(parseViteOrigin('http://127.0.0.1:65536/blending/'), null);
});

test('shader readiness requires the alpha source response to be successful', () => {
  assert.equal(isAlphaShaderReady({ url: 'http://127.0.0.1:45021/src/alpha-test.wgsl', status: 200, ok: true }), true);
  assert.equal(isTargetShaderUrl('http://127.0.0.1:45021/src/alpha-test.wgsl?t=1730000000'), true);
  assert.equal(isTargetShaderUrl('http://127.0.0.1:45021/src/alpha-test.wgsl?direct'), true);
  assert.equal(isAlphaShaderReady({ url: 'http://127.0.0.1:45021/src/alpha-test.wgsl', status: 304, ok: false }), false);
  assert.equal(isAlphaShaderReady({ url: 'http://127.0.0.1:45021/src/other.wgsl', status: 200, ok: true }), false);
  assert.equal(isAlphaShaderReady({ url: 'http://127.0.0.1:45021/src/alpha-test.wgsl', status: 200, ok: true }, 'other.wgsl'), false);
});

test('HMR classifier accepts only target JSON update frames', () => {
  assert.equal(isTargetViteHmrUpdate(JSON.stringify({ type: 'update', updates: [{ path: '/src/alpha-test.wgsl' }] })), true);
  assert.equal(isTargetViteHmrUpdate(JSON.stringify({ type: 'update', updates: [{ acceptedPath: '/src/alpha-test.wgsl' }] })), true);
  assert.equal(isTargetViteHmrUpdate(JSON.stringify({ type: 'update', updates: [{ path: '/src/alpha-test.wgsl?direct' }] })), false);
  assert.equal(isTargetViteHmrUpdate(JSON.stringify({ type: 'custom', updates: [{ path: '/src/alpha-test.wgsl' }] })), false);
  assert.equal(isTargetViteHmrUpdate('alpha-test update'), false);
});

test('browser probes recover bounded hosted WebGPU external Instance loss', async () => {
  const source = await readFile(smokeScript, 'utf8');
  assert.match(source, /A valid external Instance reference no longer exists/);
  assert.match(source, /MAX_BROWSER_RECOVERIES = 2/);
  assert.match(source, /--use-vulkan=swiftshader/);
  assert.doesNotMatch(source, /--disable-vulkan-surface/);
  assert.match(source, /FORGEAX_CHROME_CHANNEL/);
  assert.match(source, /FORGEAX_BROWSER_HEADLESS/);
  assert.match(source, /withBrowserRecovery/);
  assert.match(source, /collectApplicationErrors/);
  assert.match(source, /page\.addInitScript/);
  assert.match(source, /recovery \$\{recoveryCount\}\/\$\{MAX_BROWSER_RECOVERIES\}/);
  assert.match(source, /browser\?\.close\(\)\.catch/);
});

test('CI can inject the immutable shared producer manifest without rebuilding it', async () => {
  const source = await readFile(smokeScript, 'utf8');
  assert.match(source, /process\.env\.FORGEAX_SHARED_APP_INPUTS_MANIFEST/);
  assert.match(source, /if \(injected === undefined\) return buildSharedInputs\(sharedRoot\)/);
  assert.match(source, /parsed\.schemaVersion !== 1/);
});

test('blending pack roots include local Pack assets and shared texture sidecars', async () => {
  const source = await readFile(viteConfig, 'utf8');
  for (const file of ['metal.png.meta.json', 'marble.jpg.meta.json', 'grass.png.meta.json', 'window.png.meta.json']) {
    assert.match(source, new RegExp(file.replaceAll('.', '\\.'), 'u'));
  }
  assert.match(source, /roots:\s*learnOpenGlTextureRoots/u);
  assert.doesNotMatch(source, /['"]meshes['"]/u);
});

test('application bootstrap rejects structured application errors', () => {
  assert.throws(
    () => assertApplicationBootstrap(['CONSOLE-ERR: [learn-render] createApp failed: manifest-malformed'], 'http://127.0.0.1:43123/blending/'),
    (error) => error.stage === 'application-bootstrap' && error.actual.includes('manifest-malformed'),
  );
  assert.doesNotThrow(() => assertApplicationBootstrap([], 'http://127.0.0.1:43123/blending/'));
});

test('known probe failures expose a stable machine-readable record', async () => {
  const error = new (class extends Error {})();
  assert.equal(probeFailureRecord(error), null);
  await assert.rejects(
    pollHttpReady('http://127.0.0.1:1/blending/', {
      deadlineMs: 20,
      intervalMs: 2,
      fetchImpl: async () => ({ ok: false, status: 503 }),
      stage: 'preview-readiness',
    }),
    (failure) => {
      assert.deepEqual(probeFailureRecord(failure), {
      code: 'shared-input-browser-preview-readiness',
      stage: 'preview-readiness',
      url: 'http://127.0.0.1:1/blending/',
      expected: 'HTTP 2xx before deadline',
      actual: 503,
      hint: 'Check the server root/base and verify HTTP readiness rather than stdout markers.',
      detail: '',
      });
      return true;
    },
  );
});

test('readiness uses HTTP and closes server when deadline expires', async () => {
  let closed = 0;
  await assert.rejects(
    pollHttpReady('http://127.0.0.1:1/blending/', {
      deadlineMs: 20,
      intervalMs: 2,
      fetchImpl: async () => ({ ok: false, status: 503 }),
      stage: 'preview-readiness',
    }),
    (error) => error.stage === 'preview-readiness' && error.hint.includes('HTTP'),
  );
  await withServerLifecycle(
    Promise.resolve({ close: async () => { closed += 1; } }),
    async () => { throw new Error('assertion'); },
  ).catch(() => {});
  assert.equal(closed, 1);
});

test('server close drains HMR sockets and HTTP connections before awaiting Vite', async () => {
  const calls = [];
  await closeServer({
    close: async () => { calls.push('vite'); },
    ws: { close: () => calls.push('ws') },
    httpServer: {
      closeAllConnections: () => calls.push('all-connections'),
      closeIdleConnections: () => calls.push('idle-connections'),
      close: () => calls.push('http'),
    },
  });
  assert.deepEqual(calls, ['ws', 'all-connections', 'idle-connections', 'vite', 'http']);
});

test('preview and dev lifecycles use disposable Vite child processes', async () => {
  const source = await readFile(new URL('../shared-inputs-browser-harness.mjs', import.meta.url), 'utf8');
  assert.match(source, /spawn\(process\.execPath, command/);
  assert.match(source, /mode === 'preview' \? \[viteCli, 'preview'\] : \[viteCli\]/);
  assert.match(source, /new URL\('\.\/cli\.js', import\.meta\.resolve\('vite'\)\)/);
  assert.match(source, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(source, /child\.kill\('SIGTERM'\)/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
  assert.match(source, /stripVTControlCharacters/);
  assert.match(source, /parseViteOrigin/);
  assert.match(source, /disposeOutput/);
  assert.match(source, /reapChild/);
});

test('occupied fixed port does not affect lifecycle when server allocates its own port', async () => {
  let closed = false;
  const result = await withServerLifecycle(
    Promise.resolve({
      origin: 'http://127.0.0.1:43123',
      close: async () => { closed = true; },
    }),
    async (server) => server.origin,
  );
  assert.equal(result, 'http://127.0.0.1:43123');
  assert.equal(closed, true);
});

test('child Vite lifecycle is reaped after the browser probe', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  };
  await withServerLifecycle(
    Promise.resolve({ process: child, origin: 'http://127.0.0.1:43123' }),
    async (server) => server.origin,
  );
  assert.equal(child.signalCode, 'SIGTERM');
});

test('assertion failures and HMR failures restore shader source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-harness-test-'));
  const file = join(root, 'alpha-test.wgsl');
  await writeFile(file, 'const alpha = 0.1;');
  try {
    await assert.rejects(withRestoredFile(file, async () => {
      await writeFile(file, 'const alpha = 0.2;');
      throw Object.assign(new Error('hmr timeout'), { stage: 'custom-shader-hmr' });
    }));
    assert.equal(await readFile(file, 'utf8'), 'const alpha = 0.1;');
  } finally {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }));
  }
});
