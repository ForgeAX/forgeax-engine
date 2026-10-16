import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

// Usage: node SCRIPT ENGINE_ROOT [PRIVATE_RESULT_JSON] [VERIFIED_NATIVE_BINDING_DIR].
// Reuses native JS/WASM when supplied; otherwise derives JS from canonical pkg
// using the existing owner. Never rebuilds WASM or the product publication.
const engine = resolve(process.argv[2] || process.cwd());
const require = createRequire(resolve(engine, 'package.json'));
const { chromium } = require('playwright');
const { bundlePhoneDiagnostic } = await import(pathToFileURL(resolve(engine, 'skills/forgeax-engine-wechat/scripts/bundle_phone_gl_link.mjs')));
const collector = (await bundlePhoneDiagnostic('startup')).replace('__FORGEAX_PROBE_OPTIONS__', JSON.stringify({
  source: { manifestSha256: 'a'.repeat(64), entrySha256: 'b'.repeat(64) }, deadlineMs: 20000, minimumSceneFrames: 60, pollMs: 250,
}));
const temporary = process.argv[4] ? undefined : await mkdtemp(resolve(tmpdir(), 'forgeax-wasm-collector-'));
const nativeDirectory = resolve(process.argv[4] || temporary);
if (temporary) {
  const { buildNativeWgpu } = await import(pathToFileURL(resolve(engine, 'packages/wgpu-wasm/scripts/native-build.mjs')));
  await buildNativeWgpu({ out: nativeDirectory });
}
const nativeGlue = await readFile(resolve(nativeDirectory, 'wgpu-native.mjs'), 'utf8');
const wasm = await readFile(resolve(nativeDirectory, 'wgpu.wasm'));
const { build } = createRequire(await realpath(resolve(engine, 'node_modules/tsup/dist/index.js')))('esbuild');
const hostRequire = createRequire(resolve(engine, 'packages/platform-wechat/package.json'));
const bundled = await build({ stdin: { contents: nativeGlue, resolveDir: nativeDirectory, sourcefile: 'wgpu-native.mjs' },
  alias: { '@forgeax/engine/wgpu-wasm/native-host': hostRequire.resolve('@noble/hashes/sha2.js') },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'chrome70' });
const glue = bundled.outputFiles[0].text;
const server = createServer((request, response) => {
  if (request.url === '/wgpu_wasm.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(glue); }
  else if (request.url === '/wgpu_wasm_bg.wasm') { response.setHeader('Content-Type', 'application/wasm'); response.end(wasm); }
  else if (request.url === '/observer.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(collector); }
  else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><canvas width="4" height="4"></canvas>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: process.env.FORGEAX_CHROME_CHANNEL || 'chrome-beta', headless: true,
  args: ['--use-angle=swiftshader', '--ignore-gpu-blocklist'], chromiumSandbox: true });
const output = { kind: 'native-gl-first-exception-collector-verification',
  wasmSha256: createHash('sha256').update(wasm).digest('hex'),
  nativeGlueSha256: createHash('sha256').update(nativeGlue).digest('hex'),
  collectorSha256: createHash('sha256').update(collector).digest('hex'), scenarios: [],
  limitation: 'Injected exception checks lock recovery only; it does not prove a phone exception occurred.' };
try {
  for (const inject of [false, true]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(async () => {
      globalThis.__savedPhoneReports = [];
      globalThis.__injectedCalls = 0;
      globalThis.__sentinel = new Error('deliberate-native-bufferSubData-failure');
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2');
      const original = gl.bufferSubData;
      gl.bufferSubData = function () {
        if (globalThis.__armFault) { globalThis.__injectedCalls++; throw globalThis.__sentinel; }
        return original.apply(this, arguments);
      };
      globalThis.wx = { createCanvas: () => canvas, env: { USER_DATA_PATH: '/private' },
        getFileSystemManager: () => ({ mkdirSync() {}, writeFileSync(path, body) { globalThis.__savedPhoneReports.push(JSON.parse(body)); } }),
        onError(callback) { globalThis.__nativeError = callback; }, offError() {},
      };
      globalThis.WXWebAssembly = { instantiate: async (path, imports) =>
        WebAssembly.instantiate(await (await fetch('/' + path)).arrayBuffer(), imports) };
      globalThis.__forgeaxGameInspection = { renderer: () => ({ phase: 'scene' }) };
      await import('/observer.js');
    });
    const result = await page.evaluate(async inject => {
      const binding = await import('/wgpu_wasm.js');
      const canvas = wx.createCanvas();
      await binding.initializeNativeWgpu({ surfaces: [canvas],
        readWasm: async () => new Uint8Array(await (await fetch('/wgpu_wasm_bg.wasm')).arrayBuffer()),
        instantiate: imports => WXWebAssembly.instantiate('wgpu_wasm_bg.wasm', imports) });
      const instance = await binding.RhiWgpuInstance.create();
      const adapter = await instance.requestAdapterWithCanvas(canvas);
      const device = await adapter.requestDevice({});
      const queue = device.queue;
      const buffer = device.createBuffer({size: 16, usage: 0x08 | 0x40});
      const gl = canvas.getContext('webgl2');
      const sentinel = globalThis.__sentinel;
      const result = { inject, operations: [] };
      const operation = (name, call) => {
        try { call(); result.operations.push({name, status:'returned'}); }
        catch (error) { result.operations.push({name, status:'threw', message: String(error.message || error), stack: error.stack, sameSentinel:error === sentinel}); }
      };
      operation('write-before-submit', () => queue.writeBuffer(buffer, 0n, new Uint8Array([1,2,3,4])));
      globalThis.__armFault = inject;
      operation('submit', () => queue.submit([]));
      globalThis.__armFault = false;
      operation('write-after-submit', () => queue.writeBuffer(buffer, 0n, new Uint8Array([5,6,7,8])));
      result.injectedCalls = globalThis.__injectedCalls;
      globalThis.__nativeError('test-terminal');
      result.report = globalThis.__savedPhoneReports[0];
      return result;
    }, inject);
    if (inject) {
      assert.equal(result.report.nativeGlErrors.first.method, 'bufferSubData');
      assert.equal(result.report.nativeGlErrors.first.message, 'deliberate-native-bufferSubData-failure');
      assert.ok(result.report.nativeGlErrors.first.callerWasmStack.includes('wgpu_hal'));
      assert.ok(result.report.nativeGlErrors.first.at <= result.report.rustPanics.records[0].at);
      assert.ok(result.operations[1].sameSentinel);
      assert.equal(result.operations[2].message, 'unreachable');
      assert.equal(result.report.nativeWasmErrors.first.operation, 'rhiwgpuqueue_submit');
      assert.equal(result.report.nativeWasmErrors.first.message, 'deliberate-native-bufferSubData-failure');
      assert.ok(result.report.nativeWasmErrors.first.stack.includes('deliberate-native-bufferSubData-failure'));
      assert.ok(result.report.nativeWasmErrors.first.at <= result.report.rustPanics.records[0].at);
      assert.ok(result.report.nativeWasmErrors.laterThrows > 0);
    } else {
      assert.equal(result.report.nativeGlErrors.first, undefined);
      assert.equal(result.report.nativeWasmErrors.first, undefined);
    }
    assert.equal(result.report.nativeGlErrors.contexts.length, 1);
    assert.equal(result.report.nativeGlErrors.contexts[0].discovery, 'complete');
    assert.equal(result.report.nativeGlErrors.contexts[0].restored, result.report.nativeGlErrors.contexts[0].installed);
    assert.equal(result.report.nativeGlErrors.factory.status, 'restored');
    assert.equal(result.report.nativeWasmErrors.factory.status, 'restored');
    assert.equal(result.report.nativeWasmErrors.instances.length, 1);
    assert.equal(result.report.nativeWasmErrors.instances[0].status, 'projected', JSON.stringify(result.report.nativeWasmErrors));
    assert.equal(result.report.nativeWasmErrors.instances[0].restored, result.report.nativeWasmErrors.instances[0].installed);
    output.scenarios.push({ ...result, consoleErrors: errors });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
if (process.argv[3]) await writeFile(resolve(process.argv[3]), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ kind: output.kind, wasmSha256: output.wasmSha256,
  scenarios: output.scenarios.map(({ inject, injectedCalls, report }) => ({ inject, injectedCalls,
    nativeGlErrors: report.nativeGlErrors, nativeWasmErrors: report.nativeWasmErrors })) }, null, 2));
