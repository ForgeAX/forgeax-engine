import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bundlePhoneGlLink } from './bundle_phone_gl_link.mjs';

const prefix = await bundlePhoneGlLink();
function fixture(options = {}) {
  const { frozen, fail } = options;
  const status = Object.hasOwn(options, 'status') ? options.status : true;
  const logs = [], calls = [], timers = new Map();
  let timerId = 0;
  const originalError = new Error('original native exception');
  const program = {}, vertex = {}, fragment = {}, result = {};
  const sources = ['#version 300 es\n// vertex caf\u00e9 \ud83d\udef0\nvoid main() {}', '#version 300 es\nvoid main() {}'];
  const gl = {
    LINK_STATUS: 1, COMPILE_STATUS: 2, SHADER_TYPE: 3, MAX_VERTEX_ATTRIBS: 4,
    linkProgram(...args) { calls.push(['link', this, args]); if (fail === 'link') throw originalError; return result; },
    getProgramParameter(...args) {
      const index = calls.filter(([name]) => name === 'program').length;
      calls.push(['program', this, args]);
      if (fail === 'query' && index > 0) throw originalError;
      return options.queryResults ? options.queryResults[index] : status;
    },
    getProgramInfoLog() { assert.equal(this, gl); return ''; },
    getAttachedShaders(value) { assert.equal(this, gl); assert.equal(value, program); return [vertex, fragment]; },
    getShaderParameter(shader, parameter) { assert.equal(this, gl); return parameter === 2 ? true : shader === vertex ? 35633 : 35632; },
    getShaderInfoLog() { assert.equal(this, gl); return ''; },
    getShaderSource(shader) { assert.equal(this, gl); return sources[shader === vertex ? 0 : 1]; },
    getParameter(value) { assert.equal(this, gl); assert.equal(value, 4); return 16; },
    isContextLost() { assert.equal(this, gl); return false; },
  };
  const canvas = { getContext(...args) {
    calls.push(['context', this, args]); if (fail === 'context') throw originalError; return gl;
  } };
  const wx = { createCanvas(...args) {
    calls.push(['canvas', this, args]); if (fail === 'canvas') throw originalError; return canvas;
  } };
  const target = frozen === 'wx' ? wx : frozen === 'canvas' ? canvas : gl;
  const method = frozen === 'wx' ? 'createCanvas' : frozen === 'canvas' ? 'getContext'
    : frozen === 'query' ? 'getProgramParameter' : 'linkProgram';
  if (frozen) Object.defineProperty(target, method, { writable: false });
  const originals = [wx.createCanvas, canvas.getContext, gl.linkProgram, gl.getProgramParameter];
  const context = { wx, console: { info: (key, json) => logs.push([key, JSON.parse(json)]) },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } };
  runInNewContext(prefix.replace('__FORGEAX_PROBE_OPTIONS__', JSON.stringify({ deadlineMs: 30000,
    source: { manifestSha256: 'manifest', entrySha256: 'entry' },
    ...(options.reportUrl !== undefined ? { reportUrl: options.reportUrl } : {}) })), context);
  return { gl, wx, canvas, logs, calls, timers, originals, originalError, result, program, sources, context,
    linkAndRead() {
      const linked = wx.createCanvas().getContext('webgl2').linkProgram(program);
      gl.getProgramParameter(program, gl.LINK_STATUS);
      return linked;
    },
    reports: phase => logs.map(([, row]) => row).filter(row => row.phase === phase) };
}

test('observes the actual raw status type while preserving all native receivers, arguments and results', () => {
  for (const status of [true, false, 1, 0, null, undefined]) {
    const f = fixture({ status });
    const marker = {};
    assert.equal(f.wx.createCanvas(marker), f.canvas);
    assert.equal(f.canvas.getContext('webgl2', marker), f.gl);
    assert.equal(f.gl.linkProgram(f.program, marker), f.result);
    assert.equal(f.gl.getProgramParameter(f.program, f.gl.LINK_STATUS), status);
    assert.deepEqual(f.calls.slice(0, 3), [
      ['canvas', f.wx, [marker]], ['context', f.canvas, ['webgl2', marker]], ['link', f.gl, [f.program, marker]],
    ]);
    const report = f.reports('link')[0];
    assert.equal(report.linkStatus.type, typeof status);
    assert.equal(report.linkStatus.value, status === undefined ? 'undefined' : status);
    assert.deepEqual(report.shaders.map(shader => shader.compileStatus), [
      { type: 'boolean', value: true }, { type: 'boolean', value: true },
    ]);
    assert.equal(report.caps.MAX_VERTEX_ATTRIBS.value, 16);
    assert.equal(report.contextLost.value, false);
    assert.deepEqual(report.source, { manifestSha256: 'manifest', entrySha256: 'entry' });
    assert.equal(f.reports('hook-installed').length, 4);
    if (status === true) f.timers.get(1)();
    else assert.equal(f.reports('finished')[0].reason, 'link-not-true');
    assert.equal(f.wx.createCanvas, f.originals[0]);
    assert.equal(f.canvas.getContext, f.originals[1]);
    assert.equal(f.gl.linkProgram, f.originals[2]);
    assert.equal(f.gl.getProgramParameter, f.originals[3]);
    assert.equal(f.timers.size, 0);
  }
});

test('binds both actual GLSL bodies to SHA-256 and retains complete failure evidence', () => {
  const f = fixture({ status: false });
  f.gl.getShaderInfoLog = () => 'driver detail '.repeat(300);
  f.linkAndRead();
  const row = f.reports('link')[0];
  for (const [index, shader] of row.shaders.entries()) {
    assert.equal(shader.source.sha256, createHash('sha256').update(f.sources[index]).digest('hex'));
    assert.equal(shader.source.bytes, Buffer.byteLength(f.sources[index]));
  }
  const retained = f.context.__forgeaxPhoneGlLinkReport;
  assert.equal(retained.reason, 'link-not-true');
  assert.equal(retained.records.find(row => row.phase === 'link').shaders[0].infoLog.value, 'driver detail '.repeat(300));
  assert.deepEqual(Array.from(retained.sources, row => row.text), f.sources);
  assert.equal(retained.artifact.status, 'unavailable');
});

test('preserves exact original exceptions without replacing them with diagnostic failures', () => {
  for (const fail of ['canvas', 'context', 'link']) {
    const f = fixture({ fail });
    assert.throws(() => f.linkAndRead(),
      error => error === f.originalError);
    assert.equal(f.reports('link').length, fail === 'link' ? 1 : 0);
    assert.equal(f.calls.some(([name]) => name === 'program'), fail === 'link');
    if (fail === 'link') {
      assert.equal(f.reports('link-threw')[0].error, 'original native exception');
      assert.equal(f.context.__forgeaxPhoneGlLinkReport.reason, 'link-threw');
      assert.equal(f.gl.linkProgram, f.originals[2]);
    }
  }
});

test('reports non-writable hooks explicitly and leaves the original method intact', () => {
  for (const frozen of ['wx', 'canvas', 'context', 'query']) {
    const f = fixture({ frozen });
    f.linkAndRead();
    assert.equal(f.reports('link').length, 0);
    assert.equal(f.reports('hook-failed').length, 1);
    assert.match(f.reports('hook-failed')[0].error, /not a writable data property/);
    if (frozen === 'wx') assert.equal(f.wx.createCanvas, f.originals[0]);
    if (frozen === 'canvas') assert.equal(f.canvas.getContext, f.originals[1]);
    if (frozen === 'context') assert.equal(f.gl.linkProgram, f.originals[2]);
  }
});

test('failed observation queries do not alter successful link calls', () => {
  const f = fixture();
  f.gl.getProgramInfoLog = () => { throw new Error('log unavailable'); };
  f.wx.createCanvas().getContext('webgl2');
  assert.equal(f.gl.linkProgram(f.program), f.result);
  assert.deepEqual(f.reports('link')[0].infoLog, { error: 'log unavailable' });
  assert.equal(f.reports('link')[0].linkStatus.value, true);
});

test('saves one complete private artifact with verifiable bytes and no native handles', () => {
  const f = fixture({ status: false });
  let directory, file;
  f.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  f.wx.getFileSystemManager = () => ({
    mkdirSync(path) { directory = path; },
    writeFileSync(path, body, encoding) { file = { path, body, encoding }; },
  });
  f.linkAndRead();
  const report = f.context.__forgeaxPhoneGlLinkReport;
  assert.equal(file.path, `${directory}/report.json`);
  assert.equal(file.encoding, 'utf8');
  assert.equal(report.artifact.status, 'saved');
  assert.equal(report.artifact.bytes, Buffer.byteLength(file.body));
  assert.equal(report.artifact.sha256, createHash('sha256').update(file.body).digest('hex'));
  const saved = JSON.parse(file.body);
  assert.equal(saved.reason, 'link-not-true');
  assert.equal(saved.records.find(row => row.phase === 'link').linkStatus.value, false);
  assert.deepEqual(saved.sources.map(row => row.text), f.sources);
  assert.equal(f.context.TextEncoder, undefined);
});

test('reports source, log and persistence limits explicitly while preserving link status', () => {
  const f = fixture({ status: false });
  f.gl.getShaderSource = () => 'x'.repeat(2 * 1024 * 1024 + 1);
  f.gl.getShaderInfoLog = () => 'x'.repeat(65537);
  f.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  f.wx.getFileSystemManager = () => ({ mkdirSync() { throw Error('quota full'); } });
  assert.equal(f.linkAndRead(), f.result);
  const report = f.context.__forgeaxPhoneGlLinkReport;
  assert.equal(report.artifact.status, 'failed');
  assert.equal(report.artifact.error, 'quota full');
  assert.equal(report.sources.length, 0);
  const row = f.reports('link')[0];
  assert.equal(row.linkStatus.value, false);
  assert.equal(row.shaders[0].source.availability, 'over-limit');
  assert.equal(row.shaders[0].infoLog.truncated, true);
  assert.equal(row.shaders[0].infoLog.length, 65537);
});

test('records raw shader query results, rejects missing source and restores only owned hooks', () => {
  const f = fixture();
  f.gl.getShaderParameter = (shader, parameter) => parameter === f.gl.COMPILE_STATUS ? 1 : 35633;
  f.gl.getShaderSource = () => null;
  f.linkAndRead();
  const row = f.reports('link')[0];
  assert.deepEqual(row.shaders[0].compileStatus, { type: 'number', value: 1 });
  assert.deepEqual(row.shaders[0].source, { availability: 'unavailable', result: { type: 'object', value: null } });
  const nextOwner = () => {};
  f.gl.linkProgram = nextOwner;
  f.gl.getProgramParameter = nextOwner;
  f.timers.get(1)();
  assert.equal(f.gl.linkProgram, nextOwner);
  assert.equal(f.gl.getProgramParameter, nextOwner);
  assert.equal(f.reports('restore-skipped').length, 2);
});

test('does not send without opt-in and sends the exact saved report once after hook cleanup', () => {
  const disabled = fixture({ status: false });
  disabled.wx.request = () => assert.fail('default observer must not send');
  disabled.linkAndRead();
  assert.equal(disabled.context.__forgeaxPhoneGlLinkReport.transfer, undefined);

  const f = fixture({ status: false, reportUrl: 'http://127.0.0.1:9143/private/report' });
  let saved, requests = 0, callbacks;
  f.wx.env = { USER_DATA_PATH: 'wxfile://usr' };
  f.wx.getFileSystemManager = () => ({ mkdirSync() {}, writeFileSync(path, body) { saved = body; } });
  f.wx.request = function (request) {
    requests++;
    assert.equal(this, f.wx);
    assert.equal(f.wx.createCanvas, f.originals[0]);
    assert.equal(f.canvas.getContext, f.originals[1]);
    assert.equal(f.gl.linkProgram, f.originals[2]);
    assert.equal(request.data, saved);
    assert.equal(request.url, 'http://127.0.0.1:9143/private/report');
    assert.equal(request.method, 'POST');
    assert.equal(request.timeout, 10000);
    assert.equal(request.header['X-Forgeax-Report-Bytes'], String(Buffer.byteLength(saved)));
    assert.equal(request.header['X-Forgeax-Report-Sha256'], createHash('sha256').update(saved).digest('hex'));
    callbacks = request;
    request.success({ statusCode: 200, data: { status: 'saved', bytes: Buffer.byteLength(saved),
      sha256: request.header['X-Forgeax-Report-Sha256'] } });
    return { abort() { assert.fail('completed request must not abort'); } };
  };
  assert.equal(f.linkAndRead(), f.result);
  const report = f.context.__forgeaxPhoneGlLinkReport;
  assert.equal(report.transfer.status, 'sent');
  assert.equal(report.artifact.sha256, report.transfer.sha256);
  const received = JSON.parse(saved);
  assert.deepEqual(received.source, { manifestSha256: 'manifest', entrySha256: 'entry' });
  assert.deepEqual(received.sources.map(row => row.text), f.sources);
  assert.equal(received.records.find(row => row.phase === 'link').linkStatus.value, false);
  callbacks.fail({ errMsg: 'late error' });
  f.gl.linkProgram(f.program);
  assert.equal(report.transfer.status, 'sent');
  assert.equal(requests, 1);
  assert.equal(f.timers.size, 0);
});

test('request failures, HTTP failures and timeouts cannot replace the original GL exception or retry', () => {
  for (const mode of ['throw', 'fail', 'native-timeout', 'watchdog', 'http', 'receipt']) {
    const f = fixture({ fail: 'link', reportUrl: 'http://127.0.0.1:9143/report' });
    let calls = 0, aborts = 0, callbacks;
    f.wx.request = request => {
      calls++;
      callbacks = request;
      if (mode === 'throw') throw new Error('transport unavailable');
      if (mode === 'fail') request.fail({ errMsg: 'request:fail connection refused' });
      if (mode === 'native-timeout') request.fail({ errMsg: 'request:fail timeout' });
      if (mode === 'http') request.success({ statusCode: 413, data: {} });
      if (mode === 'receipt') request.success({ statusCode: 200, data: { status: 'saved' } });
      return { abort() { aborts++; request.fail({ errMsg: 'request:fail abort' }); } };
    };
    assert.throws(() => f.linkAndRead(), error => error === f.originalError);
    const report = f.context.__forgeaxPhoneGlLinkReport;
    assert.equal(report.reason, 'link-threw');
    assert.equal(report.artifact.status, 'unavailable');
    if (mode === 'watchdog') {
      assert.equal(report.transfer.status, 'pending');
      assert.equal(f.timers.size, 1);
      [...f.timers.values()][0]();
      assert.equal(aborts, 1);
    }
    assert.equal(report.transfer.status, mode.includes('timeout') || mode === 'watchdog' ? 'timeout' : 'failed');
    const terminal = report.transfer;
    callbacks.fail({ errMsg: 'late result' });
    assert.equal(report.transfer, terminal);
    assert.equal(f.gl.linkProgram, f.originals[2]);
    assert.equal(calls, 1);
    assert.equal(f.timers.size, 0);
  }
});

test('refuses external or malformed report URLs and reports missing native request explicitly', () => {
  for (const reportUrl of ['https://127.0.0.1:9143/report', 'http://localhost:9143/report',
    'http://127.0.0.1:9143/', 'http://127.0.0.1:9143/report\n', 'http://127.0.0.1:0/report']) {
    const f = fixture({ status: false, reportUrl });
    f.wx.request = () => assert.fail('invalid URL must not send');
    assert.equal(f.linkAndRead(), f.result);
    assert.equal(f.context.__forgeaxPhoneGlLinkReport.transfer.reason, 'invalid-loopback-url');
  }
  const missing = fixture({ status: false, reportUrl: 'http://127.0.0.1:9143/report' });
  missing.linkAndRead();
  assert.equal(missing.context.__forgeaxPhoneGlLinkReport.transfer.status, 'unavailable');
});

test('bounds the full UTF-8 JSON request without truncating retained sources or changing link failure', () => {
  const f = fixture({ status: false, reportUrl: 'http://127.0.0.1:9143/report' });
  let shader = 0;
  f.gl.getShaderSource = () => '\0'.repeat(2 * 1024 * 1024 - 1) + String(++shader);
  f.wx.request = () => assert.fail('oversized JSON must not send');
  assert.equal(f.linkAndRead(), f.result);
  const report = f.context.__forgeaxPhoneGlLinkReport;
  assert.equal(report.transfer.reason, 'report-over-limit');
  assert.ok(report.transfer.bytes > 24 * 1024 * 1024);
  assert.equal(report.sources.length, 2);
  assert.equal(report.records.find(row => row.phase === 'link').linkStatus.value, false);
});

test('distinguishes a proactive native status query from the later actual consumer result', () => {
  const f = fixture({ queryResults: [1, true] });
  f.wx.createCanvas().getContext('webgl2').linkProgram(f.program);
  assert.deepEqual(f.reports('link')[0].linkStatus, { type: 'number', value: 1 });
  assert.equal(f.reports('consumer-link-status').length, 0);
  assert.equal(f.context.__forgeaxPhoneGlLinkReport.reason, undefined);
  assert.equal(f.gl.getProgramParameter(f.program, f.gl.LINK_STATUS), true);
  const consumed = f.reports('consumer-link-status');
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].context, 1);
  assert.equal(consumed[0].link, f.reports('link')[0].link);
  assert.deepEqual(consumed[0].linkStatus, { type: 'boolean', value: true });
  assert.equal(f.context.__forgeaxPhoneGlLinkReport.reason, 'link-not-true');
});

test('captures a non-boolean actual consumer result even after a successful proactive query', () => {
  const f = fixture({ queryResults: [true, 1] });
  const marker = {};
  f.wx.createCanvas().getContext('webgl2').linkProgram(f.program);
  assert.equal(f.gl.getProgramParameter(f.program, f.gl.LINK_STATUS, marker), 1);
  assert.deepEqual(f.calls.at(-1), ['program', f.gl, [f.program, f.gl.LINK_STATUS, marker]]);
  assert.deepEqual(f.reports('consumer-link-status')[0].linkStatus, { type: 'number', value: 1 });
  assert.equal(f.context.__forgeaxPhoneGlLinkReport.reason, 'consumer-link-not-true');
  assert.equal(f.gl.getProgramParameter, f.originals[3]);
});

test('preserves an actual consumer query exception and finishes with its original evidence', () => {
  const f = fixture({ fail: 'query' });
  f.wx.createCanvas().getContext('webgl2').linkProgram(f.program);
  assert.throws(() => f.gl.getProgramParameter(f.program, f.gl.LINK_STATUS), error => error === f.originalError);
  assert.deepEqual(f.reports('consumer-link-status')[0].linkStatus, { error: 'original native exception' });
  assert.equal(f.context.__forgeaxPhoneGlLinkReport.reason, 'consumer-query-threw');
  assert.equal(f.gl.getProgramParameter, f.originals[3]);
});

test('does not treat unrelated native queries or an unconsumed link as consumer evidence', () => {
  const f = fixture({ status: 1 });
  f.wx.createCanvas().getContext('webgl2').linkProgram(f.program);
  assert.equal(f.gl.getProgramParameter(f.program, 999), 1);
  assert.equal(f.gl.getProgramParameter({}, f.gl.LINK_STATUS), 1);
  assert.equal(f.reports('consumer-link-status').length, 0);
  f.timers.get(1)();
  assert.equal(f.context.__forgeaxPhoneGlLinkReport.reason, 'deadline');
  assert.equal(f.reports('consumer-link-status').length, 0);
  const missing = f.reports('consumer-link-status-unavailable');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].link, 1);
  assert.equal(missing[0].reason, 'no-subsequent-query');
  assert.equal(f.gl.getProgramParameter, f.originals[3]);
});
