import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { profileGame, selectTarget, verifyPublication } from './profile_game_cpu.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inspectionKeys = ['assets', 'list', 'read', 'renderer', 'rhiCapture', 'runtimePacks', 'world'];

async function fixture(t, { rejectMethod, badTarget = false, disconnectOnStart = false } = {}) {
  const project = await mkdtemp(join(tmpdir(), 'forgeax-cpu-profile-'));
  const game = Buffer.from('/* ordinary fixture bootstrap */');
  const manifest = Buffer.from(JSON.stringify({ target: 'wechat', artifacts: [{ path: 'game.js', bytes: game.length, sha256: sha256(game) }] }));
  await writeFile(join(project, 'game.js'), game);
  await writeFile(join(project, 'forgeax-dist.json'), manifest);
  let endpoint;
  const requests = [], methods = [], connections = [];
  const target = { url: 'http://game.local/game/s8/_sessionId/simulator-app-session-s8/gamePage.html?token=private-target-token', webSocketDebuggerUrl: '' };
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([
      { url: 'http://game.local/game/s80/target?token=unrelated-secret', webSocketDebuggerUrl: `${endpoint.replace('http:', 'ws:')}/unrelated` },
      ...(badTarget ? [] : [target]),
    ]));
  });
  const sockets = new WebSocketServer({ server });
  let snapshots = 0, closed = 0;
  sockets.on('connection', (socket, request) => {
    connections.push(request.url);
    socket.on('close', () => closed++);
    socket.on('message', bytes => {
      const { id, method } = JSON.parse(bytes);
      methods.push(method);
      if (rejectMethod === method) {
        socket.send(JSON.stringify({ id, error: { code: -32000, message: 'private-server-token https://other-session.invalid' } }));
        return;
      }
      let result = {};
      if (method === 'Runtime.evaluate') {
        snapshots++;
        result = { result: { type: 'object', value: {
          targetPath: '/game/s8/_sessionId/simulator-app-session-s8/gamePage.html', game: true, inspectionKeys,
          renderer: { generation: 7, completed: 100 + snapshots, presented: 100 + snapshots, phase: 'ready', failed: false },
          clockMs: snapshots * 10001, clockOriginMs: 1000,
        } } };
      }
      if (method === 'Profiler.stop') result = { profile: {
        startTime: 1000, endTime: 10001000, samples: [1, 2], timeDeltas: [5000000, 5000000],
        nodes: [
          { id: 1, callFrame: { functionName: 'paint', scriptId: '1', url: 'http://user:private-password@game.local/game/s8/code.js?token=private-token#private-fragment', lineNumber: 0, columnNumber: 0 } },
          { id: 2, callFrame: { functionName: 'other', scriptId: '2', url: 'http://game.local/game/s80/code.js?token=unrelated-secret', lineNumber: 0, columnNumber: 0 } },
        ],
      } };
      socket.send(JSON.stringify({ id, result }));
      if (method === 'Profiler.start' && disconnectOnStart) setTimeout(() => socket.close(), 5);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  target.webSocketDebuggerUrl = `${endpoint.replace('http:', 'ws:')}/selected?token=private-cdp-token`;
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await rm(project, { recursive: true, force: true });
  });
  return {
    options: { project, manifestSha: sha256(manifest), endpoint, window: 's8', out: join(project, 'capture') },
    requests, methods, connections, get closed() { return closed; },
    stopEndpoint: () => new Promise(resolve => server.close(resolve)),
  };
}

test('selection requires one exact requested pathname without connecting to neighbours', () => {
  const options = { endpoint: 'http://127.0.0.1:9422', targetPath: '/game/s8/target' };
  const selected = { url: 'http://game.local/game/s8/target', webSocketDebuggerUrl: 'ws://127.0.0.1:9422/selected' };
  const neighbour = { url: 'http://game.local/game/s80/target', webSocketDebuggerUrl: 'ws://127.0.0.1:9422/other' };
  assert.equal(selectTarget([neighbour, selected], options), selected.webSocketDebuggerUrl);
  assert.throws(() => selectTarget([neighbour], options), { code: 'target-not-found' });
  assert.throws(() => selectTarget([selected, selected], options), { code: 'target-ambiguous' });
  assert.throws(() => selectTarget([{ ...selected, webSocketDebuggerUrl: 'ws://other.invalid:9422/selected' }], options), { code: 'target-websocket-origin-mismatch' });
});

test('refuses publication mismatch and invalid sampling bounds before discovery', async t => {
  const f = await fixture(t);
  for (const durationMs of [9999, 20001, NaN]) await assert.rejects(profileGame({ ...f.options, durationMs }), { code: 'duration-must-be-10000-to-20000-ms' });
  await writeFile(join(f.options.project, 'game.js'), 'modified bootstrap');
  await assert.rejects(verifyPublication(f.options.project, f.options.manifestSha), { code: 'publication-bootstrap-mismatch' });
  const result = await profileGame(f.options, { emit() {} });
  assert.equal(result.failure.code, 'publication-bootstrap-mismatch');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.connections, []);
});

test('successful bounded sample emits its start and retains only selected sanitized evidence', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const events = [];
  const result = await profileGame(f.options, { emit: event => events.push(event) });
  assert.equal(result.success, true);
  assert.equal(events[0].phase, 'sampling-started');
  assert.equal(events[0].window, 's8');
  assert.equal(result.requestedDurationMs, 10000);
  assert.deepEqual(result.profilerInspection, { status: 'unavailable', keys: inspectionKeys, selection: 'explicit-v8-cpu-sample' });
  assert.deepEqual(result.cleanup, { stop: 'complete', disable: 'complete', socketClosed: true });
  assert.deepEqual(f.methods, ['Runtime.evaluate', 'Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop', 'Runtime.evaluate', 'Profiler.disable']);
  assert.deepEqual(f.requests, ['/json/list']);
  assert.equal(f.connections.length, 1);
  assert.equal(f.closed, 1);
  assert.ok(f.connections[0].startsWith('/selected?'));
  const profile = JSON.parse(await readFile(join(f.options.out, 'profile.cpuprofile'), 'utf8'));
  assert.equal(profile.nodes[0].callFrame.url, 'http://game.local/game/s8/code.js');
  assert.equal(profile.nodes[1].callFrame.url, '[other-game-target]');
  const evidence = JSON.stringify(events) + JSON.stringify(profile) + await readFile(join(f.options.out, 'summary.json'), 'utf8');
  assert.doesNotMatch(evidence, /private-|unrelated-secret|s80|other-session/);
});

test('interruption stops, disables and closes the one active socket', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const result = await profileGame(f.options, {
    signal: controller.signal,
    emit(event) { if (event.phase === 'sampling-started') controller.abort(); },
  });
  assert.equal(result.success, false);
  assert.equal(result.failure.code, 'interrupted');
  assert.deepEqual(f.methods.slice(-2), ['Profiler.stop', 'Profiler.disable']);
  assert.deepEqual(result.cleanup, { stop: 'complete', disable: 'complete', socketClosed: true });
  assert.equal(f.connections.length, 1);
  assert.equal(f.closed, 1);
});

test('rejected start still attempts stop and disable without printing native errors', async t => {
  const f = await fixture(t, { rejectMethod: 'Profiler.start' });
  const events = [];
  const result = await profileGame(f.options, { emit: value => events.push(value) });
  assert.equal(result.success, false);
  assert.equal(result.failure.code, 'cdp-command-rejected');
  assert.deepEqual(f.methods.slice(-2), ['Profiler.stop', 'Profiler.disable']);
  assert.equal(result.cleanup.socketClosed, true);
  assert.doesNotMatch(JSON.stringify(events), /private-|other-session/);
});

test('missing exact target does not attach to another session', async t => {
  const f = await fixture(t, { badTarget: true });
  const result = await profileGame(f.options, { emit() {} });
  assert.equal(result.failure.code, 'target-not-found');
  assert.deepEqual(f.connections, []);
  assert.deepEqual(result.cleanup, { stop: 'not-started', disable: 'not-enabled', socketClosed: true });
});

test('unavailable endpoint returns a structured failure without opening another endpoint', async t => {
  const f = await fixture(t);
  await f.stopEndpoint();
  const result = await profileGame(f.options, { emit() {} });
  assert.equal(result.failure.code, 'endpoint-unavailable');
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.connections, []);
});

test('CLI through a symlink writes the unavailable summary instead of silently skipping main', async t => {
  const f = await fixture(t);
  await f.stopEndpoint();
  const realDirectory = join(f.options.project, 'real-cli');
  await mkdir(realDirectory);
  const script = join(realDirectory, 'profile_game_cpu.mjs');
  await copyFile(fileURLToPath(new URL('./profile_game_cpu.mjs', import.meta.url)), script);
  const direct = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(direct.status, 0);
  assert.match(direct.stdout, /Usage: node profile_game_cpu\.mjs/);
  const linkedDirectory = join(f.options.project, 'tmp');
  await symlink(realDirectory, linkedDirectory, 'dir');
  const linkedFile = join(f.options.project, 'linked-profile.mjs');
  await symlink(script, linkedFile, 'file');
  for (const [kind, entry] of [['directory', join(linkedDirectory, 'profile_game_cpu.mjs')], ['file', linkedFile]]) {
    const out = join(f.options.project, `capture-${kind}`);
    const child = spawnSync(process.execPath, [entry,
      '--window', f.options.window, '--project', f.options.project,
      '--manifest-sha', f.options.manifestSha, '--endpoint', f.options.endpoint, '--out', out,
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, `${kind} symlink must execute the CLI and report endpoint unavailability`);
    assert.equal(child.stderr, '');
    const result = JSON.parse(child.stdout);
    assert.equal(result.phase, 'complete');
    assert.equal(result.failure.code, 'endpoint-unavailable');
    assert.deepEqual(JSON.parse(await readFile(join(out, 'summary.json'), 'utf8')), Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'phase')));
    await assert.rejects(readFile(join(out, 'profile.cpuprofile')), { code: 'ENOENT' });
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.connections, []);
});

test('rejected enable is still disabled and its socket is closed', async t => {
  const f = await fixture(t, { rejectMethod: 'Profiler.enable' });
  const result = await profileGame(f.options, { emit() {} });
  assert.equal(result.failure.code, 'cdp-command-rejected');
  assert.deepEqual(f.methods, ['Runtime.evaluate', 'Profiler.enable', 'Profiler.disable']);
  assert.deepEqual(result.cleanup, { stop: 'not-started', disable: 'complete', socketClosed: true });
});

test('a lost sampling transport ends early and preserves failed stop/disable evidence', async t => {
  const f = await fixture(t, { disconnectOnStart: true });
  const started = performance.now();
  const result = await profileGame(f.options, { emit() {} });
  assert.ok(performance.now() - started < 3000);
  assert.equal(result.failure.code, 'cdp-socket-closed');
  assert.deepEqual(result.cleanup, { stop: 'cdp-socket-closed', disable: 'cdp-socket-closed', socketClosed: true });
});
