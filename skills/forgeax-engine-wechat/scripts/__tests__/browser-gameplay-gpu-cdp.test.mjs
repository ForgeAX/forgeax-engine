import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNativeWgpu } from '../../../../packages/wgpu-wasm/scripts/native-build.mjs';

const modulePath = process.env.FORGEAX_PLAYWRIGHT_MODULE;
const packagePath = process.env.FORGEAX_GPU_WASM_PKG;
const require = createRequire(import.meta.url);

test('real published wgpu WASM uses the opt-in Browser Host projection and preserves pixels', {
  skip: !modulePath || !packagePath,
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'forgeax-gpu-diagnostic-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { directory, receipt } = await buildNativeWgpu({
    out: join(temporary, 'native'),
    pkgDirectory: packagePath,
  });
  const { build } = createRequire(require.resolve('tsup'))('esbuild');
  const noble = require.resolve('@noble/hashes/sha2.js', {
    paths: [join(dirname(require.resolve('playwright/package.json')), '../../../node_modules')],
  });
  const native = await build({
    entryPoints: [join(directory, 'wgpu-native.mjs')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    alias: { '@forgeax/engine/wgpu-wasm/native-host': noble },
  });
  const host = await build({
    entryPoints: [
      fileURLToPath(new URL('../fixtures/gameplay-benchmark/browser-host.ts', import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    plugins: [
      {
        name: 'unused-host-services',
        setup(b) {
          b.onResolve({ filter: /^#host-/ }, ({ path }) => ({ path, namespace: 'unused' }));
          b.onLoad({ filter: /.*/, namespace: 'unused' }, () => ({
            contents:
              'export function createWebAudioBackend(){};export function attachBrowserInputBackend(){};export function createBrowserPlatform(){};',
            loader: 'js',
          }));
        },
      },
    ],
  });
  const wasm = await readFile(join(directory, 'wgpu.wasm'));
  const server = createServer((request, response) => {
    const files = {
      '/native.mjs': ['text/javascript', native.outputFiles[0].text],
      '/host.mjs': ['text/javascript', host.outputFiles[0].text],
      '/payload/wgpu.wasm': ['application/wasm', wasm],
      '/': ['text/html', '<canvas width="8" height="8"></canvas>'],
    };
    const item = files[request.url];
    response.writeHead(item ? 200 : 404, { 'Content-Type': item?.[0] ?? 'text/plain' });
    response.end(item?.[1] ?? 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { chromium } = await import(pathToFileURL(modulePath).href);
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.FORGEAX_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.FORGEAX_CHROMIUM_EXECUTABLE }
      : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    chromiumSandbox: true,
  });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evidence = {
    kind: 'real-wgpu-wasm-software-webgl2-contract',
    browser: browser.version(),
    canonical: receipt.canonical,
  };
  async function prepare(content) {
    const page = await browser.newPage();
    if (content) await page.addInitScript({ content });
    await page.goto(origin);
    await page.evaluate(async () => {
      const native = await import('/native.mjs');
      const { createBrowserWgpuHost } = await import('/host.mjs');
      const canvas = document.querySelector('canvas');
      await native.initializeNativeWgpu(createBrowserWgpuHost('payload/wgpu.wasm.br', [canvas]));
      const instance = await native.RhiWgpuInstance.create();
      const adapter = await instance.requestAdapterWithCanvas(canvas);
      const device = await adapter.requestDevice({});
      const surface = instance.createSurface(canvas);
      surface.configure({
        device,
        format: 'rgba8unorm',
        usage: 0x10,
        width: 8,
        height: 8,
        presentMode: 'fifo',
        alphaMode: 'opaque',
      });
      const queue = device.queue,
        gl = canvas.getContext('webgl2');
      globalThis.__gpuFixture = { native, instance, adapter, device, surface, queue, gl };
      globalThis.__draw = () => {
        const acquired = surface.getCurrentTexture(),
          texture = acquired.getTexture();
        const view = device.createTextureView(texture, {}),
          encoder = device.createCommandEncoder({ label: 'diagnostic-regression-frame' });
        const pass = encoder.beginRenderPass({
          label: 'diagnostic-regression-clear',
          colorAttachments: [
            { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 1, b: 0, a: 1 } },
          ],
        });
        pass.end();
        pass.free();
        queue.submit([encoder.finish()]);
        encoder.free();
        acquired.present();
        view.free();
        texture.free();
        acquired.free();
      };
      globalThis.__pixels = () => {
        const pixels = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return [...pixels];
      };
    });
    return page;
  }
  const baseline = await prepare();
  evidence.baseline = await baseline.evaluate(() => {
    __draw();
    return __pixels();
  });
  assert.deepEqual(evidence.baseline, [0, 255, 0, 255]);
  await baseline.close();
  const sentinel = await prepare(
    'globalThis.__projectCalls=0;globalThis.__forgeaxGameplayGpu={project(native,surfaces){__projectCalls++;if(surfaces.length!==1)throw Error("surface");return native;}};',
  );
  const projected = await sentinel.evaluate(() => {
    __draw();
    return { calls: __projectCalls, pixels: __pixels() };
  });
  await sentinel.close();
  assert.equal(
    projected.calls,
    1,
    'Browser Host must pass the actual instantiated WASM through the opt-in seam',
  );
  assert.deepEqual(projected.pixels, evidence.baseline);

  const { browserGameplayGpuSource } = await import('../browser_gameplay_gpu.mjs');
  const page = await prepare(browserGameplayGpuSource({ capacity: 8 }));
  evidence.measured = await page.evaluate(async () => {
    const probe = __forgeaxGameplayGpu,
      gl = __gpuFixture.gl;
    const forbidden = { flush: 0, finish: 0, getError: 0, getQueryParameter: 0 };
    const originals = {};
    for (const name of Object.keys(forbidden)) {
      originals[name] = gl[name];
      gl[name] = function (...args) {
        forbidden[name]++;
        return Reflect.apply(originals[name], this, args);
      };
    }
    const start = probe.start();
    __draw();
    __draw();
    const stopped = probe.stop(),
      callsInWindow = { ...forbidden };
    const pixels = __pixels();
    // Ordinary later native submissions publish prior query ends. The diagnostic adds no flush.
    __draw();
    const collected = await probe.collect({ timeoutMs: 3000, pollIntervalMs: 16 });
    const disposed = probe.dispose();
    __draw();
    return {
      start,
      stopped,
      callsInWindow,
      collected,
      disposed,
      pixels,
      afterDisposePixels: __pixels(),
      glError: originals.getError.call(gl),
    };
  });
  assert.deepEqual(evidence.measured.pixels, evidence.baseline);
  assert.deepEqual(evidence.measured.afterDisposePixels, evidence.baseline);
  assert.equal(evidence.measured.glError, 0);
  assert.equal(
    evidence.measured.callsInWindow.flush,
    4,
    'Only native submit and present-transition flushes',
  );
  assert.equal(evidence.measured.callsInWindow.finish, 0);
  assert.equal(evidence.measured.callsInWindow.getError, 0);
  assert.equal(evidence.measured.callsInWindow.getQueryParameter, 0);
  assert.equal(evidence.measured.collected.samples.length, 4);
  assert.deepEqual(
    evidence.measured.collected.samples.map((row) => row.operation),
    ['submit', 'present', 'submit', 'present'],
  );
  assert.equal(evidence.measured.collected.coverage.overflow, 0);
  assert.equal(evidence.measured.disposed.lifecycle, 'disposed');
  if (evidence.measured.start.capability.status === 'available') {
    assert.ok(evidence.measured.collected.samples.every((row) => row.status === 'available'));
    assert.ok(
      evidence.measured.collected.samples.every(
        (row) => Number.isSafeInteger(row.gpuNanoseconds) && row.gpuNanoseconds > 0,
      ),
    );
  } else {
    assert.ok(evidence.measured.collected.samples.every((row) => row.gpuNanoseconds === null));
  }
  if (process.env.FORGEAX_GAMEPLAY_GPU_EVIDENCE)
    await writeFile(process.env.FORGEAX_GAMEPLAY_GPU_EVIDENCE, JSON.stringify(evidence, null, 2));
});
