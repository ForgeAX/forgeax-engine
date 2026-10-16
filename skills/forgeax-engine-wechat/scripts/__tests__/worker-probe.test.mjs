import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { after, test } from 'node:test';
import { buildWorkerProbe } from '../build_worker_probe.mjs';
import { receiveWorkerReport } from '../receive_worker_report.mjs';

const root = process.env.FORGEAX_WORKER_TEST_ENGINE_ROOT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const temporary = await mkdtemp(join(tmpdir(), 'forgeax-worker-test-'));
after(() => rm(temporary, { recursive: true, force: true }));
const publication = join(temporary, 'publication');
const manifest = await buildWorkerProbe({ engineRoot: root, out: publication, runId: 'offline-worker-test' });
const main = await readFile(join(publication, 'game.js'), 'utf8');
const workerSource = await readFile(join(publication, 'workers/probe.js'), 'utf8');
const options = JSON.parse(JSON.stringify(runInNewContext(await readFile(join(publication, 'options.js'), 'utf8'), { module: {} })));
const hash = (value) => createHash('sha256').update(value).digest('hex');

function game({ admitted = false, mode = 'reply', transport = false } = {}) {
  const pending = [], live = [], saved = [], handlers = {}, timers = new Map(), requests = [];
  let nextTimer = 0;
  const wx = {
    env: { isSupportStandardWorker: admitted, USER_DATA_PATH: '/private-test' },
    getSystemInfoSync: () => ({ version: 'offline', SDKVersion: 'offline', platform: 'android', system: 'offline' }),
    getFileSystemManager: () => ({ mkdirSync() {}, writeFileSync(path, body) { saved.push({ path, body }); } }),
    createCanvas: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }),
    request(value) { requests.push(value); return { abort() {} }; },
    createWorker() {
      if (mode === 'second-create-throws' && live.length === 1) throw Error('second Worker rejected');
      const item = { terminated: 0, onMessage(fn) { this.message = fn; }, onError(fn) { this.error = fn; },
        onProcessKilled(fn) { this.killed = fn; }, terminate() { this.terminated++; },
        postMessage(data, transfer) {
          const cloned = structuredClone(data, { transfer });
          pending.push(() => {
            if (mode === 'silent' || mode === 'second-create-throws') return;
            if (mode === 'killed') { this.killed(); return; }
            if (mode === 'wrong-identity') { this.message({ id: 100, runId: data.runId }); return; }
            this.message({ id: cloned.id, runId: cloned.runId, bufferBytes: cloned.buffer.byteLength,
              bufferValues: Array.from(new Uint8Array(cloned.buffer)), errors: [] });
          });
        } };
      live.push(item); return item;
    },
  };
  for (const key of ['Error', 'UnhandledRejection']) {
    wx['on' + key] = (fn) => { handlers[key] = fn; };
    wx['off' + key] = (fn) => { if (handlers[key] === fn) delete handlers[key]; };
  }
  const context = { wx, require: () => ({ ...options, ...(transport ? { reportUrl: 'http://127.0.0.1:19097/worker-test' } : {}) }),
    console: { info() {}, error() {} }, SharedArrayBuffer, Atomics,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  runInNewContext(main, context);
  return { saved, handlers, requests, live, timers, context,
    flush() { while (pending.length) pending.shift()(); },
    expire() { const timer = [...timers.values()].find((row) => row.delay === options.timeoutMs); assert.ok(timer); timer.fn(); },
    report() { assert.equal(saved.length, 1); return JSON.parse(saved[0].body); } };
}

function runWorker(settings = {}) {
  const { canvas, buffer = new Uint8Array([17, 23, 0, 41]).buffer } = settings;
  const atomics = Object.hasOwn(settings, 'atomics') ? settings.atomics : Atomics;
  const replies = [], frames = []; let handler;
  runInNewContext(workerSource, { worker: { onMessage(fn) { handler = fn; }, postMessage(value) { replies.push(structuredClone(value)); } },
    console: { error() {} }, Atomics: atomics, SharedArrayBuffer,
    requestAnimationFrame(fn) { frames.push(fn); } });
  handler({ id: 0, runId: 'offline-worker-test', buffer, shared: new SharedArrayBuffer(8), canvas });
  while (frames.length) frames.shift()();
  assert.equal(replies.length, 1); return replies[0];
}

test('builder binds the actual two entry bytes and preserves an existing output', async () => {
  assert.equal(manifest.source.entrySha256, hash(main));
  assert.equal(manifest.source.workerSha256, hash(workerSource));
  assert.deepEqual(options.source, manifest.source);
  for (const [name, row] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(publication, name)); assert.equal(hash(bytes), row.sha256); assert.equal(bytes.length, row.bytes);
  }
  await assert.rejects(buildWorkerProbe({ engineRoot: root, out: publication, runId: 'replace' }), /EEXIST/);
  assert.equal(await readFile(join(publication, 'game.js'), 'utf8'), main);
  for (const reportUrl of ['http://127.0.0.1:19097/worker\n', 'http://example.invalid/worker'])
    await assert.rejects(buildWorkerProbe({ engineRoot: root, out: join(temporary, 'invalid'), runId: 'test', reportUrl }), /loopback/);
});

test('false admission creates zero Workers and sends the persisted bytes through the shared transport', () => {
  const f = game({ transport: true }), report = f.report();
  assert.equal(report.reason, 'v2-not-admitted'); assert.deepEqual(report.workers, []); assert.equal(f.live.length, 0);
  assert.deepEqual(report.source, manifest.source); assert.deepEqual(report.termination, []);
  assert.deepEqual(Object.keys(f.handlers), []);
  assert.equal(f.requests.length, 1); const req = f.requests[0]; assert.equal(req.data, f.saved[0].body);
  assert.equal(req.header['X-Forgeax-Report-Sha256'], hash(req.data));
  req.success({ statusCode: 200, data: { status: 'saved', bytes: Buffer.byteLength(req.data), sha256: hash(req.data) } });
  assert.equal(f.timers.size, 0);
});

test('admitted mock execution retains actual transfer evidence and terminates each owned Worker once', () => {
  const f = game({ admitted: true }); f.flush(); const r = f.report();
  assert.equal(r.reason, 'two-workers-replied'); assert.deepEqual(r.errors, []);
  assert.deepEqual(r.workers.map((row) => row.senderBufferBytesAfterTransfer), [0, 0]);
  assert.deepEqual(r.workers.map((row) => row.reply.bufferValues), [[17, 23, 0, 41], [17, 23, 1, 41]]);
  assert.deepEqual(f.live.map((entry) => entry.terminated), [1, 1]); assert.equal(f.timers.size, 0);
  f.live[0].message({ id: 0, runId: 'offline-worker-test', errors: [] }); assert.equal(f.saved.length, 1);
});

test('admitted failures and a silent Worker preserve the cause and retire already-created Workers', () => {
  for (const [mode, reason] of [['second-create-throws', 'main-failed'], ['wrong-identity', 'worker-error'], ['killed', 'worker-killed'], ['silent', 'deadline']]) {
    const f = game({ admitted: true, mode }); f.flush(); if (mode === 'silent') f.expire();
    const r = f.report(); assert.equal(r.reason, reason); assert.ok(f.live.every((entry) => entry.terminated === 1));
    if (mode === 'second-create-throws') assert.match(r.errors[0], /second Worker rejected/);
  }
});

test('Worker records missing Atomics and clear/readback capability without promoting callbacks to Engine completions', () => {
  const absent = runWorker({ atomics: undefined }); assert.equal(absent.sharedAtomicAccess, false); assert.deepEqual(absent.errors, []);
  let clears = 0;
  const gl = { COLOR_BUFFER_BIT: 0x4000, VERSION: 1, RENDERER: 2, RGBA: 3, UNSIGNED_BYTE: 4,
    getParameter: () => 'offline', clearColor() {}, clear() { clears++; }, readPixels(x, y, w, h, format, type, pixel) { pixel.set([64, 191, 32, 255]); }, getError: () => 0 };
  const report = runWorker({ canvas: { getContext: () => gl } });
  assert.equal(clears, 60); assert.equal(report.rafCallbacks, 60); assert.equal(report.drawCalls, 60); assert.equal(report.pixelPassed, true);
  const failure = runWorker({ canvas: { getContext() { throw Error('native context rejected'); } } });
  assert.match(failure.errors[0], /native context rejected/);
});

async function endpoint() {
  const server = createServer(); await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise((done) => server.close(done));
  return { port, reportUrl: `http://127.0.0.1:${port}/worker-test` };
}
let receiverId = 0;
async function receiver(deadlineMs = 1500) {
  const ep = await endpoint(); const out = join(temporary, `receiver-${++receiverId}`); let ready;
  const listening = new Promise((done) => { ready = done; });
  const result = receiveWorkerReport({ publication, out, ...ep, deadlineMs, onReady: ready });
  await listening; return { ...ep, out, result };
}
function post(ep, body, changes = {}) {
  return new Promise((done, reject) => {
    const req = request(ep.reportUrl, { method: 'POST', headers: { 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body), 'x-forgeax-report-bytes': String(Buffer.byteLength(body)),
      'x-forgeax-report-sha256': hash(body), ...changes } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (value) => { text += value; });
      res.on('end', () => done({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(body);
  });
}

test('loopback receiver verifies the original report and emits a matching saved receipt', async () => {
  const f = game(); const body = f.saved[0].body; const ep = await receiver(); const response = await post(ep, body);
  assert.equal(response.status, 200); assert.equal(response.body.status, 'saved');
  assert.deepEqual(await ep.result, response.body); assert.equal(await readFile(join(ep.out, 'report.json'), 'utf8'), body);
  assert.deepEqual(JSON.parse(await readFile(join(ep.out, 'receipt.json'), 'utf8')), response.body);
});

test('receiver rejects source/hash drift and oversized requests without publishing report.json', async () => {
  for (const mode of ['source', 'hash', 'size', 'admission']) {
    const report = game().report(); if (mode === 'source') report.source.entrySha256 = '0'.repeat(64);
    if (mode === 'admission') report.facts.standardWorker = true;
    const body = mode === 'size' ? 'x'.repeat(65537) : JSON.stringify(report); const ep = await receiver();
    const response = await post(ep, body, mode === 'hash' ? { 'x-forgeax-report-sha256': '0'.repeat(64) } : {});
    assert.equal(response.status, 400); assert.equal((await ep.result).status, 'rejected');
    assert.deepEqual(await readdir(ep.out), ['receipt.json']);
  }
});

test('receiver deadline closes a stalled request and cannot save a late body', async () => {
  const ep = await receiver(120); const body = game().saved[0].body;
  const socket = connect(ep.port, '127.0.0.1'); socket.on('error', () => {}); socket.resume();
  await new Promise((done) => socket.once('connect', done));
  socket.write(`POST /worker-test HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Forgeax-Report-Bytes: ${Buffer.byteLength(body)}\r\nX-Forgeax-Report-Sha256: ${hash(body)}\r\n\r\n{`);
  assert.equal((await ep.result).status, 'timeout');
  await new Promise((done) => socket.destroyed ? done() : socket.once('close', done));
  assert.deepEqual(await readdir(ep.out), ['receipt.json']);
});

test('an aborted request closes the receiver without waiting for its collection deadline', { timeout: 1000 }, async () => {
  const ep = await receiver(1500); const body = game().saved[0].body;
  const socket = connect(ep.port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise((done) => socket.once('connect', done));
  socket.write(`POST /worker-test HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nX-Forgeax-Report-Bytes: ${Buffer.byteLength(body)}\r\nX-Forgeax-Report-Sha256: ${hash(body)}\r\n\r\n{`);
  await new Promise((done) => setTimeout(done, 20)); socket.destroy();
  assert.equal((await ep.result).status, 'rejected'); assert.deepEqual(await readdir(ep.out), ['receipt.json']);
});

test('receiver refuses a drifted publication before opening its socket', async () => {
  const directory = join(temporary, 'drifted'); await buildWorkerProbe({ engineRoot: root, out: directory, runId: 'drifted' });
  await writeFile(join(directory, 'workers/probe.js'), 'drift');
  await assert.rejects(receiveWorkerReport({ publication: directory, out: join(temporary, 'drift-result'), reportUrl: 'http://127.0.0.1:19097/worker-test' }), /publication drift/);
});
