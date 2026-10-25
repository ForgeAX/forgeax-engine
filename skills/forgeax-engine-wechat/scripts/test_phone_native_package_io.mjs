import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeNativePackageIo } from './phone_native_package_io.js';

function fixture() {
  const requests = [];
  const fs = { readFile(options) { requests.push({ receiver: this, options }); return 'native-read'; },
    readCompressedFile(options) { requests.push({ receiver: this, options }); return 'native-br'; } };
  const wx = { getFileSystemManager() { return fs; }, loadSubpackage(options) { requests.push({ receiver: this, options }); return 'native-package'; } };
  const original = { factory: wx.getFileSystemManager, load: wx.loadSubpackage, read: fs.readFile };
  return { wx, fs, requests, original, observer: observeNativePackageIo(wx) };
}

test('observes a native module failure with accessor fields and preserves its callback identity', () => {
  const f = fixture();
  let received, receiver;
  const error = Object.defineProperties({}, {
    errMsg: { get: () => 'loadSubpackage:fail module not found' },
    loadInfo: { get: () => ({ module: 'payload/game.js' }) },
  });
  assert.equal(f.wx.loadSubpackage({ name: 'payload', fail(value) { received = value; receiver = this; return 7; } }), 'native-package');
  assert.equal(f.observer.report.pending[1].target, 'payload');
  assert.equal(f.requests[0].options.fail.call(f.wx, error), 7);
  assert.equal(received, error);
  assert.equal(receiver, f.wx);
  assert.equal(f.observer.report.recent[0].error.value.errMsg, 'loadSubpackage:fail module not found');
  assert.equal(f.observer.report.recent[0].error.value.loadInfo.module, 'payload/game.js');
  assert.equal(f.observer.report.completed, 1);
  assert.deepEqual(f.observer.report.pending, {});
});

test('retains package read boundaries, native result, option descriptors and callback throws', () => {
  const f = fixture(), data = { data: new ArrayBuffer(8) }, thrown = {};
  let result;
  const options = Object.defineProperties({}, {
    filePath: { value: 'payload/assets/test.pack.json.br', enumerable: true },
    compressionAlgorithm: { value: 'br' },
    success: { value(value) { result = value; throw thrown; }, enumerable: true },
  });
  assert.equal(f.wx.getFileSystemManager().readCompressedFile(options), 'native-br');
  assert.equal(f.requests[0].receiver, f.fs);
  assert.equal(Object.getOwnPropertyDescriptor(f.requests[0].options, 'compressionAlgorithm').enumerable, false);
  assert.throws(() => f.requests[0].options.success(data), error => error === thrown);
  assert.equal(result, data);
  assert.equal(f.observer.report.recent[0].bytes, 8);
  assert.equal(f.observer.report.recent[0].callbackThrew, true);
  assert.equal(f.observer.report.completed, 1);
});

test('ignores user files and callback accessors without invoking them', () => {
  const f = fixture();
  const options = { filePath: '/user/report.json' };
  f.wx.getFileSystemManager().readFile(options);
  assert.equal(f.requests[0].options, options);
  let calls = 0;
  const accessor = Object.defineProperty({ filePath: 'payload/file.br' }, 'success', { get() { calls++; return () => {}; } });
  f.fs.readFile(accessor);
  assert.equal(f.requests[1].options, accessor);
  assert.equal(calls, 0);
  assert.equal(f.observer.report.started, 0);
});

test('bounds pending reads and native error getters', () => {
  const f = fixture();
  for (let i = 0; i < 130; i++) f.wx.getFileSystemManager().readFile({ filePath: 'payload/a.br' });
  assert.equal(Object.keys(f.observer.report.pending).length, 128);
  assert.equal(f.observer.report.dropped, 2);
  const error = Object.defineProperties({}, {
    errMsg: { get: () => 'x'.repeat(20000) },
    loadInfo: { get() { throw Error('native unavailable'); } },
  });
  f.requests[0].options.fail(error);
  const captured = f.observer.report.recent[0].error;
  assert.equal(captured.value.errMsg.length, 4096);
  assert.equal(captured.truncated, true);
  assert.equal(captured.value.loadInfo.unavailable, 'native-getter-threw');
});

test('uninspectable options and inherited callbacks retain the original native call', () => {
  const f = fixture();
  const proxy = new Proxy({}, { ownKeys() { throw Error('uninspectable'); } });
  assert.equal(f.wx.loadSubpackage(proxy), 'native-package');
  assert.equal(f.requests[0].options, proxy);
  const inherited = Object.assign(Object.create({ success() {} }), { name: 'payload' });
  assert.equal(f.wx.loadSubpackage(inherited), 'native-package');
  assert.equal(f.requests[1].options, inherited);
  assert.equal(f.observer.report.started, 0);
  assert.equal(f.observer.report.optionInspectionFailed, 1);
});

test('restores owned hooks, preserves later owners and ignores late completion', () => {
  const f = fixture();
  let called = 0;
  f.wx.getFileSystemManager().readFile({ filePath: 'payload/a.br', success() { called++; } });
  const later = () => 'later';
  f.fs.readFile = later;
  f.observer.release(); f.observer.release();
  assert.equal(f.wx.loadSubpackage, f.original.load);
  assert.equal(f.wx.getFileSystemManager, f.original.factory);
  assert.equal(f.fs.readFile, later);
  f.requests[0].options.success({ data: new ArrayBuffer(8) });
  assert.equal(called, 1);
  assert.equal(f.observer.report.completed, 0);
});
