#!/usr/bin/env node
import { once } from 'node:events';
// Exercise independent Preview projects on both real browser RHI paths.
import { createServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const root = resolve(import.meta.dirname, '../../..');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
const output = resolve(process.env.FORGEAX_TEMPLATE_MATRIX_DIR ?? resolve(root, '.forgeax-debug/template-backend-matrix'));
const cases = [
  { slug: 'game-capability-lab', game: 'game-default', visible: true },
  { slug: 'game-3d', game: 'game-3d', visible: true },
  { slug: 'brotato-3d', game: 'brotato-3d', visible: true },
  { slug: 'empty', game: 'empty', visible: false },
];
const selected = process.env.FORGEAX_TEMPLATE_MATRIX_CASES?.split(',').filter(Boolean);
const backends = process.env.FORGEAX_TEMPLATE_MATRIX_BACKENDS?.split(',').filter(Boolean) ?? ['webgl2', 'webgpu'];
const gpu = process.env.FORGEAX_TEMPLATE_MATRIX_GPU ?? (process.platform === 'darwin' ? 'metal' : 'swiftshader');
if (gpu !== 'metal' && gpu !== 'swiftshader') throw new Error(`unsupported GPU lane: ${gpu}`);
if (gpu === 'metal' && process.platform !== 'darwin') throw new Error('Metal GPU lane requires macOS');
mkdirSync(output, { recursive: true });

async function freePort() {
  const server = createServer();
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const address = server.address();
  await new Promise((ready) => server.close(ready));
  if (address === null || typeof address === 'string') throw new Error('dynamic port unavailable');
  return address.port;
}

function pixels(path) {
  const png = PNG.sync.read(readFileSync(path));
  let signal = 0;
  let sceneSignal = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    const luma = Math.round((r * 54 + g * 183 + b * 19) / 256);
    if (r + g + b > 24) signal++;
    const pixel = i / 4;
    const x = pixel % png.width;
    const y = Math.floor(pixel / png.width);
    if (x >= png.width / 3 && x < png.width * 2 / 3 &&
        y >= png.height / 6 && y < png.height * 5 / 6 && r + g + b > 24) sceneSignal++;
    min = Math.min(min, luma);
    max = Math.max(max, luma);
  }
  return { width: png.width, height: png.height, signal, sceneSignal, lumaRange: max - min };
}

async function runCase(entry, backend) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [resolve(root, 'apps/preview/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: resolve(root, 'apps/preview'),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORGEAX_TEMPLATE_SMOKE: '1', FORGEAX_TEMPLATE_SMOKE_SLUGS: entry.slug },
  });
  let serverOutput = '';
  server.stdout.on('data', (part) => { serverOutput += part.toString(); });
  server.stderr.on('data', (part) => { serverOutput += part.toString(); });
  let browser;
  let page;
  const pageErrors = [];
  const consoleErrors = [];
  const badResponses = [];
  const report = { case: entry.slug, backend, gpu, status: 'fail', sourceSha, sourceDirty };
  try {
    const until = Date.now() + 180_000;
    let ready = false;
    while (Date.now() < until) {
      if (server.exitCode !== null) break;
      try { ready = (await fetch(origin, { signal: AbortSignal.timeout(2_000) })).ok; } catch {}
      if (ready) break;
      await sleep(250);
    }
    if (!ready) throw new Error(`Vite startup failed: ${serverOutput.slice(-4000)}`);
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: backend === 'webgpu' ? [
        '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
        ...(gpu === 'metal'
          ? []
          : ['--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader', '--use-angle=swiftshader']),
      ] : [
        '--disable-features=WebGPU', '--use-angle=' + gpu, '--ignore-gpu-blocklist',
      ],
      chromiumSandbox: true,
    });
    page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    if (backend === 'webgl2') {
      await page.addInitScript(() => { delete Navigator.prototype.gpu; });
    }
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`${origin}/?game=${entry.game}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const waitFor = async (check, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pageErrors.length || consoleErrors.length || badResponses.length) {
          throw new Error(`${label}: browser errors ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
        }
        if (await page.evaluate(check)) return;
        await sleep(200);
      }
      throw new Error(`${label}: timed out after ${timeoutMs}ms`);
    };
    await waitFor(() =>
      globalThis.__forgeaxPreviewInspection !== undefined ||
      globalThis.__forgeaxRendererCreateFailure !== undefined,
    120_000, 'preview inspection');
    if (await page.evaluate(() => globalThis.__forgeaxRendererCreateFailure !== undefined)) {
      throw new Error('renderer creation failed');
    }
    if (entry.visible) {
      await waitFor(() => {
        const health = globalThis.__forgeaxPreviewInspection?.renderer.health();
        return health !== undefined && (health.reason !== 'alive' || (health.executionFrame?.completed ?? -1) >= 60);
      }, 180_000, '60 completed frames');
    }
    const health = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.renderer.health());
    const navigatorGpu = await page.evaluate(() => 'gpu' in navigator && navigator.gpu != null);
    const image = resolve(output, `${entry.slug}-${backend}.png`);
    await page.locator('#app').screenshot({ path: image, timeout: 30_000 });
    Object.assign(report, {
      health, navigatorGpu, image, pixels: pixels(image), pageErrors, consoleErrors, badResponses,
      serverOutput: serverOutput.slice(-4000),
    });
    if (health?.reason !== 'alive') throw new Error(`renderer unhealthy: ${JSON.stringify(health)}`);
    if (health.backendKind !== (backend === 'webgl2' ? 'wgpu-webgl2' : 'webgpu')) {
      throw new Error(`backend mismatch: ${health.backendKind}`);
    }
    if (backend === 'webgl2' && navigatorGpu) throw new Error('navigator.gpu still available');
    if (entry.visible && report.pixels.signal < 1000) throw new Error(`presented image blank: ${JSON.stringify(report.pixels)}`);
    if (entry.visible && report.pixels.sceneSignal < 10000) throw new Error(`scene region blank: ${JSON.stringify(report.pixels)}`);
    if (pageErrors.length || badResponses.length || consoleErrors.length) {
      throw new Error(`browser errors: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
    }
    report.status = 'pass';
  } catch (error) {
    report.error = String(error);
    report.serverOutput = serverOutput.slice(-4000);
    report.pageErrors = pageErrors;
    report.consoleErrors = consoleErrors;
    report.badResponses = badResponses;
    if (page !== undefined && !page.isClosed()) {
      try {
        report.diagnostic = await page.evaluate(() => ({
          health: globalThis.__forgeaxPreviewInspection?.renderer.health() ?? null,
          bootstrap: globalThis.__forgeaxRendererBootstrap ?? null,
          failure: globalThis.__forgeaxRendererCreateFailure ?? null,
        }));
        await page.locator('#app').screenshot({ path: resolve(output, `${entry.slug}-${backend}-failure.png`), timeout: 5_000 });
      } catch (diagnosticError) {
        report.diagnosticError = String(diagnosticError);
      }
    }
  } finally {
    writeFileSync(resolve(output, `${entry.slug}-${backend}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await browser?.close();
    if (server.pid !== undefined) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
      await sleep(500);
      if (server.exitCode === null && server.signalCode === null) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
      }
    }
    server.stdout.destroy();
    server.stderr.destroy();
  }
  console.log(`[template-backend-matrix] ${report.status.toUpperCase()} ${entry.slug} ${backend} frames=${report.health?.executionFrame?.completed ?? 'none'} pixels=${report.pixels?.signal ?? 'none'} ${report.error ?? ''}`);
  return report;
}

const results = [];
for (const entry of cases) {
  if (selected && !selected.includes(entry.slug)) continue;
  for (const backend of backends) results.push(await runCase(entry, backend));
}
const comparisons = [];
for (const entry of cases) {
  if (!entry.visible) continue;
  const webgl = results.find((result) => result.case === entry.slug && result.backend === 'webgl2');
  const webgpu = results.find((result) => result.case === entry.slug && result.backend === 'webgpu');
  if (webgl?.status !== 'pass' || webgpu?.status !== 'pass') continue;
  const a = PNG.sync.read(readFileSync(webgl.image));
  const b = PNG.sync.read(readFileSync(webgpu.image));
  if (a.width !== b.width || a.height !== b.height) throw new Error(`image size mismatch: ${entry.slug}`);
  let channelDelta = 0;
  let maxChannelDelta = 0;
  let pixelsAboveEpsilon = 0;
  for (let offset = 0; offset < a.data.length; offset += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(a.data[offset + channel] - b.data[offset + channel]) / 255;
      channelDelta += delta;
      pixelDelta = Math.max(pixelDelta, delta);
      maxChannelDelta = Math.max(maxChannelDelta, delta);
    }
    if (pixelDelta > 0.05) pixelsAboveEpsilon++;
  }
  const comparison = {
    case: entry.slug,
    meanChannelDelta: channelDelta / (a.width * a.height * 3),
    maxChannelDelta,
    pixelsAboveEpsilon,
    pixelCount: a.width * a.height,
  };
  comparison.status = comparison.meanChannelDelta <= 0.05 &&
    comparison.pixelsAboveEpsilon / comparison.pixelCount <= 0.05 ? 'pass' : 'fail';
  comparisons.push(comparison);
  console.log(`[template-backend-matrix] ${comparison.status.toUpperCase()} image parity ${entry.slug} mean=${comparison.meanChannelDelta.toFixed(6)} pixels>0.05=${pixelsAboveEpsilon}/${comparison.pixelCount}`);
}
writeFileSync(resolve(output, 'matrix.json'), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(resolve(output, 'comparisons.json'), `${JSON.stringify(comparisons, null, 2)}\n`);
if (results.some((entry) => entry.status !== 'pass') || comparisons.some((comparison) => comparison.status !== 'pass')) process.exitCode = 1;
