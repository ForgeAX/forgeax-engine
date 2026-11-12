#!/usr/bin/env node
import { once } from 'node:events';
// Capture the four imported Standard Surface cells through the real Preview
// Pack/Catalog/cook/loadByGuid and ForgeAX WebGL2 renderer path.
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

async function findAvailablePort() {
  const probe = createNetServer();
  await once(probe.listen(0, '127.0.0.1'), 'listening');
  const address = probe.address();
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  if (address === null || typeof address === 'string') throw new Error('surface-standard: dynamic port unavailable');
  return address.port;
}

function positiveNumberFromEnv(name, fallback) {
  const configured = Number(process.env[name] ?? fallback);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

async function resolveSurfaceRun(options) {
  const backend = process.env.FORGEAX_SURFACE_BACKEND ?? 'webgl2';
  const configuredPort = options.port ?? (process.env.FORGEAX_SURFACE_PORT === undefined
    ? undefined
    : Number.parseInt(process.env.FORGEAX_SURFACE_PORT, 10));
  const port = configuredPort === undefined || configuredPort === 0 ? await findAvailablePort() : configuredPort;
  const outputDir = resolve(options.outputDir ?? process.env.FORGEAX_SURFACE_DIR ?? resolve(ROOT, '.forgeax-debug/surface-standard'));
  mkdirSync(outputDir, { recursive: true });
  const sourceSha = options.sourceSha ?? process.env.VITE_FORGEAX_EVIDENCE_SOURCE_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const buildId = options.buildId ?? process.env.VITE_FORGEAX_EVIDENCE_BUILD_ID ?? `preview-surface-${sourceSha.slice(0, 12)}`;
  return { backend, rhiProbe: process.env.FORGEAX_RHI_PROBE === '1', port, outputDir, sourceSha, buildId };
}

function startPreviewServer(run) {
  const proc = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(run.port), '--strictPort'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FORGEAX_SURFACE_PROBE: run.rhiProbe ? '0' : '1',
      FORGEAX_SURFACE_ONLY: '1',
      VITE_FORGEAX_EVIDENCE_SOURCE_SHA: run.sourceSha,
      VITE_FORGEAX_EVIDENCE_BUILD_ID: run.buildId,
    },
  });
  const server = { proc, output: '' };
  proc.stdout.on('data', (chunk) => { server.output += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { server.output += chunk.toString(); });
  return server;
}

async function awaitPreviewServer(port, server) {
  // A clean workspace can spend more than 30s in Vite dependency
  // re-optimization before it opens its listener. This is startup allowance
  // only; the four-cell WebGL2 readback and error gates below are unchanged.
  const readinessTimeoutMs = positiveNumberFromEnv('FORGEAX_SURFACE_SERVER_READINESS_TIMEOUT_MS', 180_000);
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })).ok) break;
    } catch {}
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`Preview server did not start: ${server.output}`);
}

function launchSurfaceBrowser(backend) {
  return chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel,
    args: backend === 'webgpu' ? browserLaunch.args : [
      '--disable-features=WebGPU',
      '--disable-gpu',
      '--disable-gpu-driver-bug-workarounds',
    ],
    chromiumSandbox: true,
  });
}

function writePixelPayloadPng(outputDir, payload) {
  const raw = Buffer.from(payload.base64, 'base64');
  const png = new PNG({ width: payload.width, height: payload.height });
  const bgra = payload.format.startsWith('bgra');
  for (let y = 0; y < payload.height; y += 1) {
    const sourceY = payload.origin === 'bottom-left' ? payload.height - 1 - y : y;
    for (let x = 0; x < payload.width; x += 1) {
      const source = sourceY * payload.bytesPerRow + x * 4;
      const target = (y * payload.width + x) * 4;
      png.data[target] = raw[bgra ? source + 2 : source];
      png.data[target + 1] = raw[source + 1];
      png.data[target + 2] = raw[bgra ? source : source + 2];
      png.data[target + 3] = raw[source + 3];
    }
  }
  writeFileSync(resolve(outputDir, `surface-standard-final-${payload.backend}.png`), PNG.sync.write(png));
}

async function exposeCaptureBindings(page, run) {
  await page.exposeBinding('__forgeaxCapturePixels', async (_, payload) => {
    writePixelPayloadPng(run.outputDir, payload);
  });
  if (run.backend === 'webgpu' && !run.rhiProbe) {
    await page.exposeBinding('__forgeaxCaptureCanvas', async (_, frame) => {
      await page.locator('#app').screenshot({ path: resolve(run.outputDir, `surface-standard-frame-${frame}.png`) });
    });
  }
}

function surfaceEvidenceUrl(run) {
  const rhiQuery = run.rhiProbe
    ? `&rhiCapture=1&rhiSeedBytes=${process.env.FORGEAX_RHI_SEED_BYTES ?? '0'}&rhiSnapshotTimeoutMs=${process.env.FORGEAX_RHI_SNAPSHOT_TIMEOUT_MS ?? '10000'}`
    : '';
  const captureQuery = run.backend === 'webgpu' && !run.rhiProbe ? '&surfaceCapture=1' : '&pixelExport=1';
  return `http://127.0.0.1:${run.port}/?game=game-default&surfaceEvidence=1${rhiQuery}${captureQuery}`;
}

function writeSurfaceReport(outputDir, report) {
  writeFileSync(resolve(outputDir, 'surface-standard-four-cell.json'), `${JSON.stringify(report, null, 2)}\n`);
}

async function waitForEvidenceSeam(page, run, pageLoadTimeoutMs, pageIssues, server) {
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
    const report = { status: 'unavailable', blocker: { code: 'surface-preview-seam-timeout', detail: diagnostic }, pageErrors: pageIssues.pageErrors, consoleErrors: pageIssues.consoleErrors, serverOutput: server.output, sourceSha: run.sourceSha, buildId: run.buildId };
    writeSurfaceReport(run.outputDir, report);
    throw new Error(`Surface evidence seam unavailable: ${JSON.stringify({ error: error.message, report })}`);
  }
}

async function evaluateSurfaceEvidence(page) {
  let evaluationTimer;
  try {
    return await Promise.race([
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
}

function countPngSignalPixels(png) {
  let count = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (png.data[offset] + png.data[offset + 1] + png.data[offset + 2] > 0) count += 1;
  }
  return count;
}

function assertNoPreviewErrors({ pageErrors, consoleErrors }) {
  if (pageErrors.length > 0 || consoleErrors.length > 0) throw new Error(`Preview errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
}

function acceptWebGpuRhiProbe(report) {
  if (typeof report.capture?.path !== 'string') throw new Error(`WebGPU RHI capture unavailable: ${JSON.stringify(report)}`);
  console.log(`[surface-standard] PASS backend=webgpu rhiCapture=${report.capture.path}`);
  return report;
}

function acceptWebGpuEvidence(report, outputDir) {
  const { evidence } = report;
  if (evidence?.status !== 'pass' || evidence?.backend !== 'browser-webgpu' || evidence?.completedFrames !== 60 || evidence?.cells?.length !== 4) throw new Error(`WebGPU surface evidence unavailable: ${JSON.stringify(report)}`);
  assertNoPreviewErrors(report);
  const finalPng = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-final-webgpu.png')));
  const swapchainPng = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-final-webgpu-swapchain.png')));
  const compositorPng = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-frame-59.png')));
  const finalPixels = countPngSignalPixels(finalPng);
  const swapchainPixels = countPngSignalPixels(swapchainPng);
  const compositorPixels = countPngSignalPixels(compositorPng);
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
  writeSurfaceReport(outputDir, accepted);
  console.log(`[surface-standard] PASS backend=webgpu swapchain=${pixelEvidence.image} signalPixels=${swapchainPixels} compositorScreenshotPixels=${compositorPixels}`);
  return accepted;
}

function acceptWebgl2Evidence(report, outputDir) {
  const { evidence } = report;
  if (evidence?.status !== 'pass' || evidence?.completedFrames !== 60 || evidence?.cells?.length !== 4) throw new Error(`Surface evidence unavailable: ${JSON.stringify(report)}`);
  assertNoPreviewErrors(report);
  const webgl2Png = PNG.sync.read(readFileSync(resolve(outputDir, 'surface-standard-final-webgl2.png')));
  const signalPixels = countPngSignalPixels(webgl2Png);
  if (signalPixels === 0) throw new Error('WebGL2 swapchain readback is black');
  const accepted = { ...report, pixelEvidence: { signalPixels, image: resolve(outputDir, 'surface-standard-final-webgl2.png') } };
  writeSurfaceReport(outputDir, accepted);
  console.log(`[surface-standard] PASS backend=${evidence.backend} cells=${evidence.cells.length} signalPixels=${signalPixels} artifacts=${outputDir}`);
  return accepted;
}

async function captureSurfaceEvidence(browser, run, server) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  const screenshot = resolve(run.outputDir, `surface-standard-four-cell-${run.backend}.png`);
  await exposeCaptureBindings(page, run);
  const pageIssues = { pageErrors: [], consoleErrors: [] };
  page.on('pageerror', (error) => pageIssues.pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') pageIssues.consoleErrors.push(message.text()); });
  const pageLoadTimeoutMs = positiveNumberFromEnv('FORGEAX_SURFACE_PAGE_LOAD_TIMEOUT_MS', 120_000);
  await page.goto(surfaceEvidenceUrl(run), {
    waitUntil: 'commit',
    timeout: pageLoadTimeoutMs,
  });
  await waitForEvidenceSeam(page, run, pageLoadTimeoutMs, pageIssues, server);
  const evidence = await evaluateSurfaceEvidence(page);
  if (run.backend !== 'webgpu' || run.rhiProbe) await page.locator('#app').screenshot({ path: screenshot });
  const capture = await page.evaluate(() => globalThis.__forgeaxRhiCaptureResult ?? globalThis.__forgeaxRhiCapturePhase ?? null);
  const frameInspections = await page.evaluate(() => globalThis.__forgeaxSurfaceFrameInspections ?? null);
  const finalReadback = await page.evaluate(() => globalThis.__forgeaxWebGpuFinalReadback ?? null);
  const swapchainReadback = await page.evaluate(() => globalThis.__forgeaxWebGpuSwapchainReadback ?? null);
  const report = { evidence, capture, frameInspections, finalReadback, swapchainReadback, pageErrors: pageIssues.pageErrors, consoleErrors: pageIssues.consoleErrors, serverOutput: server.output, sourceSha: run.sourceSha, buildId: run.buildId, port: run.port, screenshot };
  writeSurfaceReport(run.outputDir, report);
  return report;
}

async function closeSurfaceBrowser(browser) {
  const closed = await Promise.race([
    browser.close().then(() => true, () => true),
    sleep(5_000).then(() => false),
  ]);
  if (closed) return;
  const children = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  for (const line of children.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match === null || Number(match[2]) !== process.pid || !match[3].includes('ms-playwright/chromium')) continue;
    process.kill(Number(match[1]), 'SIGKILL');
  }
}

async function stopPreviewServer({ proc }) {
  if (proc.pid === undefined) return;
  try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
  await sleep(1_000);
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
}

export async function runSurfaceStandardSmoke(options = {}) {
  const run = await resolveSurfaceRun(options);
  const server = startPreviewServer(run);
  let browser;
  try {
    await awaitPreviewServer(run.port, server);
    browser = await launchSurfaceBrowser(run.backend);
    const report = await captureSurfaceEvidence(browser, run, server);
    if (run.backend === 'webgpu' && run.rhiProbe) return acceptWebGpuRhiProbe(report);
    if (run.backend === 'webgpu') return acceptWebGpuEvidence(report, run.outputDir);
    return acceptWebgl2Evidence(report, run.outputDir);
  } finally {
    if (browser !== undefined) await closeSurfaceBrowser(browser);
    await stopPreviewServer(server);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runSurfaceStandardSmoke().catch((error) => {
    console.error(`[surface-standard] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
