#!/usr/bin/env node
// The same authored foliage scene exercises one and four point lights on both browser backends.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const appDir = resolve(import.meta.dirname, '..');
const root = resolve(appDir, '../../..');
const output = resolve(process.env.FORGEAX_FOLIAGE_PARITY_DIR ?? resolve(root, '.forgeax-debug/foliage-point-matrix'));
mkdirSync(output, { recursive: true });

const freePort = async () => {
  const socket = createServer();
  await new Promise((ready) => socket.listen(0, '127.0.0.1', ready));
  const address = socket.address();
  await new Promise((ready) => socket.close(ready));
  if (address === null || typeof address === 'string') throw new Error('port unavailable');
  return address.port;
};

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [resolve(appDir, 'node_modules/vite/bin/vite.js'),
  '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: appDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += String(chunk); });
server.stderr.on('data', (chunk) => { serverOutput += String(chunk); });
const reports = [];
let browser;
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
    for (const pointCount of [1, 4]) {
      const page = await browser.newPage({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
      if (backend === 'webgl2') await page.addInitScript(() => { delete Navigator.prototype.gpu; });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      try {
        await page.goto(`${origin}/?points=${pointCount}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.waitForFunction(() => typeof window.__captureFoliage === 'function', null, { timeout: 120_000 });
        let pixels;
        for (let frame = 0; frame < 60; frame++) {
          if (errors.length) throw new Error(`browser errors: ${JSON.stringify(errors)}`);
          const observed = await page.evaluate(async (last) => {
            const image = await window.__captureFoliage();
            return last ? Array.from(image) : image.byteLength;
          }, frame === 59);
          if (frame === 59) pixels = observed;
          else if (observed !== 320 * 180 * 4) throw new Error(`invalid frame ${frame} length ${observed}`);
        }
        if (pixels?.length !== 320 * 180 * 4) throw new Error(`invalid raw image length ${pixels?.length}`);
        const observedBackend = await page.evaluate(() => window.__foliageInspection?.());
        const expectedBackend = backend === 'webgl2' ? 'wgpu-webgl2' : 'webgpu';
        if (observedBackend !== expectedBackend) {
          throw new Error(`backend mismatch: ${JSON.stringify(observedBackend)}`);
        }
        const png = new PNG({ width: 320, height: 180 });
        png.data.set(pixels);
        const image = resolve(output, `foliage-${pointCount}-points-${backend}.png`);
        writeFileSync(image, PNG.sync.write(png));
        const pixelSignal = pixels.filter((value, index) => index % 4 !== 3 && value > 8).length;
        const report = { backend, pointCount, frames: 60, observedBackend, errors, pixelSignal, image, pixels };
        reports.push(report);
        if (pixelSignal < 1000 || errors.length) throw new Error(`invalid foliage frame: ${JSON.stringify({ backend, pointCount, errors, pixelSignal })}`);
        console.log(`[foliage-parity] PASS ${backend} ${pointCount} point(s), 60 observed frames, signal=${pixelSignal}`);
      } finally {
        await page.close();
      }
    }
    await browser.close();
    browser = undefined;
  }
  const comparisons = [];
  for (const pointCount of [1, 4]) {
    const a = reports.find((report) => report.backend === 'webgl2' && report.pointCount === pointCount);
    const b = reports.find((report) => report.backend === 'webgpu' && report.pointCount === pointCount);
    if (!a || !b) throw new Error(`missing backend pair for ${pointCount} point(s)`);
    let sum = 0;
    let above = 0;
    for (let pixel = 0; pixel < 320 * 180; pixel++) {
      let max = 0;
      for (let channel = 0; channel < 3; channel++) {
        const delta = Math.abs(a.pixels[pixel * 4 + channel] - b.pixels[pixel * 4 + channel]) / 255;
        sum += delta;
        max = Math.max(max, delta);
      }
      if (max > 0.05) above++;
    }
    const comparison = { pointCount, meanChannelDelta: sum / (320 * 180 * 3), pixelsAboveEpsilon: above, pixelCount: 320 * 180 };
    comparisons.push(comparison);
    if (comparison.meanChannelDelta > 0.05 || above > 320 * 180 * 0.05) throw new Error(`backend mismatch: ${JSON.stringify(comparison)}`);
    console.log(`[foliage-parity] PASS ${pointCount} point(s) mean=${comparison.meanChannelDelta.toFixed(6)} pixels>0.05=${above}`);
  }
  const single = reports.find((report) => report.backend === 'webgl2' && report.pointCount === 1);
  const four = reports.find((report) => report.backend === 'webgl2' && report.pointCount === 4);
  if (!single || !four) throw new Error('missing WebGL2 point-light response pair');
  let changedPixels = 0;
  for (let pixel = 0; pixel < 320 * 180; pixel++) {
    const base = pixel * 4;
    if ([0, 1, 2].some((channel) => single.pixels[base + channel] !== four.pixels[base + channel])) changedPixels++;
  }
  if (changedPixels < 100) throw new Error(`four point lights did not change the image: ${changedPixels} pixels`);
  console.log(`[foliage-parity] PASS four-point response changed=${changedPixels} pixels`);
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({
    cases: reports.map(({ pixels: _pixels, ...report }) => report), comparisons, changedPixels,
  }, null, 2) + '\n');
} catch (error) {
  writeFileSync(resolve(output, 'failure.json'), JSON.stringify({
    error: String(error), cases: reports.map(({ pixels: _pixels, ...report }) => report),
    serverOutput: serverOutput.slice(-4000),
  }, null, 2) + '\n');
  throw error;
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
