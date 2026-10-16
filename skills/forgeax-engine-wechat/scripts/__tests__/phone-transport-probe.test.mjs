import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(
  await realpath(join(process.cwd(), 'node_modules/tsup/dist/index.js')),
);
const { build } = require('esbuild'),
  { WebSocket } = require('ws');
const scripts = fileURLToPath(new URL('..', import.meta.url));
const hostRequire = createRequire(join(process.cwd(), 'packages/platform-wechat/package.json'));
const source = { manifestSha256: 'a'.repeat(64), controllerSha256: 'b'.repeat(64) };

test('receiver CLI starts through a directory symlink such as Mac /tmp', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'forgeax-phone-ws-cli-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const actual = join(temporary, 'actual'),
    alias = join(temporary, 'alias');
  await mkdir(actual);
  await symlink(actual, alias, 'dir');
  await build({
    entryPoints: [join(scripts, 'run_phone_transport_probe.mjs')],
    outfile: join(actual, 'receiver.bundle.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    alias: { ws: require.resolve('ws') },
    banner: {
      js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
    },
  });
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  await writeFile(
    join(actual, 'benchmark-manifest.json'),
    JSON.stringify({
      source: {
        phone: {
          controlUrl: `http://127.0.0.1:${port}/cli_probe`,
          runId: 'cli_transport_probe_20261013',
          mode: 'transport-probe',
          reportSource: source,
        },
      },
    }),
  );
  const out = join(temporary, 'result');
  const child = spawn(
    process.execPath,
    [join(alias, 'receiver.bundle.mjs'), '--publication', alias, '--out', out, '--timeout', '0.05'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 1, `Receiver must run and report its expected no-phone deadline: ${stderr}`);
  const lines = stdout
    .trim()
    .split('\n')
    .map((value) => JSON.parse(value));
  assert.equal(lines[0].status, 'listening');
  assert.equal(lines[1].failure, 'transport-probe-deadline');
  assert.equal(JSON.parse(await readFile(join(out, 'receiver.json'), 'utf8')).noNativeInput, true);
});

for (const scenario of ['success', 'disable-failed', 'socket-destroyed'])
  test(`real ws probe: ${scenario}; no timing or input`, async (t) => {
    const temporary = await mkdtemp(join(tmpdir(), 'forgeax-phone-ws-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    for (const name of ['run_phone_transport_probe', 'phone_gameplay_transport_probe']) {
      await build({
        entryPoints: [join(scripts, `${name}.mjs`)],
        outfile: join(temporary, `${name}.mjs`),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        banner: {
          js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);",
        },
        alias: {
          ws: require.resolve('ws'),
          '@noble/hashes/sha2.js': hostRequire.resolve('@noble/hashes/sha2.js'),
          '@exodus/bytes/utf8.js': join(
            dirname(hostRequire.resolve('@exodus/bytes/utf8.js')),
            'utf8.js',
          ),
        },
      });
    }
    const reserve = createServer();
    await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const options = {
      controlUrl: `http://127.0.0.1:${port}/test_probe`,
      runId: 'test_transport_probe_20261013',
      mode: 'transport-probe',
      source,
    };
    const publication = join(temporary, 'publication'),
      out = join(temporary, 'result');
    await mkdir(publication);
    await writeFile(
      join(publication, 'benchmark-manifest.json'),
      JSON.stringify({
        source: {
          phone: { ...options, reportSource: source },
        },
      }),
    );
    const { createPhoneTransportProbe } = await import(
      pathToFileURL(join(temporary, 'run_phone_transport_probe.mjs'))
    );
    const receiver = await createPhoneTransportProbe({ publication, out, timeoutMs: 10000 });
    t.after(() => receiver.close());
    let socket;
    const toggles = [];
    const wx = {
      setEnableDebug(value) {
        toggles.push(value.enableDebug);
        if (!value.enableDebug && scenario === 'disable-failed') {
          value.fail({ errMsg: 'setEnableDebug:fail original native error', errno: 23 });
        } else {
          value.success({ errMsg: 'setEnableDebug:ok' });
          if (!value.enableDebug && scenario === 'socket-destroyed') socket.terminate();
        }
        value.complete({ errMsg: 'setEnableDebug:complete' });
      },
      connectSocket(value) {
        socket = new WebSocket(value.url);
        value.success({ errMsg: 'connectSocket:ok' });
        return {
          onOpen: (callback) => socket.on('open', () => callback({})),
          onError: (callback) => socket.on('error', (error) => callback({ errMsg: String(error) })),
          onClose: (callback) => socket.on('close', (code) => callback({ code })),
          onMessage: (callback) => socket.on('message', (data) => callback({ data: String(data) })),
          send(value) {
            socket.send(value.data, (error) =>
              error
                ? value.fail({ errMsg: String(error) })
                : value.success({ errMsg: 'sendSocketMessage:ok' }),
            );
          },
          close(value) {
            socket.close(value.code, value.reason);
            value.success({ errMsg: 'closeSocket:ok' });
          },
        };
      },
      request(value) {
        fetch(value.url, { method: value.method, headers: value.header, body: value.data })
          .then(async (response) =>
            value.success({ statusCode: response.status, data: await response.json() }),
          )
          .catch((error) => value.fail({ errMsg: String(error) }));
        return { abort() {} };
      },
    };
    globalThis.__forgeaxGameInspection = {
      renderer: () => ({ phase: 'ready' }),
      read: async (id) =>
        id === 'game-3d.player'
          ? {
              grounded: true,
              position: [0, 1, 0],
              controls: { horizontal: 0, vertical: 0, run: false },
            }
          : { vertexCount: 12 },
      ui: () => ({ ok: true, value: { truncated: false, nodes: [] } }),
    };
    t.after(() => {
      delete globalThis.__forgeaxGameInspection;
      delete globalThis.__forgeaxPhoneGameplayReport;
    });
    const { createPhoneGameplayObserver } = await import(
      pathToFileURL(join(temporary, 'phone_gameplay_transport_probe.mjs'))
    );
    const controller = createPhoneGameplayObserver(options, wx, {
      status: () => ({ bound: true, readyCompletions: 60 }),
      observeOptions: (value) => value,
      bindApp: (value) => value,
      arm() {
        assert.fail('Probe must never arm');
      },
      drain() {
        assert.fail('Probe must never pause/drain');
      },
    });
    const app = {
      pause() {
        assert.fail('Probe must not pause ordinary App');
      },
    };
    controller.observeOptions({
      platform: { now: () => ({ unwrap: () => performance.now() }), visible: () => true },
    });
    assert.equal(controller.bindApp(app), app);
    const summary = await receiver.done;
    const report = JSON.parse(await readFile(join(out, 'phone-report.json'), 'utf8'));
    assert.deepEqual(toggles, [true, false, true]);
    assert.equal(summary.status, scenario === 'success' ? 'complete' : 'partial');
    assert.equal(report.websocket.bidirectionalAfterDebugFalse, scenario === 'success');
    assert.equal(report.capture, undefined);
    assert.equal(report.arm, undefined);
    if (scenario === 'disable-failed') {
      assert.equal(report.connection.firstNativeError.native.errno, 23);
      assert.match(report.failure, /original native error/);
    }
  });
