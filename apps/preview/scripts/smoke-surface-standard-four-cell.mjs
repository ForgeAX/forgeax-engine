#!/usr/bin/env node
import { once } from 'node:events';
// Capture the four imported Standard Surface cells through the real Preview
// Pack/Catalog/cook/loadByGuid and ForgeaX WebGL2 renderer path.
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

async function findAvailablePort() {
  const probe = createNetServer();
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  const address = probe.address();
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  if (address === null || typeof address === 'string') throw new Error('surface-standard: dynamic port unavailable');
  return address.port;
}

export async function runSurfaceStandardSmoke(options = {}) {
  const backend = process.env.FORGEAX_SURFACE_BACKEND ?? 'webgl2';
  const configuredPort = options.port ?? (process.env.FORGEAX_SURFACE_PORT === undefined
    ? undefined
    : Number.parseInt(process.env.FORGEAX_SURFACE_PORT, 10));
  const port = configuredPort === undefined || configuredPort === 0 ? await findAvailablePort() : configuredPort;
  const outputDir = resolve(options.outputDir ?? process.env.FORGEAX_SURFACE_DIR ?? resolve(ROOT, '.forgeax-debug/surface-standard'));
  mkdirSync(outputDir, { recursive: true });
  const sourceSha = options.sourceSha ?? process.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const buildId = options.buildId ?? process.env.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? `preview-surface-${sourceSha.slice(0, 12)}`;
  const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORGEAX_SURFACE_PROBE: process.env.FORGEAX_RHI_PROBE === '1' ? '0' : '1',
      FORGEAX_SURFACE_ONLY: '1',
      VITE_FORGEAX_EVIDENCE_SOURCE_SHA: sourceSha,
      VITE_FORGEAX_EVIDENCE_BUILD_ID: buildId,
    },
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  let browser;
  try {
    // A clean workspace can spend more than 30s in Vite dependency
    // re-optimization before it opens its listener. This is startup allowance
    // only; the four-cell WebGL2 readback and error gates below are unchanged.
    const configuredReadinessMs = Number(process.env.FORGEAX_SURFACE_SERVER_READINESS_TIMEOUT_MS ?? 180_000);
    const readinessTimeoutMs = Number.isFinite(configuredReadinessMs) && configuredReadinessMs > 0
      ? configuredReadinessMs
      : 180_000;
    const deadline = Date.now() + readinessTimeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })).ok) break;
      } catch {}
      await sleep(250);
    }
    if (Date.now() >= deadline) throw new Error(`Preview server did not start: ${serverOutput}`);
    browser = await chromium.launch({
      headless: true,
      args: backend === 'webgpu' ? [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--ignore-gpu-blocklist',
      ] : [
        '--disable-features=WebGPU',
        '--disable-gpu',
        '--disable-gpu-driver-bug-workarounds',
      ],
      chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    const screenshot = resolve(outputDir, `surface-standard-four-cell-${backend}.png`);
    await page.exposeBinding('__forgeaxCapturePixels', async (_, payload) => {
      const raw = Buffer.from(payload.base64, 'base64');
      const png = new PNG({ width: payload.width, height: payload.height });
      for (let y = 0; y < payload.height; y += 1) {
        const sourceY = payload.origin === 'bottom-left' ? payload.height - 1 - y : y;
        for (let x = 0; x < payload.width; x += 1) {
          const source = sourceY * payload.bytesPerRow + x * 4;
          const target = (y * payload.width + x) * 4;
          if (payload.format.startsWith('bgra')) {
            png.data[target] = raw[source + 2];
            png.data[target + 1] = raw[source + 1];
            png.data[target + 2] = raw[source];
          } else {
            png.data[target] = raw[source];
            png.data[target + 1] = raw[source + 1];
            png.data[target + 2] = raw[source + 2];
          }
          png.data[target + 3] = raw[source + 3];
        }
      }
      writeFileSync(resolve(outputDir, `surface-standard-final-${payload.backend}.png`), PNG.sync.write(png));
    });
    if (backend === 'webgpu' && process.env.FORGEAX_RHI_PROBE !== '1') {
      await page.exposeBinding('__forgeaxCaptureCanvas', async (_, frame) => {
        await page.locator('#app').screenshot({ path: resolve(outputDir, `surface-standard-frame-${frame}.png`) });
      });
    }
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    const configuredPageLoadMs = Number(process.env.FORGEAX_SURFACE_PAGE_LOAD_TIMEOUT_MS ?? 120_000);
    const pageLoadTimeoutMs = Number.isFinite(configuredPageLoadMs) && configuredPageLoadMs > 0
      ? configuredPageLoadMs
      : 120_000;
    await page.goto(`http://127.0.0.1:${port}/?game=game-default&surfaceEvidence=1${process.env.FORGEAX_RHI_PROBE === '1' ? `&rhiCapture=1&rhiSeedBytes=${process.env.FORGEAX_RHI_SEED_BYTES ?? '0'}&rhiSnapshotTimeoutMs=${process.env.FORGEAX_RHI_SNAPSHOT_TIMEOUT_MS ?? '10000'}` : ''}${backend === 'webgpu' && process.env.FORGEAX_RHI_PROBE !== '1' ? '&surfaceCapture=1' : '&pixelExport=1'}`, {
      waitUntil: 'commit',
      timeout: pageLoadTimeoutMs,
    });
    try {
      await page.waitForFunction(
        () => typeof globalThis.__forgeaxSurfaceStandardEvidence === 'function',
        undefined,
        {
          timeout: pageLoadTimeoutMs,
          polling: 100,
        },
      );
    } catch (error) {
      const diagnostic = await page.evaluate(() => ({
        href: location.href,
        bodyText: document.body.innerText.slice(0, 2000),
        rendererBootstrap: globalThis.__forgeaxRendererBootstrap ?? null,
        rendererCreateFailure: globalThis.__forgeaxRendererCreateFailure ?? null,
        rhiBackendProbe: globalThis.__forgeaxRhiBackendProbe ?? null,
        inspection: typeof globalThis.__forgeaxPreviewInspection === 'object'
          ? globalThis.__forgeaxPreviewInspection?.list?.()
          : null,
        surfaceEvidenceType: typeof globalThis.__forgeaxSurfaceStandardEvidence,
      }));
      const report = { status: 'unavailable', blocker: { code: 'surface-preview-seam-timeout', detail: diagnostic }, pageErrors, consoleErrors, serverOutput, sourceSha, buildId };
      writeFileSync(resolve(outputDir, 'surface-standard-four-cell.json'), `${JSON.stringify(report, null, 2)}\n`);
      throw new Error(`Surface evidence seam unavailable: ${JSON.stringify({ error: error.message, report })}`);
    }
    let evidence;
    let evaluationTimer;
    try {
      evidence = await Promise.race([
        page.evaluate(() => globalThis.__forgeaxSurfaceStandardEvidence()),
        new Promise((_, reject) => {
          evaluationTimer = setTimeout(() => reject(new Error('surface evidence evaluation exceeded 300 seconds')), 300_000);
        }),
      ]);
    } catch (error) {
      const diagnostic = await Promise.race([
        page.evaluate(() => ({
          capturePhase: globalThis.__forgeaxRhiCapturePhase ?? null,
          rendererBootstrap: globalThis.__forgeaxRendererBootstrap ?? null,
        })),
        sleep(5_000).then(() => ({ code: 'diagnostic-page-unresponsive' })),
      ]);
      throw new Error(`${error instanceof Error ? error.message : String(error)}: ${JSON.stringify(diagnostic)}`);
    } finally {
      clearTimeout(evaluationTimer);
    }
    if (backend !== 'webgpu' || process.env.FORGEAX_RHI_PROBE === '1') await page.locator('#app').screenshot({ path: screenshot });
    const capture = await page.evaluate(() => globalThis.__forgeaxRhiCaptureResult ?? globalThis.__forgeaxRhiCapturePhase ?? null);
    const frameInspections = await page.evaluate(() => globalThis.__forgeaxSurfaceFrameInspections ?? null);
    const finalReadback = await page.evaluate(() => globalThis.__forgeaxWebGpuFinalReadback ?? null);
    const swapchainReadback = await page.evaluate(() => globalThis.__forgeaxWebGpuSwapchainReadback ?? null);
    const report = { evidence, capture, frameInspections, finalReadback, swapchainReadback, pageErrors, consoleErrors, serverOutput, sourceSha, buildId, port, screenshot };
    writeFileSync(resolve(outputDir, 'surface-standard-four-cell.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (backend === 'webgpu' && process.env.FORGEAX_RHI_PROBE === '1') {
      if (typeof capture?.path !== 'string') throw new Error(`WebGPU RHI capture unavailable: ${JSON.stringify(report)}`);
      console.log(`[surface-standard] PASS backend=webgpu rhiCapture=${capture.path}`);
      return report;
    }
    if (backend === 'webgpu' && process.env.FORGEAX_RHI_PROBE !== '1') {
      if (evidence?.status !== 'pass' || evidence?.backend !== 'browser-webgpu' || evidence?.completedFrames !== 60 || evidence?.cells?.length !== 4) throw new Error(`WebGPU surface evidence unavailable: ${JSON.stringify(report)}`);
      if (pageErrors.length > 0 || consoleErrors.length > 0) throw new Error(`Preview errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
      const signalCount = (pixels) => {
        let count = 0;
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          if (pixels.data[offset] + pixels.data[offset + 1] + pixels.data[offset + 2] > 0) count += 1;
        }
        return count;
      };
      const finalPng = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-final-webgpu.png')));
      const swapchainPng = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-final-webgpu-swapchain.png')));
      const compositorPng = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-frame-59.png')));
      const finalPixels = signalCount(finalPng);
      const swapchainPixels = signalCount(swapchainPng);
      const compositorPixels = signalCount(compositorPng);
      if (finalPixels === 0 || swapchainPixels === 0 || !finalPng.data.equals(swapchainPng.data)) {
        throw new Error(`WebGPU output mismatch: final-display=${finalPixels} swapchain=${swapchainPixels}`);
      }
      const pixelEvidence = {
        finalPixels,
        swapchainPixels,
        compositorPixels,
        readbackMatch: true,
        image: resolve(outputDir, 'surface-standard-final-webgpu-swapchain.png'),
      };
      const accepted = { ...report, screenshot: pixelEvidence.image, pixelEvidence };
      writeFileSync(resolve(outputDir, 'surface-standard-four-cell.json'), `${JSON.stringify(accepted, null, 2)}\n`);
      console.log(`[surface-standard] PASS backend=webgpu swapchain=${pixelEvidence.image} signalPixels=${swapchainPixels} compositorScreenshotPixels=${compositorPixels}`);
      return accepted;
    }
    if (evidence?.status !== 'pass' || evidence?.completedFrames !== 60 || evidence?.cells?.length !== 4) throw new Error(`Surface evidence unavailable: ${JSON.stringify(report)}`);
    if (pageErrors.length > 0 || consoleErrors.length > 0) throw new Error(`Preview errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
    const webgl2Png = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-final-webgl2.png')));
    let signalPixels = 0;
    for (let offset = 0; offset < webgl2Png.data.length; offset += 4) {
      if (webgl2Png.data[offset] + webgl2Png.data[offset + 1] + webgl2Png.data[offset + 2] > 0) signalPixels += 1;
    }
    if (signalPixels === 0) throw new Error('WebGL2 swapchain readback is black');
    const accepted = { ...report, pixelEvidence: { signalPixels, image: resolve(outputDir, 'surface-standard-final-webgl2.png') } };
    writeFileSync(resolve(outputDir, 'surface-standard-four-cell.json'), `${JSON.stringify(accepted, null, 2)}\n`);
    console.log(`[surface-standard] PASS backend=${evidence.backend} cells=${evidence.cells.length} signalPixels=${signalPixels} artifacts=${outputDir}`);
    return accepted;
  } finally {
    if (browser !== undefined) {
      const closed = await Promise.race([
        browser.close().then(() => true, () => true),
        sleep(5_000).then(() => false),
      ]);
      if (!closed) {
        const children = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
        for (const line of children.split('\n')) {
          const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
          if (match === null || Number(match[2]) !== process.pid || !match[3].includes('ms-playwright/chromium')) continue;
          process.kill(Number(match[1]), 'SIGKILL');
        }
      }
    }
    if (server.pid !== undefined) {
      try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
      await sleep(1_000);
      try { process.kill(-server.pid, 'SIGKILL'); } catch {}
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runSurfaceStandardSmoke().catch((error) => {
    console.error(`[surface-standard] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
