import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const toolRoot = process.env.FORGEAX_TOOL_ROOT ?? process.cwd();
const require = createRequire(await realpath(join(toolRoot, 'node_modules/tsup/dist/index.js')));
const { build } = require('esbuild');
const hostRequire = createRequire(join(toolRoot, 'packages/platform-wechat/package.json'));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../phone_report_recovery.mjs', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'neutral',
  format: 'iife',
  globalName: 'Recovery',
  target: 'chrome70',
  alias: {
    '@noble/hashes/sha2.js': hostRequire.resolve('@noble/hashes/sha2.js'),
    '@exodus/bytes/utf8.js': join(dirname(hostRequire.resolve('@exodus/bytes/utf8.js')), 'utf8.js'),
  },
});
const scope = { setTimeout, clearTimeout, ArrayBuffer, Uint8Array, console: { info() {} } };
// No browser performance, TextEncoder, TextDecoder, DOM, require or Host globals.
vm.runInNewContext(bundle.outputFiles[0].text, scope);
const { recoverPhoneReports } = scope.Recovery;
const path = 'wxfile://usr/forgeax-gameplay-123-abc/report.json';
const reportUrl = 'http://127.0.0.1:18778/recovery/report';

function fixture(
  body = '{\n "status":"partial", "failure":"\u8ba1\u65f6\u4e0d\u53ef\u7528 😀", "source":{"manifestSha256":"abc"}\n}\n',
) {
  const bytes = Buffer.from(body);
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const calls = { reads: [], stats: [], requests: [], popups: [] };
  const fs = {
    statSync(file) {
      calls.stats.push(file);
      return { size: bytes.length, isFile: () => true };
    },
    readFileSync(file) {
      calls.reads.push(file);
      return raw;
    },
    writeFileSync() {
      assert.fail('Recovery must never modify the source file');
    },
  };
  const wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager: () => fs,
    getAppBaseInfo: () => ({ enableDebug: true }),
    setEnableDebug() {
      assert.fail('Recovery must never change debug mode');
    },
    showModal(options) {
      calls.popups.push(options.content);
      options.success({ confirm: true });
    },
    request(options) {
      calls.requests.push(options);
      options.success({ statusCode: 200, data: { status: 'saved', bytes: bytes.length, sha256 } });
      return {
        abort() {
          assert.fail('Successful transfer must not abort');
        },
      };
    },
  };
  return { body, bytes, sha256, wx, fs, calls };
}

test('native recovery retains exact original bytes, verifies SHA and uses the existing receipt protocol', async () => {
  const f = fixture();
  const state = await recoverPhoneReports(f.wx, {
    reports: [{ path, bytes: f.bytes.length, sha256: f.sha256 }],
    reportUrl,
  });
  assert.equal(state.status, 'complete');
  assert.equal(state.reports[0].status, 'verified');
  assert.equal(state.reports[0].transfer.status, 'sent');
  assert.equal(state.reports[0].sha256, f.sha256);
  assert.equal(state.reports[0].summary.failure, '\u8ba1\u65f6\u4e0d\u53ef\u7528 😀');
  assert.equal(f.calls.requests[0].data, f.body);
  assert.equal(f.calls.requests[0].header['X-Forgeax-Report-Sha256'], f.sha256);
  assert.equal(f.calls.requests[0].header['X-Forgeax-Report-Bytes'], String(f.bytes.length));
  assert.ok(f.calls.popups.every((page) => page.length <= 700));
});

test('rejects unowned, nested, escaped, duplicate and oversized requests before reading contents', async () => {
  for (const bad of [
    'wxfile://usr-other/forgeax-gameplay-123/report.json',
    'wxfile://usr/forgeax-other-123/report.json',
    'wxfile://usr/forgeax-gameplay-123/../report.json',
    'wxfile://usr/forgeax-gameplay-%2e%2e/report.json',
    `${path}\n`,
  ]) {
    const f = fixture();
    const state = await recoverPhoneReports(f.wx, { reports: [{ path: bad }], popup: false });
    assert.equal(state.status, 'failed', bad);
    assert.equal(f.calls.reads.length, 0);
    assert.equal(f.calls.stats.length, 0);
  }
  const f = fixture();
  assert.equal(
    (await recoverPhoneReports(f.wx, { reports: [{ path }, { path }], popup: false })).status,
    'failed',
  );
  f.fs.statSync = () => ({ size: 24 * 1024 * 1024 + 1, isFile: () => true });
  assert.equal(
    (await recoverPhoneReports(f.wx, { reports: [{ path }], popup: false })).status,
    'failed',
  );
  assert.equal(f.calls.reads.length, 0);
});

test('mismatching expected SHA preserves actual identity and does not send; failed receipt stays failed', async () => {
  const f = fixture();
  const state = await recoverPhoneReports(f.wx, {
    reports: [{ path, sha256: '0'.repeat(64) }],
    reportUrl,
  });
  assert.equal(state.reports[0].error, 'expected-sha256-mismatch');
  assert.equal(state.reports[0].sha256, f.sha256);
  assert.equal(state.reports[0].summary.source.manifestSha256, 'abc');
  assert.equal(f.calls.requests.length, 0);
  f.wx.request = (options) =>
    options.success({
      statusCode: 200,
      data: { status: 'saved', bytes: f.bytes.length, sha256: '0'.repeat(64) },
    });
  const failed = await recoverPhoneReports(f.wx, { reports: [{ path }], reportUrl, popup: false });
  assert.equal(failed.reports[0].transfer.status, 'failed');
  assert.equal(failed.reports[0].transfer.reason, 'receipt-mismatch');
});

test('debug false leaves the original report readable and never changes native debug state', async () => {
  const f = fixture();
  f.wx.getAppBaseInfo = () => ({ enableDebug: false });
  const state = await recoverPhoneReports(f.wx, { reports: [{ path }], reportUrl });
  assert.equal(state.reports[0].status, 'verified');
  assert.equal(state.reports[0].transfer.reason, 'debug-not-enabled-at-recovery-start');
  assert.equal(f.calls.requests.length, 0);
  assert.ok(f.calls.popups.length > 0);
});

test('popup summaries stay bounded and split without broken Unicode pairs', async () => {
  const f = fixture(
    JSON.stringify({
      status: 'partial',
      failure: '😀'.repeat(2000),
      source: { manifestSha256: 'b'.repeat(10000) },
    }),
  );
  const state = await recoverPhoneReports(f.wx, { reports: [{ path }] });
  assert.equal(state.popup.status, 'complete');
  assert.ok(f.calls.popups.length > 1);
  for (const page of f.calls.popups) {
    assert.ok(page.length <= 700);
    assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(page), false);
  }
});
