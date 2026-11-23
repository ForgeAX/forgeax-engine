import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSdkVerifierProcess, readSdkProjectDocument } from '../verify-sdk-process.mjs';

const packageManager = 'pnpm@11.7.0';
const literalArgs = ['quote"literal', 'back\\slash', 'ampersand&', 'percent%'];

test('source View child failure retains its daemon log after session teardown', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sdk-view-backend-'));
  const backend = resolve(tmpdir(), 'forgeax-backend', basename(root));
  t.after(() => rm(root, { force: true, recursive: true }));
  t.after(() => rm(backend, { force: true, recursive: true }));
  const script = resolve(root, 'probe.mjs');
  await writeFile(
    script,
    `import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
const directory = process.argv[2];
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, 'backend.log'), JSON.stringify({
  scope: 'backend-startup', stage: 'daemon-spawn', event: 'spawned',
  hostPid: process.pid, childPid: process.pid + 1, time: new Date().toISOString()
}) + '\\nError: native socket closed; ws://localhost/?token=private-token\\n');
writeFileSync(resolve(directory, 'session.json'), '{"token":"private-session"}');
rmSync(resolve(directory, 'session.json'));
process.stdout.write('game-3d-open');
process.stderr.write('host-transport-failure');
process.exit(Number(process.argv[3]));
`,
  );
  const runner = createSdkVerifierProcess(packageManager);
  const output = resolve(root, 'view-source', 'backend');
  const pending = runner.execFileAsync(process.execPath, [script, backend, '23'], {
    backendEvidenceDirectory: output,
  });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 23);
    assert.equal(error.signal, null);
    assert.equal(error.stdout, 'game-3d-open');
    assert.equal(error.stderr, 'host-transport-failure');
    return true;
  });
  const evidence = await readFile(resolve(output, `${basename(backend)}.log`), 'utf8');
  assert.match(evidence, /native socket closed/);
  assert.match(evidence, new RegExp(`"hostPid":${pending.child.pid}`));
  assert.match(evidence, /token=\[redacted\]/);
  assert.doesNotMatch(evidence, /private-token|private-session/);

  const successOutput = resolve(root, 'success');
  const result = await runner.execFileAsync(process.execPath, [script, backend, '0'], {
    backendEvidenceDirectory: successOutput,
  });
  assert.equal(result.stdout, 'game-3d-open');
  await assert.rejects(readFile(resolve(successOutput, `${basename(backend)}.log`)), {
    code: 'ENOENT',
  });

  const blockedOutput = resolve(root, 'blocked-output');
  await writeFile(blockedOutput, 'not a directory');
  await assert.rejects(
    runner.execFileAsync(process.execPath, [script, backend, '23'], {
      backendEvidenceDirectory: blockedOutput,
    }),
    (error) => error.code === 23 && error.stderr === 'host-transport-failure',
  );
});

test('verifier process preserves Windows argv, output, and pinned long children', async (t) => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'sdk verifier ')));
  const cwd = resolve(root, '\u7279\u6b8a \u4e2d\u6587 \u7a7a\u683c 50%');
  await mkdir(cwd);
  const script = resolve(cwd, 'child.mjs');
  await writeFile(
    script,
    `process.stdout.write('stdout-progress\\n');
process.stderr.write('stderr-progress\\n');
await new Promise((done) => setTimeout(done, 250));
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env.VERIFIER_FIXTURE }) + '\\n');\n`,
  );
  t.after(() => rm(root, { force: true, recursive: true }));
  const runner = createSdkVerifierProcess(packageManager);
  const writes = [];
  let child;
  let progressBeforeExit = false;
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    const text = String(chunk);
    writes.push(text);
    if (text.includes('stderr-progress') && child?.exitCode === null) progressBeforeExit = true;
    return true;
  };
  try {
    const pending = runner.execFileAsync(process.execPath, [script, ...literalArgs], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, VERIFIER_FIXTURE: 'env value & 50%' },
      streamOutput: true,
    });
    child = pending.child;
    const result = await pending;
    const value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(value, { args: literalArgs, cwd, env: 'env value & 50%' });
    assert.match(result.stderr, /stderr-progress/);
    assert.ok(writes.some((text) => text.includes('stdout-progress')));
    assert.ok(writes.some((text) => text.includes('stderr-progress')));
    assert.equal(progressBeforeExit, true);
  } finally {
    process.stderr.write = originalWrite;
  }
  await assert.rejects(
    runner.execFileAsync(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(23)'],
      { encoding: 'utf8' },
    ),
    (error) => error.code === 23 && error.stdout === 'out' && error.stderr === 'err',
  );
  const missing = runner.spawn('sdk-verifier-missing-command', [], { stdio: 'ignore' });
  const [spawnError] = await once(missing, 'error');
  assert.equal(spawnError.code, 'ENOENT');
  if (process.platform !== 'win32') return;
  await writeFile(
    resolve(cwd, 'package.json'),
    JSON.stringify({ name: 'fixture', packageManager }),
  );
  const options = { cwd, env: { ...process.env, VERIFIER_FIXTURE: 'pinned' }, encoding: 'utf8' };
  const direct = await runner.execFileAsync('corepack', [packageManager, '--version'], options);
  const pnpm = await runner.execFileAsync('pnpm', ['--version'], options);
  assert.equal(direct.stdout.trim(), '11.7.0');
  assert.equal(pnpm.stdout.trim(), '11.7.0');
  const longChild = runner.spawn('pnpm', ['exec', 'node', script, ...literalArgs], {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  longChild.stdout.on('data', (chunk) => (stdout += chunk));
  longChild.stderr.on('data', (chunk) => (stderr += chunk));
  const [code, signal] = await once(longChild, 'close');
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.match(stdout, /stdout-progress/);
  assert.match(stderr, /stderr-progress/);
  const value = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.deepEqual(value.args, literalArgs);
  assert.equal(value.cwd, cwd);
  assert.equal(value.env, 'pinned');
});

test('candidate document reads share the public Codec and project authored Pack v3 assets', async (t) => {
  const { compressZstd } = await import('../../../packages/codec/dist/encode/index.mjs');
  const project = await realpath(await mkdtemp(resolve(tmpdir(), 'sdk catalog ')));
  t.after(() => rm(project, { force: true, recursive: true }));
  const installed = resolve(project, 'node_modules/@forgeax');
  await mkdir(installed, { recursive: true });
  await symlink(
    resolve(import.meta.dirname, '../../../packages/engine'),
    resolve(installed, 'engine'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const rows = [{ guid: '11111111-1111-4111-8111-111111111111', kind: 'mesh' }];
  const scene = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [{ guid: rows[0].guid, kind: 'scene', payload: { entities: [] } }],
  };
  const authored = JSON.parse(
    await readFile(
      new URL('../../../templates/empty/assets/world/world.scene.pack.json', import.meta.url),
      'utf8',
    ),
  );
  const projected = {
    packageId: authored.packageId,
    assets: [
      {
        ...authored.assets['world/empty'],
        sourceKey: 'world/empty',
        guid: 'ee7f6b3d-74ee-54e9-a62a-97d3fc58f125',
      },
    ],
  };
  const runner = createSdkVerifierProcess(packageManager);
  for (const [kind, value, expected = value] of [
    ['catalog', rows],
    ['json', scene],
    ['direct-pack', authored, projected],
  ]) {
    const plain = Buffer.from(JSON.stringify(value));
    const compressed = await compressZstd(plain);
    assert.equal(compressed.ok, true);
    if (!compressed.ok) throw compressed.error;
    for (const bytes of [plain, compressed.value]) {
      const file = resolve(project, kind === 'catalog' ? 'pack-index.json' : 'scene.pack.json');
      await writeFile(file, bytes);
      assert.deepEqual(
        await readSdkProjectDocument(runner.execFileAsync, project, file, kind),
        expected,
      );
    }
  }
});

test('SDK failure evidence never captures the daemon in place of the selected page', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'sdk-page-evidence-'));
  try {
    const source = await readFile(new URL('../verify-sdk.mjs', import.meta.url), 'utf8');
    const declaration = source.slice(
      source.indexOf('async function preserveFrameFailureEvidence'),
      source.indexOf('async function createProjectPage'),
    );
    let daemonRequests = 0;
    const preserve = runInNewContext(`(${declaration})`, {
      archive: resolve(root, 'sdk.zip'),
      unpackRoot: resolve(root, 'selected-project'),
      basename,
      dirname,
      relative,
      resolve,
      mkdir,
      writeFile,
      process: { env: { FORGEAX_RHI_CAPTURE: '1' } },
      execFileAsync: () => {
        daemonRequests++;
        throw new Error('The daemon belongs to a different browser.');
      },
    });
    const evidence = await preserve(
      { screenshot: async ({ path }) => writeFile(path, 'selected-page-png') },
      'movement',
    );
    assert.equal(daemonRequests, 0);
    assert.equal(evidence.capture.status, 'unavailable');
    assert.equal(evidence.capture.reason, 'selected-page-has-no-cli-capture-attachment');
    assert.equal(await readFile(resolve(root, evidence.screenshot), 'utf8'), 'selected-page-png');
    const manifest = JSON.parse(await readFile(resolve(root, evidence.manifest), 'utf8'));
    assert.equal(manifest.capture.reason, evidence.capture.reason);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SDK startup diagnostics retain pending presentation and the startup phase', async () => {
  const source = await readFile(new URL('../verify-sdk.mjs', import.meta.url), 'utf8');
  const declaration = source.slice(
    source.indexOf('async function frameTimeoutDiagnostics'),
    source.indexOf('async function preserveFrameFailureEvidence'),
  );
  const progress = {
    submitted: { frameId: 9, deviceGeneration: 3, worldIdentity: 'selected-page' },
    completed: {
      frameId: 8,
      presentation: 'pending',
      presentationPendingReason: 'material-pipeline-preparation',
    },
  };
  const diagnose = runInNewContext(`(${declaration})`, {
    sdkStage: async (_label, action) => action(),
    preserveFrameFailureEvidence: async () => ({ screenshot: 'selected-page.png' }),
  });
  const result = await diagnose(
    {
      evaluate: async (read) =>
        runInNewContext(`(${read})()`, {
          document: {
            querySelector: (selector) =>
              selector === 'canvas' ? { forgeaxFrameProgress: progress } : null,
          },
          __forgeaxStartup: { inspect: () => ({ phase: 'preparing' }) },
          __forgeaxGameInspection: { renderer: () => ({ state: 'alive' }) },
        }),
    },
    { pageErrors: [], consoleErrors: [], failedResponses: [], serverOutput: () => ({}) },
    'movement',
  );
  assert.equal(result.frameProgress.completed.presentation, 'pending');
  assert.equal(
    result.frameProgress.completed.presentationPendingReason,
    'material-pipeline-preparation',
  );
  assert.equal(result.frameProgress.submitted.worldIdentity, 'selected-page');
  assert.equal(result.startup.phase, 'preparing');
  assert.equal(result.renderer.state, 'alive');
});

async function sdkStartupRecoveryProbe({
  loss,
  repeatFailure = false,
  platform = 'linux',
  channel = 'chrome-beta',
}) {
  const source = await readFile(new URL('../verify-sdk.mjs', import.meta.url), 'utf8');
  const declaration =
    source.slice(
      source.indexOf('  async function verifyProjectBrowser('),
      source.indexOf('  async function waitForProjectPackCatalog('),
    ) +
    source.slice(
      source.indexOf('  function canRecoverSelectedBrowser('),
      source.indexOf('  async function launchSelectedBrowser('),
    );
  const events = [];
  const cleanup = [];
  let launches = 0;
  let reads = 0;
  const failure = new Error('original startup assertion failed');
  const verify = runInNewContext(`(() => { ${declaration}; return verifyProjectBrowser; })()`, {
    process: { platform, env: { FORGEAX_CHROME_CHANNEL: channel } },
    LIVE_DEV_STARTUP_TIMEOUT_MS: 1_000,
    spawnProjectServer: () => ({
      exitCode: 0,
      once: (_event, callback) => queueMicrotask(() => callback(0)),
      stdout: { on: (_event, callback) => callback('{"command":"dev","ok":true,"value":{}}\n') },
      stderr: { on() {} },
    }),
    boundedTail: (value) => value,
    liveProjectUrl: async () => 'http://selected-page',
    waitForProjectPackCatalog: async () => {},
    sdkStage: async (_label, action) => action(),
    launchSelectedBrowser: async () => {
      const browser = { id: ++launches };
      events.push(`launch ${browser.id}`);
      return browser;
    },
    createProjectPage: async (browser) => ({
      browser,
      evaluate: async () => ({
        canvas: { width: 64, height: 64 },
        state: 'alive',
        frameId: 1,
        execution: { render: { lastLoss: { cause: loss } } },
      }),
      locator: () => ({
        first: () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 64, height: 64 }) }),
      }),
      mouse: { move: async () => {}, click: async () => {} },
      keyboard: { down: async () => {}, up: async () => {} },
      waitForTimeout: async () => {},
    }),
    readSelectedPlayerProjection: async () => ({ position: [0, 0, -reads], fixedTick: reads++ }),
    waitForProjectPage: async (page, _url, _diagnostics, phase) => {
      events.push(`assert ${page.browser.id} ${phase}`);
      if (page.browser.id === 1 || repeatFailure) throw failure;
    },
    frameTimeoutDiagnostics: async (page) => {
      assert.equal(page.browser.id, launches);
      assert.notEqual(events.at(-1), `close ${launches}`);
      cleanup.push(`diagnostics ${page.browser.id}`);
      return { browser: page.browser.id };
    },
    closeSelectedPage: async (page) => cleanup.push(`page ${page.browser.id}`),
    closeSelectedBrowser: async (browser) => {
      events.push(`close ${browser.id}`);
      cleanup.push(`browser ${browser.id}`);
    },
    stopLiveProject: async () => cleanup.push('server'),
  });
  return {
    pending: verify('/fixture', 'scope'),
    events,
    cleanup,
    failure,
    browserId: () => launches,
  };
}

const nativeInstanceLoss = JSON.stringify({
  code: 'device-operation-failed',
  detail: {
    operation: 'renderer-event',
    cause: {
      code: 'device-lost',
      hint: 'device-lost reason: unknown; message: A valid external Instance reference no longer exists.',
    },
  },
});

test('SDK startup retires a known lost native instance before full fresh startup assertions', async () => {
  const probe = await sdkStartupRecoveryProbe({ loss: nativeInstanceLoss });
  const result = await probe.pending;
  assert.deepEqual(probe.events, [
    'launch 1',
    'assert 1 movement',
    'close 1',
    'launch 2',
    'assert 2 fresh-process-startup-recovery',
    'close 2',
  ]);
  assert.equal(probe.browserId(), 2);
  assert.equal(result.startupRecovery.reason, 'host-gpu-instance-lost');
  assert.match(result.startupRecovery.error, /original startup assertion failed/);
  assert.deepEqual(probe.cleanup, ['browser 1', 'page 2', 'browser 2', 'server']);
});

test('SDK startup does not retry preparation stalls, other losses or other carriers', async () => {
  for (const options of [
    { loss: undefined },
    { loss: 'invalid diagnostic' },
    { loss: nativeInstanceLoss.replace('Instance reference', 'device reference') },
    { loss: nativeInstanceLoss, platform: 'darwin' },
    { loss: nativeInstanceLoss, channel: 'chrome' },
  ]) {
    const probe = await sdkStartupRecoveryProbe(options);
    await assert.rejects(probe.pending, (error) => error.cause === probe.failure);
    assert.deepEqual(probe.events, ['launch 1', 'assert 1 movement', 'close 1']);
    assert.deepEqual(probe.cleanup, ['diagnostics 1', 'page 1', 'browser 1', 'server']);
  }
});

test('SDK startup retains the fresh failed page for caller diagnostics and cleanup', async () => {
  const probe = await sdkStartupRecoveryProbe({ loss: nativeInstanceLoss, repeatFailure: true });
  await assert.rejects(probe.pending, (error) => error.cause === probe.failure);
  assert.deepEqual(probe.events, [
    'launch 1',
    'assert 1 movement',
    'close 1',
    'launch 2',
    'assert 2 fresh-process-startup-recovery',
    'close 2',
  ]);
  assert.deepEqual(probe.cleanup, ['browser 1', 'diagnostics 2', 'page 2', 'browser 2', 'server']);
});

async function selectedPageCloser(timeoutMs = 50) {
  const source = await readFile(new URL('../verify-sdk.mjs', import.meta.url), 'utf8');
  const declaration = source.slice(
    source.indexOf('  async function closeSelectedPage('),
    source.indexOf('  /**', source.indexOf('  async function closeSelectedPage(')),
  );
  return runInNewContext(`(() => { ${declaration}; return closeSelectedPage; })()`, {
    CLEANUP_TIMEOUT_MS: timeoutMs,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
}

test('SDK gameplay releases its pointer lock before closing the page', async () => {
  const close = await selectedPageCloser();
  let locked = true;
  let nativeClose = false;
  const document = {
    get pointerLockElement() {
      return locked ? {} : null;
    },
    exitPointerLock() {
      queueMicrotask(() => {
        locked = false;
      });
    },
  };
  await close({
    isClosed: () => false,
    evaluate: async (action) => runInNewContext(`(${action})()`, { document }),
    waitForFunction: async (read) => {
      assert.equal(runInNewContext(`(${read})()`, { document }), true);
    },
    close: async () => {
      assert.equal(locked, false, 'Closing a pointer-locked game stalls the native context');
      nativeClose = true;
    },
  });
  assert.equal(nativeClose, true);
});

test('a pointer lock that cannot retire keeps the original page cleanup deadline', async () => {
  const close = await selectedPageCloser(5);
  let nativeClose = false;
  const document = { pointerLockElement: {}, exitPointerLock() {} };
  await assert.rejects(
    close({
      isClosed: () => false,
      evaluate: async (action) => runInNewContext(`(${action})()`, { document }),
      waitForFunction: () => new Promise(() => {}),
      close: async () => {
        nativeClose = true;
      },
    }),
    /page cleanup incomplete after 5ms/,
  );
  assert.equal(nativeClose, false);
});
