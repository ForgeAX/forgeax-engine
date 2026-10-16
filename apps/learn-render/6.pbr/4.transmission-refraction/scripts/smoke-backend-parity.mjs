#!/usr/bin/env node
// Exercise the five positive Standard transmission cases on both browser backends.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const appDir = resolve(import.meta.dirname, '..');
const root = resolve(appDir, '../../../..');
const output = resolve(process.env.FORGEAX_TRANSMISSION_PARITY_DIR ?? resolve(root, '.forgeax-debug/transmission-backend-matrix'));
mkdirSync(output, { recursive: true });
const socket = createServer();
await new Promise((ready) => socket.listen(0, '127.0.0.1', ready));
const address = socket.address();
await new Promise((ready) => socket.close(ready));
if (address === null || typeof address === 'string') throw new Error('port unavailable');
const origin = `http://127.0.0.1:${address.port}`;
const server = spawn(process.execPath, [resolve(appDir, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(address.port), '--strictPort'], {
  cwd: appDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += String(chunk); });
server.stderr.on('data', (chunk) => { serverOutput += String(chunk); });
const reports = [];
let browser;
function signal(pixels) {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 24) count++;
  }
  return count;
}
try {
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) break;
    try { ready = (await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    if (ready) break;
    await sleep(250);
  }
  if (!ready) throw new Error(`Vite unavailable: ${serverOutput.slice(-4000)}`);
  for (const backend of ['webgl2', 'webgpu']) {
    browser = await chromium.launch({
      headless: true,
      ...(backend === 'webgpu' ? { channel: 'chrome' } : {}),
      args: backend === 'webgl2'
        ? ['--disable-features=WebGPU', `--use-angle=${process.platform === 'darwin' ? 'metal' : 'swiftshader'}`, '--ignore-gpu-blocklist']
        : ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
    if (backend === 'webgl2') await page.addInitScript(() => { delete Navigator.prototype.gpu; });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(message.text());
    });
    const report = { backend, status: 'fail', errors };
    try {
      await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForFunction(() => window.__transmissionInspection?.status === 'ready' ||
        (window.__learnRenderErrors?.length ?? 0) > 0, null, { timeout: 120_000 });
      report.inspection = await page.evaluate(() => window.__transmissionInspection);
      report.runtimeErrors = await page.evaluate(() => window.__learnRenderErrors ?? []);
      if (report.inspection?.status !== 'ready') throw new Error(`carrier unavailable: ${JSON.stringify(report.runtimeErrors)}`);
      const expectedBackend = backend === 'webgl2' ? 'wgpu-webgl2' : 'webgpu';
      if (report.inspection.backend !== expectedBackend) throw new Error(`backend mismatch: ${report.inspection.backend}`);
      let pixels;
      for (let frame = 0; frame < 60; frame++) {
        if (errors.length || report.runtimeErrors.length) throw new Error(`runtime errors: ${JSON.stringify({ errors, runtimeErrors: report.runtimeErrors })}`);
        const observed = await page.evaluate(async (last) => {
          const image = await window.__captureTransmission();
          return last ? Array.from(image) : image.byteLength;
        }, frame === 59);
        if (frame === 59) pixels = observed;
        else if (observed !== 512 * 512 * 4) throw new Error(`invalid frame ${frame} length ${observed}`);
      }
      if (pixels?.length !== 512 * 512 * 4) throw new Error(`invalid image length ${pixels?.length}`);
      const png = new PNG({ width: 512, height: 512 });
      png.data.set(pixels);
      report.rawImage = resolve(output, `transmission-${backend}-raw.png`);
      writeFileSync(report.rawImage, PNG.sync.write(png));
      report.screenshot = resolve(output, `transmission-${backend}-display.png`);
      await page.locator('#app').screenshot({ path: report.screenshot });
      const displayPixels = PNG.sync.read(readFileSync(report.screenshot)).data;
      report.rawSignal = signal(pixels);
      report.displaySignal = signal(displayPixels);
      report.evidenceSource = report.rawSignal >= 1000 ? 'raw' : 'display';
      const evidencePixels = report.evidenceSource === 'raw' ? pixels : displayPixels;
      report.signal = signal(evidencePixels);
      report.frames = 60;
      if (report.signal < 1000 || errors.length) throw new Error(`empty or invalid scene: ${JSON.stringify({ signal: report.signal, errors })}`);
      report.status = 'pass';
      report.pixels = evidencePixels;
      console.log(`[transmission-parity] PASS ${backend} frames=60 signal=${report.signal} source=${report.evidenceSource}`);
    } catch (error) {
      report.error = String(error);
      report.inspection ??= await page.evaluate(() => window.__transmissionInspection).catch(() => null);
      report.runtimeErrors = await page.evaluate(() => window.__learnRenderErrors ?? []).catch(() => []);
      console.log(`[transmission-parity] FAIL ${backend} ${report.error}`);
    } finally {
      reports.push(report);
      await page.close();
      await browser.close();
      browser = undefined;
    }
  }
  const [webgl, webgpu] = reports;
  if (webgl?.status === 'pass' && webgpu?.status === 'pass') {
    let sum = 0;
    let above = 0;
    for (let pixel = 0; pixel < 512 * 512; pixel++) {
      let max = 0;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(webgl.pixels[pixel * 4 + channel] - webgpu.pixels[pixel * 4 + channel]) / 255;
        sum += delta;
        max = Math.max(max, delta);
      }
      if (max > 0.05) above++;
    }
    const comparison = { meanChannelDelta: sum / (512 * 512 * 3), pixelsAboveEpsilon: above, pixelCount: 512 * 512 };
    console.log(`[transmission-parity] comparison ${JSON.stringify(comparison)}`);
    writeFileSync(resolve(output, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
    if (comparison.meanChannelDelta > 0.05 || above > 512 * 512 * 0.05) process.exitCode = 1;
  } else process.exitCode = 1;
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({
    cases: reports.map(({ pixels: _pixels, ...report }) => report),
  }, null, 2) + '\n');
} finally {
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
