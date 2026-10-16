import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../fixtures/rhi-capture/export.js', import.meta.url), 'utf8');
const key = '__forgeaxRhiCaptureExport';
const start = { operation: 'start', id: 'test', chunkBytes: 3, maxBytes: 100, timeoutMs: 1000, snapshotTimeoutMs: 100 };
function fixture(overrides = {}) {
  let resolveCapture;
  let signal;
  let captureOptions;
  const timers = new Set();
  const files = new Map();
  const writes = [];
  const fs = {
    writeFile({ filePath, data, success }) {
      writes.push(data.byteLength);
      files.set(filePath, Buffer.from(data));
      queueMicrotask(() => success({}));
    },
    appendFile({ filePath, data, success }) {
      writes.push(data.byteLength);
      files.set(filePath, Buffer.concat([files.get(filePath), Buffer.from(data)]));
      queueMicrotask(() => success({}));
    },
    stat({ path, success }) { queueMicrotask(() => success({ stats: { size: files.get(path)?.length } })); },
    unlink({ filePath, success }) { files.delete(filePath); queueMicrotask(() => success({})); },
    ...overrides,
  };
  const game = { __forgeaxGameInspection: { renderer: () => ({ generation: 1 }), rhiCapture: {
    captureFrame: options => {
      captureOptions = options;
      signal = options.signal;
      return new Promise(resolve => { resolveCapture = resolve; });
    },
  } } };
  const operate = runInNewContext(`(${source})`, {
    GameGlobal: { __gameContextWindow: game }, AbortController,
    wx: { arrayBufferToBase64: bytes => Buffer.from(bytes).toString('base64'),
      getFileSystemManager: () => fs, env: { USER_DATA_PATH: 'http://usr' } },
    setTimeout: callback => { timers.add(callback); return callback; },
    clearTimeout: callback => timers.delete(callback),
  });
  return { game, timers, files, writes, get signal() { return signal; },
    get captureOptions() { return captureOptions; },
    call: request => {
      const result = operate({ id: 'test', ...request });
      return result?.then ? result.then(value => JSON.parse(JSON.stringify(value))) : JSON.parse(JSON.stringify(result));
    },
    settle: async value => { resolveCapture(value); await new Promise(resolve => setImmediate(resolve)); },
  };
}
function artifact(data) {
  return { byteLength: data.length, digest: 'sha256:' + createHash('sha256').update(data).digest('hex'),
    get bytes() { throw new Error('contiguous bytes must not be read'); },
    *chunks(size) {
      for (let offset = 0; offset < data.length; offset += size) yield { offset, bytes: data.subarray(offset, offset + size) };
    },
  };
}

test('streams chunks, retries the same offset and releases the single borrowed artifact', async () => {
  const f = fixture();
  assert.equal(f.call(start).phase, 'capturing');
  await Promise.resolve();
  const tape = artifact(Uint8Array.of(1, 2, 3, 4, 5));
  await f.settle({ ok: true, value: tape });
  const metadata = f.call({ operation: 'status' });
  assert.equal(metadata.digest, tape.digest);
  const first = f.call({ operation: 'chunk', offset: 0 });
  assert.deepEqual(f.call({ operation: 'chunk', offset: 0 }), first);
  assert.equal(first.data, 'AQID');
  assert.equal(f.call({ operation: 'chunk', offset: 3 }).data, 'BAU=');
  assert.equal(f.call({ operation: 'chunk', offset: 5 }).phase, 'complete');
  assert.equal(f.call({ operation: 'release' }).phase, 'released');
  assert.equal(f.game[key], undefined);
  assert.equal(f.signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test('keeps each base64 result below the observed official stdout limit and rejects large chunks', async () => {
  const f = fixture();
  assert.equal(f.call({ ...start, chunkBytes: 256 * 1024 }).error.code, 'capture-export-chunk-size');
  f.call({ ...start, chunkBytes: 16 * 1024, maxBytes: 32 * 1024 });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(new Uint8Array(20 * 1024)) });
  const first = f.call({ operation: 'chunk', offset: 0 });
  assert.equal(first.byteLength, 16 * 1024);
  const envelope = JSON.stringify({ ok: true, result: { success: true, result: first } });
  assert.ok(envelope.length < 32 * 1024);
  assert.equal(f.call({ operation: 'chunk', offset: 16 * 1024 }).byteLength, 4 * 1024);
  f.call({ operation: 'release' });
});

test('release fences a late successful capture before reading its artifact', async () => {
  const f = fixture();
  f.call(start);
  await Promise.resolve();
  f.call({ operation: 'release' });
  await f.settle({ ok: true, get value() { throw new Error('late artifact retained'); } });
  assert.equal(f.game[key], undefined);
  assert.equal(f.timers.size, 0);
});

test('forwards explicit seed omission without changing the bounded snapshot deadline', async () => {
  const f = fixture();
  f.call({ ...start, seedMaxResourceBytes: 0 });
  await Promise.resolve();
  assert.equal(f.captureOptions.seed.maxResourceBytes, 0);
  assert.equal(f.captureOptions.snapshotTimeoutMs, start.snapshotTimeoutMs);
  f.call({ operation: 'release' });
  await f.settle({ ok: true, value: artifact(Uint8Array.of(1)) });
});

test('drops artifact references even when iterator release throws', async () => {
  const f = fixture();
  f.call(start);
  await Promise.resolve();
  const tape = artifact(Uint8Array.of(1));
  tape.chunks = () => ({ [Symbol.iterator]() { return { return() { throw new Error('release failed'); } }; } });
  await f.settle({ ok: true, value: tape });
  const state = f.game[key];
  assert.throws(() => f.call({ operation: 'release' }), /release failed/);
  assert.equal(state.artifact, undefined);
  assert.equal(state.iterator, undefined);
  assert.equal(state.last, undefined);
  assert.equal(f.game[key], undefined);
  assert.equal(f.signal.aborted, true);
  assert.equal(f.timers.size, 0);
});

test('generation replacement aborts pending capture and cannot attach old output to the new game', async () => {
  const f = fixture();
  f.call(start);
  await Promise.resolve();
  f.game.__forgeaxGameInspection = { renderer: () => ({ generation: 2 }) };
  await f.settle({ ok: true, value: artifact(Uint8Array.of(1)) });
  assert.equal(f.game[key], undefined);
  assert.equal(f.signal.aborted, true);
});

test('refuses concurrent export, stale readers and cleans up an abandoned export', async () => {
  const f = fixture();
  f.call(start);
  assert.equal(f.call(start).error.code, 'capture-export-busy');
  assert.equal(f.call({ operation: 'release', id: 'other' }).error.code, 'capture-export-identity');
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(Uint8Array.of(1)) });
  assert.equal(f.call({ operation: 'chunk', offset: 2 }).error.code, 'capture-export-offset');
  for (const callback of [...f.timers]) callback();
  assert.equal(f.game[key], undefined);
  assert.equal(f.signal.aborted, true);
});

test('writes one native window using bounded buffers and releases every unacknowledged file', async () => {
  const f = fixture();
  f.call({ ...start, nativeFile: true, maxBytes: 1024 * 1024 });
  await Promise.resolve();
  const data = new Uint8Array(300 * 1024).fill(173);
  const tape = artifact(data);
  await f.settle({ ok: true, value: tape });
  const metadata = f.call({ operation: 'status' });
  assert.equal(metadata.phase, 'native-window');
  assert.equal(metadata.virtualPath, 'http://usr/forgeax-rhi-test.rhitape');
  assert.equal(metadata.length, data.length);
  assert.equal(metadata.byteLength, data.length);
  assert.equal(metadata.offset, 0);
  assert.equal(metadata.digest, tape.digest);
  assert.ok(JSON.stringify(metadata).length < 1024);
  assert.deepEqual(f.writes, [256 * 1024, 44 * 1024]);
  assert.deepEqual(f.files.get(metadata.virtualPath), Buffer.from(data));
  const state = f.game[key];
  assert.equal((await f.call({ operation: 'release' })).phase, 'released');
  assert.equal(state.artifact, undefined);
  assert.equal(state.iterator, undefined);
  assert.equal(f.files.size, 0);
  assert.equal(f.game[key], undefined);
});

test('exports a multi-window artifact under a 1 MiB quota and advances only once per verified ACK', async () => {
  let peak = 0;
  const f = fixture({ appendFile({ filePath, data, success, fail }) {
    const next = Buffer.concat([f.files.get(filePath), Buffer.from(data)]);
    if (next.length > 1024 * 1024) { fail({ errMsg: 'quota exceeded' }); return; }
    f.files.set(filePath, next);
    peak = Math.max(peak, next.length);
    queueMicrotask(() => success({}));
  } });
  const data = Uint8Array.from({ length: 2 * 1024 * 1024 + 123 }, (_, index) => index % 251);
  const tape = artifact(data);
  f.call({ ...start, nativeFile: true, maxBytes: data.length });
  await Promise.resolve();
  await f.settle({ ok: true, value: tape });
  const first = f.call({ operation: 'status' });
  assert.equal(first.length, 1024 * 1024);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.call({ operation: 'status' }), first, 'withholding ACK must keep the same window');
  const copy = [f.files.get(first.virtualPath)];
  const ack = { operation: 'ack', generation: 1, offset: 0, length: first.length };
  assert.equal(f.call({ ...ack, length: 1 }).error.code, 'capture-export-ack');
  assert.equal(f.call({ ...ack, offset: first.length }).error.code, 'capture-export-ack');
  assert.equal(f.call({ ...ack, generation: 2 }).error.code, 'capture-export-generation');
  assert.equal(f.call(ack).phase, 'writing');
  assert.equal(f.call(ack).phase, 'writing', 'lost ACK reply must be safe to retry during unlink');
  await new Promise(resolve => setImmediate(resolve));
  const second = f.call({ operation: 'status' });
  assert.equal(second.offset, first.length);
  assert.deepEqual(f.call(ack), second, 'duplicate ACK must not delete the next window');
  copy.push(f.files.get(second.virtualPath));
  f.call({ ...ack, offset: second.offset });
  await new Promise(resolve => setImmediate(resolve));
  const last = f.call({ operation: 'status' });
  assert.equal(last.length, 123);
  assert.equal(f.call(ack).error.code, 'capture-export-ack', 'older ACK is rejected');
  copy.push(f.files.get(last.virtualPath));
  const finalAck = { ...ack, offset: last.offset, length: last.length };
  f.call(finalAck);
  await new Promise(resolve => setImmediate(resolve));
  const complete = f.call({ operation: 'status' });
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.offset, data.length);
  assert.equal(complete.digest, tape.digest);
  assert.deepEqual(f.call(finalAck), complete);
  assert.equal(f.files.size, 0);
  assert.equal(peak, 1024 * 1024);
  assert.deepEqual(Buffer.concat(copy), Buffer.from(data));
  await f.call({ operation: 'release' });
});

test('removes a partial native file after a write failure', async () => {
  const f = fixture({ appendFile({ fail }) { queueMicrotask(() => fail({ errMsg: 'quota exceeded' })); } });
  f.call({ ...start, nativeFile: true, maxBytes: 1024 * 1024 });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(new Uint8Array(300 * 1024)) });
  assert.equal(f.call({ operation: 'status' }).error.code, 'capture-export-native-file');
  await f.call({ operation: 'release' });
  assert.equal(f.files.size, 0);
  assert.equal(f.game[key], undefined);
});

test('removes a partial file left by the first failed native write', async () => {
  const f = fixture({ writeFile({ filePath, fail }) {
    f.files.set(filePath, Buffer.from([0]));
    queueMicrotask(() => fail({ errMsg: 'first write partially completed' }));
  } });
  f.call({ ...start, nativeFile: true });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(Uint8Array.of(1, 2, 3)) });
  assert.equal(f.call({ operation: 'status' }).error.code, 'capture-export-native-file');
  await f.call({ operation: 'release' });
  assert.equal(f.files.size, 0);
});

test('retains the original native write cause when partial-file cleanup also fails', async () => {
  let denyUnlink = true;
  const f = fixture({
    appendFile({ fail }) { queueMicrotask(() => fail({ errMsg: 'write quota exceeded' })); },
    unlink({ filePath, fail, success }) {
      if (denyUnlink) queueMicrotask(() => fail({ errMsg: 'cleanup permission denied' }));
      else { f.files.delete(filePath); queueMicrotask(() => success({})); }
    },
  });
  f.call({ ...start, nativeFile: true, maxBytes: 1024 * 1024 });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(new Uint8Array(300 * 1024)) });
  const error = f.call({ operation: 'status' }).error;
  assert.equal(error.code, 'capture-export-native-file-cleanup');
  assert.equal(error.detail.cause.errMsg, 'write quota exceeded');
  assert.equal(error.detail.cleanupError.errMsg, 'cleanup permission denied');
  assert.equal((await f.call({ operation: 'release' })).phase, 'failed');
  assert.equal((await f.call({ operation: 'release' })).phase, 'failed');
  assert.ok(f.game[key], 'failed unlink cannot forget ownership and fake a successful retry');
  assert.equal(f.files.size, 1);
  denyUnlink = false;
  assert.equal((await f.call({ operation: 'release' })).phase, 'released');
  assert.equal(f.game[key], undefined);
  assert.equal(f.files.size, 0);
});

test('aborts a pending native write and deletes its late file before release completes', async () => {
  let finish;
  const f = fixture({ writeFile({ filePath, data, success }) {
    finish = () => { f.files.set(filePath, Buffer.from(data)); success({}); };
  } });
  f.call({ ...start, nativeFile: true });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(Uint8Array.of(1, 2, 3)) });
  assert.equal(f.call({ operation: 'status' }).phase, 'writing');
  const state = f.game[key];
  const released = f.call({ operation: 'release' });
  assert.equal(state.artifact, undefined);
  assert.equal(f.game[key].phase, 'released');
  let retriedFinished = false;
  const retried = f.call({ operation: 'release' }).then(() => { retriedFinished = true; });
  await Promise.resolve();
  assert.equal(retriedFinished, false);
  finish();
  assert.equal((await released).phase, 'released');
  await retried;
  assert.equal(f.files.size, 0);
  assert.equal(f.game[key], undefined);
});

test('release during ACK unlink waits for that deletion and never writes the next window', async () => {
  let finish;
  const f = fixture({ unlink({ filePath, success }) {
    finish = () => { f.files.delete(filePath); success({}); };
  } });
  f.call({ ...start, nativeFile: true, maxBytes: 2 * 1024 * 1024 });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(new Uint8Array(2 * 1024 * 1024)) });
  f.call({ operation: 'ack', generation: 1, offset: 0, length: 1024 * 1024 });
  const released = f.call({ operation: 'release' });
  assert.equal(f.files.size, 1);
  finish();
  assert.equal((await released).phase, 'released');
  assert.equal(f.writes.length, 4);
  assert.equal(f.files.size, 0);
  assert.equal(f.game[key], undefined);
});

test('generation replacement at an unacknowledged native window deletes it without progressing', async () => {
  const f = fixture();
  f.call({ ...start, nativeFile: true, maxBytes: 2 * 1024 * 1024 });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(new Uint8Array(2 * 1024 * 1024)) });
  f.game.__forgeaxGameInspection = { renderer: () => ({ generation: 2 }) };
  const result = await f.call({ operation: 'ack', generation: 1, offset: 0, length: 1024 * 1024 });
  assert.equal(result.error.code, 'capture-export-generation');
  assert.equal(f.writes.length, 4);
  assert.equal(f.files.size, 0);
  assert.equal(f.game[key], undefined);
});

test('refuses an iterator that ends before acknowledged total size and removes its partial window', async () => {
  const f = fixture();
  f.call({ ...start, nativeFile: true });
  await Promise.resolve();
  const tape = artifact(Uint8Array.of(1));
  tape.byteLength = 2;
  await f.settle({ ok: true, value: tape });
  assert.equal(f.call({ operation: 'status' }).error.code, 'capture-export-native-file');
  assert.equal(f.files.size, 0);
  await f.call({ operation: 'release' });
});

test('refuses a native file with the wrong length and removes unacknowledged completed files', async () => {
  const failed = fixture({ stat({ success }) { queueMicrotask(() => success({ stats: { size: 9 } })); } });
  failed.call({ ...start, nativeFile: true });
  await Promise.resolve();
  await failed.settle({ ok: true, value: artifact(Uint8Array.of(1)) });
  assert.equal(failed.call({ operation: 'status' }).error.code, 'capture-export-native-file');
  assert.equal(failed.files.size, 0);
  await failed.call({ operation: 'release' });
  const f = fixture();
  f.call({ ...start, nativeFile: true });
  await Promise.resolve();
  await f.settle({ ok: true, value: artifact(Uint8Array.of(1)) });
  await f.call({ operation: 'release' });
  assert.equal(f.files.size, 0);
});
