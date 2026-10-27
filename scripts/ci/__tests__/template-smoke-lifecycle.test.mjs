import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { serializeBrowserConsoleValue } from '../../../apps/preview/scripts/serialize-browser-console-value.mjs';

const source = readFileSync(
  new URL('../../../apps/preview/scripts/smoke-templates.mjs', import.meta.url),
  'utf8',
);
function functionSource(start, end) {
  assert.ok(source.includes(start) && source.includes(end));
  return source.slice(source.indexOf(start), source.indexOf(end));
}

test('template console admission rejects camera-free errors and admits only explicit fault injections', () => {
  const evidence = {
    consoleErrors: ['render-system-no-camera', 'unexpected device failure', 'injected failure'],
    expectedConsoleErrors: ['injected failure'],
  };
  const unexpected = runInNewContext(
    `${functionSource('function unexpectedConsoleErrors(', 'async function closeSmokeBrowser(')}; unexpectedConsoleErrors(evidence);`,
    { evidence },
  );
  assert.deepEqual(Array.from(unexpected), [
    'render-system-no-camera',
    'unexpected device failure',
  ]);
});

test('template readiness bounds startup and GPU completion independently and rejects stalls', async () => {
  for (const outcome of ['completed', 'startup-stalled', 'gpu-stalled']) {
    const waits = [];
    const canvas = {
      width: 320,
      height: 180,
      forgeaxFrameProgress: { submitted: { frameId: 2 } },
    };
    const scope = {
      TEMPLATE_SETTLE_FRAMES: 1,
      document: {
        querySelector: () => canvas,
      },
      __forgeaxPreviewInspection:
        outcome === 'startup-stalled'
          ? undefined
          : {
              renderer: { health: () => ({ reason: 'alive' }) },
            },
      requestAnimationFrame: (callback) => queueMicrotask(callback),
      page: {
        waitForFunction: async (predicate, argument, options) => {
          waits.push({ argument, options });
          if (argument.requireCompletedFrame && outcome === 'completed')
            canvas.forgeaxFrameProgress = {
              ...canvas.forgeaxFrameProgress,
              completed: { frameId: 1 },
            };
          if (!predicate(argument)) throw new Error('bounded readiness timeout');
        },
        evaluate: async (operation, argument) => operation(argument),
      },
    };
    const run = runInNewContext(
      `${functionSource('async function waitForTemplateReady(', 'async function diagnoseTemplateReadyFailure(')}; waitForTemplateReady();`,
      scope,
    );
    if (outcome === 'completed') await run;
    else await assert.rejects(run, /bounded readiness timeout/);
    assert.deepEqual(
      waits.map(({ argument }) => argument.requireCompletedFrame),
      outcome === 'startup-stalled' ? [false] : [false, true],
    );
    for (const { options } of waits) assert.equal(options.timeout, 30_000);
  }
});

test('Preview prepares outside admission and retires each native browser before release', async () => {
  const start = source.indexOf('    startServer(template.slug);');
  const end = source.indexOf('    if (templateSmokeRoot !== undefined)', start);
  assert.ok(start >= 0 && end > start);
  const phase = source.slice(start, end);
  for (const admitted of [true, false]) {
    for (const failureMode of ['none', 'body', 'close', 'both']) {
      let held = false;
      const events = [];
      const bodyError = new Error('native body failed');
      const closeError = new Error('owned browser close failed');
      const native = () => assert.equal(held, admitted, 'the native owner must be admitted');
      const scope = {
        process: { env: admitted ? { FORGEAX_LOCAL_GPU_LEASE: '1' } : {} },
        template: { slug: 'game-capability-lab', id: 'lab', name: 'Lab' },
        evidence: {},
        console: { log() {} },
        startServer: () => {
          assert.equal(held, false);
          events.push('prepare');
        },
        waitForServerReady: async () => {
          assert.equal(held, false);
          events.push('ready');
        },
        restartSmokeBrowser: async () => {
          native();
          events.push('launch');
        },
        smokeTemplate: async () => {
          native();
          events.push('body');
          if (failureMode === 'body' || failureMode === 'both') throw bodyError;
        },
        closeSmokeBrowser: async () => {
          await Promise.resolve();
          native();
          events.push('close');
          if (failureMode === 'close' || failureMode === 'both') throw closeError;
        },
        stopServer: async () => {
          assert.equal(held, false);
          events.push('stop');
        },
        withLocalGpuLease: async (run, options) => {
          assert.equal(options.label, 'Preview template game-capability-lab');
          held = true;
          events.push('acquire');
          try {
            return await run();
          } finally {
            held = false;
            events.push('release');
          }
        },
      };
      const run = runInNewContext(`(async () => { ${phase} })()`, scope);
      if (failureMode === 'none') await run;
      else
        await assert.rejects(run, (error) => {
          if (failureMode === 'body') assert.equal(error, bodyError);
          else if (failureMode === 'close') assert.equal(error, closeError);
          else assert.deepEqual(Array.from(error.errors), [bodyError, closeError]);
          return true;
        });
      assert.deepEqual(events, [
        'prepare',
        'ready',
        ...(admitted ? ['acquire'] : []),
        'launch',
        'body',
        'close',
        ...(admitted ? ['release'] : []),
        ...(failureMode === 'none' ? ['stop'] : []),
      ]);
    }
  }
});

test('Preview console reports retain structured arguments and their receiving phase', async () => {
  const evidence = {
    sequence: 0,
    phase: 'template-load',
    consoleErrors: [],
    consoleErrorEvents: [],
  };
  let listener;
  const scope = {
    activeEvidence: evidence,
    serializeBrowserConsoleValue,
    nextPage: {
      on: (name, callback) => {
        assert.equal(name, 'console');
        listener = callback;
      },
    },
  };
  runInNewContext(functionSource("  nextPage.on('console'", "  nextPage.on('response'"), scope);
  const detail = { code: 'diagnostic-only', detail: { parameter: 'probe-only' } };
  listener({
    type: () => 'error',
    text: () => 'diagnostic-only {detail: Object}',
    location: () => ({ url: 'diagnostic://console' }),
    args: () => [
      { evaluate: async (serialize) => serialize(detail) },
      {
        evaluate: async () => {
          throw new Error('disposed diagnostic handle');
        },
      },
      { evaluate: async (serialize) => serialize(1n) },
    ],
  });
  scope.activeEvidence = { phase: 'next-template', consoleErrorEvents: [] };
  await new Promise(setImmediate);
  assert.deepEqual(JSON.parse(JSON.stringify(evidence)), {
    sequence: 1,
    phase: 'template-load',
    consoleErrors: ['diagnostic-only {detail: Object} @ diagnostic://console'],
    consoleErrorEvents: [
      {
        sequence: 1,
        phase: 'template-load',
        message: 'diagnostic-only {detail: Object} @ diagnostic://console',
        arguments: [
          detail,
          { unavailable: 'Error: disposed diagnostic handle' },
          { unavailable: 'TypeError: Do not know how to serialize a BigInt' },
        ],
      },
    ],
  });
  assert.deepEqual(scope.activeEvidence.consoleErrorEvents, []);
});

test('Preview console evidence keeps native Error messages, stacks and nested structured causes', async () => {
  const evidence = {
    sequence: 0,
    phase: 'template-load',
    consoleErrors: [],
    consoleErrorEvents: [],
  };
  let listener;
  const scope = {
    Error,
    activeEvidence: evidence,
    serializeBrowserConsoleValue,
    nextPage: {
      on: (_name, callback) => {
        listener = callback;
      },
    },
  };
  runInNewContext(functionSource("  nextPage.on('console'", "  nextPage.on('response'"), scope);
  const inner = Object.assign(new TypeError('native domain rejection'), {
    code: 'domain-rejected',
    detail: { owner: 'fixture' },
  });
  const cause = new Error('native root failed', { cause: inner });
  const failure = { code: 'plugin-startup-failed', detail: { cause } };
  listener({
    type: () => 'error',
    text: () => 'startup rejected',
    location: () => ({ url: 'diagnostic://startup' }),
    args: () => [{ evaluate: async (serialize) => serialize(failure) }],
  });
  await new Promise(setImmediate);
  const result = evidence.consoleErrorEvents[0].arguments[0];
  assert.equal(result.code, failure.code);
  assert.equal(result.detail.cause.name, 'Error');
  assert.equal(result.detail.cause.message, cause.message);
  assert.equal(result.detail.cause.stack, cause.stack);
  assert.equal(result.detail.cause.cause.name, 'TypeError');
  assert.equal(result.detail.cause.cause.message, inner.message);
  assert.equal(result.detail.cause.cause.code, inner.code);
  assert.deepEqual(JSON.parse(JSON.stringify(result.detail.cause.cause.detail)), inner.detail);
});

test('Preview CI shares reduced workloads in disposable complete projects', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
    import { resolve, sep } from 'node:path';
    import { tmpdir } from 'node:os';
    const { reduceTestProject } = await import('./scripts/test/reduce-test-project.mjs');
    const ROOT = process.cwd();
    const ARTIFACT_DIR = await mkdtemp(resolve(tmpdir(), 'preview-ci-project-test-'));
    const PROJECTS = [
      { slug: 'game-3d', root: resolve(ROOT, 'templates/game-3d') },
      { slug: 'game-capability-lab', root: resolve(ROOT, 'apps/game-capability-lab') },
      { slug: 'empty', root: resolve(ROOT, 'templates/empty') },
      { slug: 'brotato-3d', root: resolve(ROOT, 'apps/showcase/brotato-3d') },
    ];
    const original = await readFile(resolve(ROOT, 'templates/game-3d/assets/scene.pack.ts'), 'utf8');
    ${functionSource('async function prepareTemplateSmokeProject(slug)', 'const appendServerOutput =')}
    try {
      const root = await prepareTemplateSmokeProject('game-3d');
      assert.equal(await readFile(resolve(root, 'assets/scene.pack.ts'), 'utf8'), original.replace('DirectionalLight: {', 'DirectionalLight: {cascadeCount: 1,mapSize: 256,'));
      assert.equal(await readFile(resolve(ROOT, 'templates/game-3d/assets/scene.pack.ts'), 'utf8'), original);
      const descriptor = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8'));
      assert.equal(descriptor.id, 'template-game-3d');
      const labSource = resolve(ROOT, 'apps/game-capability-lab/assets/scene.pack.json');
      const labOriginal = await readFile(labSource, 'utf8');
      const lab = await prepareTemplateSmokeProject('game-capability-lab');
      const reducedLab = JSON.parse(await readFile(resolve(lab, 'assets/scene.pack.json'), 'utf8'));
      const expectedLab = JSON.parse(labOriginal);
      for (const asset of Object.values(expectedLab.assets)) {
        for (const entity of Object.values(asset.payload?.entities ?? {})) {
          if (entity.components?.DirectionalLight) {
            entity.components.DirectionalLight.mapSize = 256;
            entity.components.DirectionalLight.cascadeCount = 1;
          }
        }
      }
      assert.deepEqual(reducedLab, expectedLab, 'omitted author fields must not retain expensive engine defaults');
      assert.equal(await readFile(labSource, 'utf8'), labOriginal);
      const effect = JSON.parse(await readFile(resolve(lab, 'assets/charge-vfx-effect.pack.json'), 'utf8'));
      const originalEffect = JSON.parse(await readFile(resolve(ROOT, 'apps/game-capability-lab/assets/charge-vfx-effect.pack.json'), 'utf8'));
      const emitters = effect.assets['vfx/charge'].payload.emitters;
      assert.deepEqual(emitters.map(e => e.capacity), [32, 32]);
      assert.deepEqual(emitters.map(e => e.schedule.rate), [8, 4]);
      assert.equal(emitters[0].schedule.bursts[0].count, 8);
      const normalize = pack => {
        for (const e of pack.assets['vfx/charge'].payload.emitters) {
          delete e.capacity; delete e.schedule.rate;
          for (const b of e.schedule.bursts) delete b.count;
        }
        return pack;
      };
      assert.deepEqual(normalize(effect), normalize(originalEffect), 'all emitters, programs, materials, bounds and timing remain');
      const geometry = await readFile(resolve(root, 'assets/geometry.pack.ts'), 'utf8');
      assert.ok(geometry.includes('createSphereGeometry(0.9, 16, 12)'));
      await reduceTestProject(root, { shadowMapSize: 128, cascadeCount: 1 });
      const override = await readFile(resolve(root, 'assets/scene.pack.ts'), 'utf8');
      assert.ok(override.includes('mapSize: 128,'));
      assert.ok(override.includes('cascadeCount: 1,'));
      await reduceTestProject(root);
      assert.equal(await readFile(resolve(root, 'assets/scene.pack.ts'), 'utf8'), override, 'shared defaults never enlarge smaller fixtures');
      const otherPack = resolve(root, 'assets/additional-scene.pack.ts');
      await writeFile(otherPack, 'export default ' + JSON.stringify({
        DirectionalLight: { intensity: 3 }, SpotLight: { mapSize: 128 }, ReflectionProbe: {},
      }));
      await reduceTestProject(root);
      assert.deepEqual(JSON.parse((await readFile(otherPack, 'utf8')).slice('export default '.length)), {
        DirectionalLight: { intensity: 3, mapSize: 256, cascadeCount: 1 },
        SpotLight: { mapSize: 128 }, ReflectionProbe: { resolution: 16 },
      });
      const brotatoSource = resolve(ROOT, 'apps/showcase/brotato-3d/assets/brotato-3d.pack.ts');
      const brotatoOriginal = await readFile(brotatoSource, 'utf8');
      const brotato = await prepareTemplateSmokeProject('brotato-3d');
      const brotatoPack = await readFile(resolve(brotato, 'assets/brotato-3d.pack.ts'), 'utf8');
      assert.ok(brotatoPack.includes('mapSize: 256,'));
      assert.equal(await readFile(brotatoSource, 'utf8'), brotatoOriginal);
      const empty = await prepareTemplateSmokeProject('empty');
      assert.equal(await readFile(resolve(empty, 'forge.json'), 'utf8'), await readFile(resolve(ROOT, 'templates/empty/forge.json'), 'utf8'));

      assert.equal(await readFile(resolve(lab, 'assets/plugins/camera-controller.ts'), 'utf8'), await readFile(resolve(ROOT, 'apps/game-capability-lab/assets/plugins/camera-controller.ts'), 'utf8'));
      assert.equal(await readFile(resolve(root, 'assets/player/player.ts'), 'utf8'), await readFile(resolve(ROOT, 'templates/game-3d/assets/player/player.ts'), 'utf8'));
      assert.equal(await readFile(resolve(root, 'assets/runtime-vase/vase-program.ts'), 'utf8'), await readFile(resolve(ROOT, 'templates/game-3d/assets/runtime-vase/vase-program.ts'), 'utf8'));
    } finally { await rm(ARTIFACT_DIR, { recursive: true, force: true }); }
  `,
    ],
    { timeout: 10000, encoding: 'utf8' },
  );
});

test('successful Preview browser cleanup leaves no deadline timers keeping Node alive', () => {
  // Execute the actual cleanup body in a child so natural process exit is the
  // oracle. The old Promise.race left three live 10-second timers behind.
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { setTimeout as sleep } from 'node:timers/promises';
    let activeEvidence;
    let disposed = false;
    let page = {
      isClosed: () => false,
      evaluate: async (fn) => {
        if (fn.toString().includes('postMessage')) { disposed = true; console.log('dispose'); }
        else return true;
      },
      waitForFunction: async () => { if (!disposed) throw new Error('must dispose before destroying page'); },
      close: async () => { if (!disposed) throw new Error('must dispose before destroying page'); console.log('page'); },
    };
    let context = { close: async () => console.log('context') };
    let browser = { close: async () => console.log('browser-client') };
    let browserServer = { close: async () => console.log('browser-server') };
    ${functionSource('async function closeSmokeBrowser()', 'async function waitForSubmittedRendererFrame')}
    await closeSmokeBrowser();
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'dispose\npage\ncontext\nbrowser-client\nbrowser-server');
});

test('failed Preview browser shutdown retires its owned process and preserves the failure', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { setTimeout as sleep } from 'node:timers/promises';
    let activeEvidence, page, context;
    let killed = false;
    const cause = new Error('owned browser shutdown failed');
    let browser = { close: async () => { throw cause; } };
    let browserServer = {
      close: async () => { throw cause; },
      kill: async () => { killed = true; },
    };
    ${functionSource('async function closeSmokeBrowser()', 'async function waitForSubmittedRendererFrame')}
    await assert.rejects(closeSmokeBrowser(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0].cause, cause);
      return true;
    });
    assert.equal(killed, true, 'a failed protocol close must retire the owned browser process');
    assert.equal(browser, undefined);
    assert.equal(browserServer, undefined);
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
});

test('Preview browser server and client share the original startup deadline and clean failed connections', async () => {
  for (const mode of ['success', 'connection-failure', 'cleanup-failure']) {
    const failure = new Error('connection failed');
    const cleanupFailure = new Error('cleanup failed');
    const times = [0, 2000];
    let launchOptions,
      connectOptions,
      cleaned = 0;
    const server = { wsEndpoint: () => 'ws://owned-browser' };
    const client = {};
    const scope = {
      performance: { now: () => times.shift() },
      process: { env: {} },
      CHROME_CHANNEL: 'chrome',
      CHROME_ARGS: [],
      chromium: {
        launchServer: async (options) => {
          launchOptions = options;
          return server;
        },
        connect: async (endpoint, options) => {
          assert.equal(endpoint, server.wsEndpoint());
          connectOptions = options;
          if (mode !== 'success') throw failure;
          return client;
        },
      },
      closeSmokeBrowser: async () => {
        cleaned++;
        if (mode === 'cleanup-failure') throw cleanupFailure;
      },
    };
    const launch = runInNewContext(
      `let browserServer; ${functionSource('async function launchSmokeBrowser()', 'async function createSmokePage')} launchSmokeBrowser;`,
      scope,
    );
    if (mode === 'success') assert.equal(await launch(), client);
    else
      await assert.rejects(launch(), (error) => {
        if (mode === 'connection-failure') assert.equal(error, failure);
        else assert.deepEqual(Array.from(error.errors), [failure, cleanupFailure]);
        return true;
      });
    assert.equal(launchOptions.timeout, 30_000);
    assert.equal(connectOptions.timeout, 28_000);
    assert.equal(cleaned, mode === 'success' ? 0 : 1);
  }
});

test('Preview dev server prepares producers before browser admission despite caller defaults', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { resolve } from 'node:path';
    process.env.NODE_ENV = 'production';
    process.env.FORGEAX_DEV_PACK_READINESS = 'on-demand';
    const ROOT = '/fixture', PORT = 5201;
    const createRequire = () => ({ resolve: () => '/fixture/vite/package.json' });
    let options;
    let server, serverOutput, serverSpawnError, serverExit, stopServer, templateSmokeRoot;
    const appendServerOutput = () => {};
    const spawn = (_command, _args, value) => { options = value; return { stdout: {on(){}}, stderr:{on(){}}, on(){} }; };
    ${functionSource('function startServer(', 'let browser;')}
    startServer('game-3d');
    assert.equal(options.env.FORGEAX_TEMPLATE_SMOKE_SLUGS, 'game-3d');
    startServer('empty');
    assert.equal(options.env.FORGEAX_TEMPLATE_SMOKE_SLUGS, 'empty');
    assert.equal(options.env.NODE_ENV, 'development');
    assert.equal(options.env.FORGEAX_TEMPLATE_SMOKE, '1');
    assert.equal(options.env.FORGEAX_DEV_PACK_READINESS, 'before-consume');
    assert.equal(process.env.NODE_ENV, 'production');
    assert.equal(process.env.FORGEAX_DEV_PACK_READINESS, 'on-demand');
  `,
    ],
    { timeout: 5000 },
  );
});

test('Preview readiness failures retain predicate state and attempt the real RHI capture', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    let captureCalls = 0;
    globalThis.__forgeaxPreviewInspection = {
      captureFrame: async (frames) => {
        captureCalls += 1;
        assert.equal(frames, 1);
        return { ok: false, error: { code: 'capture-timeout', detail: { stage: 'snapshot' } } };
      },
    };
    let evaluations = 0;
    const page = {
      evaluate: async (operation) => {
        evaluations += 1;
        if (evaluations === 1) return {
          inspectionAvailable: true,
          rendererHealth: { reason: 'alive', frame: { frameId: 0 } },
          frameProgress: { frameId: 0, completed: 0 },
          frameCompleted: null,
          canvas: { width: 320, height: 180, connected: true },
        };
        return operation();
      },
    };
    ${functionSource('async function diagnoseTemplateReadyFailure(', 'async function smokeGame3dCollision')}
    const diagnostic = await diagnoseTemplateReadyFailure(new Error('original readiness timeout'));
    assert.equal(diagnostic.waitError, 'Error: original readiness timeout');
    assert.equal(diagnostic.runtime.rendererHealth.frame.frameId, 0);
    assert.deepEqual(diagnostic.runtime.frameProgress, { frameId: 0, completed: 0 });
    assert.equal(diagnostic.runtime.frameCompleted, null);
    assert.deepEqual(diagnostic.rhiCapture, {
      ok: false,
      error: { code: 'capture-timeout', detail: { stage: 'snapshot' } },
    });
    assert.equal(captureCalls, 1);
  `,
    ],
    { timeout: 5000 },
  );
});

test('Preview readiness diagnostics stop waiting when RHI capture stalls', () => {
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    let evaluations = 0;
    const page = {
      evaluate: async (operation) => {
        evaluations += 1;
        if (evaluations === 1) return {
          inspectionAvailable: true,
          rendererHealth: { reason: 'alive', frame: { frameId: 0 } },
          frameProgress: { frameId: 0, completed: 0 },
          frameCompleted: null,
          canvas: { width: 320, height: 180, connected: true },
        };
        return new Promise(() => {});
      },
    };
    ${functionSource('async function diagnoseTemplateReadyFailure(', 'async function smokeGame3dCollision')}
    const diagnostic = await diagnoseTemplateReadyFailure(new Error('original readiness timeout'));
    assert.equal(diagnostic.waitError, 'Error: original readiness timeout');
    assert.deepEqual(diagnostic.runtime.frameProgress, { frameId: 0, completed: 0 });
    assert.deepEqual(diagnostic.rhiCapture, { status: 'timeout', timeoutMs: 3_000 });
    assert.equal(evaluations, 2);
  `,
    ],
    { timeout: 5000 },
  );
});

test('Preview readiness terminates when an HTTP server accepts but never responds', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { createServer } from 'node:http';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { decodeCatalogWire } from '@forgeax/engine/pack';
    const listener = createServer(() => {});
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const ORIGIN = 'http://127.0.0.1:' + listener.address().port;
    const SERVER_STARTUP_TIMEOUT_MS = 80;
    const CATALOG_URL = '/catalog.json';
    const server = { pid: process.pid };
    let serverSpawnError, serverExit;
    const serverOutput = '';
    ${functionSource('function serverDiagnostics(', 'function movementProjection(')}
    try {
      await waitForServerReady();
      throw new Error('accepted an unresponsive server');
    } catch (error) {
      if (!String(error).includes('Preview server did not become ready within 80ms')) throw error;
      console.log('bounded startup failure');
    } finally {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'bounded startup failure');
});

test('Preview readiness waits for its Catalog and preserves terminal producer errors', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { decodeCatalogWire } from '@forgeax/engine/pack';
    const CATALOG_URL = '/catalog.json';
    let ready = false, failed = false, reads = 0;
    const listener = createServer((req, res) => {
      if (req.url === CATALOG_URL) {
        reads++;
        res.statusCode = failed ? 500 : ready ? 200 : 503;
        res.end(failed ? 'character.pack.ts: module initialization failed' : JSON.stringify({ schemaVersion: 'runtime-catalog-snapshot-v1', scopeId: 'readiness', generation: 1, authority: 'authoritative', entries: [] }));
      } else res.end('<html>Listener only</html>');
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const ORIGIN = 'http://127.0.0.1:' + listener.address().port;
    const SERVER_STARTUP_TIMEOUT_MS = 2000;
    const server = { pid: process.pid };
    let serverSpawnError, serverExit;
    const serverOutput = '';
    ${functionSource('function serverDiagnostics(', 'function movementProjection(')}
    try {
      const preparing = waitForServerReady();
      // The child can be scheduled behind the catalog fetch on a loaded
      // self-hosted runner. Wait for the observable request with a bounded
      // deadline instead of assuming it will happen within one fixed tick.
      const requestDeadline = Date.now() + 1000;
      while (reads === 0 && Date.now() < requestDeadline) await sleep(20);
      assert.ok(reads > 0, 'must request the catalog');
      ready = true;
      await preparing;
      assert.ok(reads >= 2, 'pending catalog must delay readiness');
      failed = true;
      const before = reads;
      await assert.rejects(waitForServerReady(), /character.pack.ts: module initialization failed/);
      assert.equal(reads, before + 1, 'terminal failure must not be retried');
      console.log('catalog readiness and failure passed');
    } finally {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
  `,
    ],
    { timeout: 5000, encoding: 'utf8' },
  );
  assert.match(
    output.trim(),
    /^\[templates\] catalog-ready-ms=\d+\ncatalog readiness and failure passed$/,
  );
});

test('Preview waits for a slow Catalog freshness barrier without restarting requests', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:http';
    import { setTimeout as sleep } from 'node:timers/promises';
    import { decodeCatalogWire } from '@forgeax/engine/pack';
    let reads = 0;
    const listener = createServer(async (_req, res) => {
      reads++;
      // Every real Catalog request fences filesystem state. It can take
      // longer than a second even after Vite's HTTP listener is ready.
      await sleep(1500);
      res.end(JSON.stringify({ schemaVersion: 'runtime-catalog-snapshot-v1', scopeId: 'readiness', generation: 1, authority: 'authoritative', entries: [{ guid: 'slow-but-current' }] }));
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const ORIGIN = 'http://127.0.0.1:' + listener.address().port;
    const SERVER_STARTUP_TIMEOUT_MS = 4000;
    const CATALOG_URL = '/catalog.json';
    const server = { pid: process.pid };
    let serverSpawnError, serverExit;
    const serverOutput = '';
    ${functionSource('function serverDiagnostics(', 'function movementProjection(')}
    try {
      await waitForServerReady();
      assert.equal(reads, 1, 'one in-budget freshness request must finish without retry churn');
      console.log('slow catalog passed');
    } finally {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
  `,
    ],
    { timeout: 8000, encoding: 'utf8' },
  );
  assert.match(output.trim(), /^\[templates\] catalog-ready-ms=\d+\nslow catalog passed$/);
});

test('Preview reports success only after browser and owned server cleanup', () => {
  assert.ok(source.indexOf('await stopServer();') < source.indexOf('writeReport(reportStatus)'));
  assert.match(source, /createOwnedProcessGroupStopper\(server\)/);
  assert.match(source, /process\.on\('SIGTERM', onTerminate\)/);
  assert.match(source, /process\.execPath,[\s\S]*vite\/package\.json/);
  const collision = functionSource(
    'async function smokeGame3dCollision(',
    'async function smokeGame3d(evidence)',
  );
  assert.match(collision, /keyboard\.down\('KeyW'\)/);
  assert.doesNotMatch(collision, /mouse\.(click|move)/);
  assert.match(collision, /collisionLateStep > 0\.45/);
});

test('the complete template roster scopes and drains each server serially', () => {
  const loop = source.slice(source.indexOf('for (const template of templates)'));
  assert.match(
    loop,
    /startServer\(template\.slug\);\s*await waitForServerReady\(\);\s*const runBrowser = async \(\) =>/,
  );
  assert.match(loop, /await smokeTemplate\(template, evidence\);/);
  assert.match(
    loop,
    /await runBrowser\(\);\s*}\s*await stopServer\(\);\s*if \(templateSmokeRoot !== undefined\)/,
  );
});

test('both Preview browser consumers receive the verified shared shader manifest', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  for (const name of [
    'UI authoring preview/capture probe',
    'engine templates Preview browser smoke (render + console gate)',
  ]) {
    const step = workflow
      .slice(workflow.indexOf(`      - name: ${name}`))
      .split(/\n {6}- name:|\n {2}#/)[0];
    assert.match(step, /FORGEAX_SHARED_APP_INPUTS_MANIFEST:.*shared-app-inputs\/manifest.json/);
  }
});

test('the empty template retains its own complete catalog without foreign resource producers', () => {
  const config = readFileSync(
    new URL('../../../apps/preview/vite.config.ts', import.meta.url),
    'utf8',
  );
  const declaration = config.slice(
    config.indexOf('const packRoots ='),
    config.indexOf('const particleSourceRoots ='),
  );
  const rootsFor = (selectedTemplateSlugs) =>
    JSON.parse(
      JSON.stringify(
        runInNewContext(`${declaration}; packRoots`, {
          surfaceOnly: false,
          game3dOnlySmoke:
            selectedTemplateSlugs.length === 1 && selectedTemplateSlugs[0] === 'game-3d',
          selectedTemplateSlugs,
          templatePackRoots: ['scene-owner.pack.ts', 'world.scene.pack.json'],
          externalAssetRoots: ['foreign-font', 'foreign-model'],
          surfaceEvidencePackRoot: 'surface',
          previewUiAuthoringMetaPath: 'ui-authoring',
          process: {
            env: { FORGEAX_TEMPLATE_SMOKE: selectedTemplateSlugs.length > 0 ? '1' : undefined },
          },
          existsSync: () => true,
        }),
      ),
    );
  assert.deepEqual(rootsFor(['empty']), ['scene-owner.pack.ts', 'world.scene.pack.json']);
  assert.deepEqual(rootsFor(['game-3d']), ['scene-owner.pack.ts', 'world.scene.pack.json']);
  assert.deepEqual(rootsFor(['game-capability-lab']), [
    'scene-owner.pack.ts',
    'world.scene.pack.json',
    'foreign-font',
    'foreign-model',
  ]);
  assert.deepEqual(rootsFor([]), [
    'scene-owner.pack.ts',
    'world.scene.pack.json',
    'surface',
    'ui-authoring',
    'foreign-font',
    'foreign-model',
  ]);
});

test('Preview closing evidence is bounded, separate and cannot hide an owned cleanup failure', async () => {
  for (const failed of [false, true]) {
    const evidence = { pageErrors: [], consoleErrors: [] };
    const listeners = new Map();
    const events = [];
    const timers = new Set();
    const deadlines = [];
    const cause = new Error('fixture App disposal did not retire the UI');
    const page = {
      on: (name, handler) => listeners.set(name, handler),
      off: (name, handler) => {
        assert.equal(listeners.get(name), handler);
        listeners.delete(name);
      },
      isClosed: () => false,
      evaluate: async (fn) => {
        if (fn.toString().includes('forgeaxFrameProgress')) {
          return {
            frame: {
              submitted: 7,
              completed: failed ? 6 : 7,
            },
            renderer: { reason: 'alive' },
          };
        }
        if (!fn.toString().includes('postMessage')) return true;
        events.push('dispose');
        listeners.get('pageerror')(new Error('fixture closing rejection'));
        for (let i = 0; i < 40; i++) {
          listeners.get('console')({ type: () => 'error', text: () => 'x'.repeat(4096) });
        }
        listeners.get('console')({
          type: () => {
            throw new Error('observer-only failure');
          },
        });
      },
      waitForFunction: async (_predicate, _argument, options) => {
        assert.equal(options.timeout, 10_000);
        if (failed) throw cause;
      },
      close: async () => {
        events.push('page');
      },
    };
    const scope = {
      activeEvidence: evidence,
      page,
      context: {
        close: async () => {
          events.push('context');
        },
      },
      browser: {
        close: async () => {
          events.push('browser-client');
        },
      },
      browserServer: {
        close: async () => {
          events.push('browser-server');
        },
      },
      sleep: async (ms) => {
        assert.equal(ms, 250);
      },
      setTimeout: (_callback, ms) => {
        assert.equal(ms, 10_000);
        deadlines.push(ms);
        const token = {};
        timers.add(token);
        return token;
      },
      clearTimeout: (token) => timers.delete(token),
    };
    const close = runInNewContext(
      `${functionSource('async function closeSmokeBrowser()', 'async function waitForSubmittedRendererFrame')} closeSmokeBrowser;`,
      scope,
    );
    if (failed) {
      await assert.rejects(close(), (error) => {
        assert.equal(error.name, 'AggregateError');
        assert.equal(error.errors[0].cause, cause);
        return true;
      });
    } else await close();
    assert.deepEqual(events, ['dispose', 'page', 'context', 'browser-client', 'browser-server']);
    assert.deepEqual(evidence.pageErrors, []);
    assert.deepEqual(evidence.consoleErrors, []);
    assert.equal(evidence.shutdown.events.length, 32);
    assert.equal(evidence.shutdown.droppedEvents, 10);
    assert.equal(evidence.shutdown.events[0].kind, 'pageerror');
    assert.equal(evidence.shutdown.events[0].message, 'fixture closing rejection');
    assert.equal(evidence.shutdown.events[1].message.length, 2048);
    assert.equal(
      evidence.shutdown.phase,
      failed ? 'dispose-message-posted' : 'inspection-and-ui-retired',
    );
    assert.equal(evidence.shutdown.attempts[0].status, failed ? 'failed' : 'completed');
    assert.equal(evidence.shutdown.attempts[0].phase, evidence.shutdown.phase);
    assert.deepEqual(evidence.shutdown.frameAtCloseStart, {
      frame: {
        submitted: 7,
        completed: failed ? 6 : 7,
      },
      renderer: { reason: 'alive' },
    });
    if (failed) assert.match(evidence.shutdown.attempts[0].cause, /fixture App disposal/);
    assert.equal(evidence.shutdown.attempts.length, 4);
    assert.equal(deadlines.length, 4);
    assert.equal(timers.size, 0);
    assert.equal(listeners.size, 0);
    assert.equal(scope.activeEvidence, undefined);
    assert.equal(scope.page, undefined);
    assert.equal(scope.browserServer, undefined);
  }
});
