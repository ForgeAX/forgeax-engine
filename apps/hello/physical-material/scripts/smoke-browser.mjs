#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const appRoot = decodeURIComponent(root.pathname);
const browserPort = process.env.FORGEAX_BROWSER_PORT;
const backend = process.env.FORGEAX_BROWSER_BACKEND ?? 'webgpu';
if (backend !== 'webgpu' && backend !== 'webgl2') throw new Error(`unsupported backend: ${backend}`);
const evidenceDir = process.env.FORGEAX_BROWSER_EVIDENCE_DIR;
if (evidenceDir !== undefined) mkdirSync(evidenceDir, { recursive: true });
const viteArgs = [resolve(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'];
if (browserPort !== undefined) viteArgs.push('--port', browserPort, '--strictPort');
const vite = spawn(process.execPath, viteArgs, {
  cwd: appRoot,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let url;
const output = [];
const onOutput = (chunk) => {
  const text = chunk.toString();
  output.push(text);
  const clean = text.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
  const match = clean.match(/Local:\s+(https?:\/\/[^\s]+)/);
  if (match?.[1] !== undefined) url = match[1];
};
vite.stdout.on('data', onOutput);
vite.stderr.on('data', onOutput);
try {
  const deadline = Date.now() + 180_000;
  while (url === undefined && Date.now() < deadline) await delay(100);
  if (url === undefined) throw new Error(`waitForServer failed: ${output.join('')}`);
  const browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    ...(backend === 'webgpu' ? { channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome' } : {}),
    args: backend === 'webgpu'
      ? ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist']
      : ['--disable-features=WebGPU', `--use-angle=${process.platform === 'darwin' ? 'metal' : 'swiftshader'}`, '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    if (backend === 'webgl2') await page.addInitScript(() => { delete Navigator.prototype.gpu; });
    const reportedConsoleErrors = new Set();
    const browserErrors = [];
    const reportBrowserError = (kind, text) => {
      const entry = `${kind}: ${text}`;
      if (!browserErrors.includes(entry)) browserErrors.push(entry);
    };
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (reportedConsoleErrors.has(text)) return;
      reportedConsoleErrors.add(text);
      reportBrowserError('console', text);
      console.error(`browser console error: ${text}`);
    });
    page.on('pageerror', (error) => {
      reportBrowserError('page', error.message);
      console.error(`browser page error: ${error.message}`);
    });
    page.on('requestfailed', (request) => {
      reportBrowserError('request', `${request.url()}: ${request.failure()?.errorText ?? 'failed'}`);
    });
    page.on('response', (response) => {
      if (response.status() >= 400) reportBrowserError('response', `${response.status()} ${response.url()}`);
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const fetchedCaseManifest = await page.evaluate(async () => {
      const response = await fetch('/evidence/case-manifest.json');
      if (!response.ok) throw new Error(`case manifest fetch failed: ${response.status}`);
      const serialized = await response.text();
      return JSON.stringify(JSON.parse(serialized));
    });
    if (typeof fetchedCaseManifest !== 'string') throw new Error('case manifest JSON.parse failed');
    const evidenceTimeout = 60_000;
    const waitForEvidence = async (predicate, label) => {
      try {
        await page.waitForFunction(predicate, null, { timeout: evidenceTimeout });
      } catch (error) {
        const evidence = await page.evaluate(() => globalThis.__forgeaxPhysicalMaterialEvidence);
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}; evidence=${JSON.stringify(evidence)}`);
      }
    };
    await waitForEvidence(() => globalThis.__forgeaxPhysicalMaterialEvidence?.ready === true, 'carrier readiness timeout');
    await waitForEvidence(
      () => globalThis.__forgeaxPhysicalMaterialEvidence?.materialLoad?.status === 'ok',
      'physical material GUID load timeout',
    );
    await waitForEvidence(
      () => globalThis.__forgeaxPhysicalMaterialEvidence?.caseManifest?.equal === true,
      'case manifest fetch roundtrip timeout',
    );
    await waitForEvidence(() => (globalThis.__forgeaxPhysicalMaterialEvidence?.frameCount ?? 0) >= 60, 'submitted frame timeout');
    await waitForEvidence(
      () => {
        const readback = globalThis.__forgeaxPhysicalMaterialEvidence?.renderDiagnostics?.readback;
        return readback?.status === 'ok' && readback.nonZeroBytes > 0;
      },
      'non-empty readback timeout',
    );
    const evidence = await page.evaluate(() => globalThis.__forgeaxPhysicalMaterialEvidence);
    if (evidenceDir !== undefined) {
      await page.locator('#app').screenshot({ path: resolve(evidenceDir, `physical-material-${backend}.png`) });
      writeFileSync(resolve(evidenceDir, `physical-material-${backend}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    }
    if (evidence?.webgpu !== (backend === 'webgpu')) throw new Error(`browser ${backend} unavailable`);
    if (evidence?.materialLoad?.status !== 'ok') {
      throw new Error(`physical material GUID load unavailable: ${JSON.stringify(evidence?.materialLoad)}`);
    }
    if (evidence?.renderDiagnostics?.readback?.status !== 'ok') {
      throw new Error(`observation-unavailable: ${JSON.stringify(evidence?.renderDiagnostics?.readback)}`);
    }
    if (evidence?.caseRecords?.length !== 16) {
      throw new Error(`case coverage incomplete: expected 16 records, got ${evidence?.caseRecords?.length ?? 0}`);
    }
    if (evidence.caseRecords.some((record) => typeof record?.rawHash !== 'string')) {
      throw new Error('case evidence missing rawHash');
    }
    if (evidence.semanticEvaluation?.verdict !== 'pass') {
      throw new Error(`semantic evaluator failed: ${JSON.stringify(evidence.semanticEvaluation)}; paired=${JSON.stringify(evidence.pairedSentinelEvaluation)}; evidenceErrors=${JSON.stringify(evidence.errors)}; browserErrors=${JSON.stringify(browserErrors)}`);
    }
    if (evidence.pairedSentinelEvaluation?.verdict !== 'pass') {
      throw new Error(`paired sentinel evaluator failed: ${JSON.stringify(evidence.pairedSentinelEvaluation)}; records=${evidence.caseRecords?.length ?? 0}; evidenceErrors=${JSON.stringify(evidence.errors)}; browserErrors=${JSON.stringify(browserErrors)}`);
    }
    if (Array.isArray(evidence.errors) && evidence.errors.length !== 0) {
      throw new Error(`browser evidence errors: ${JSON.stringify(evidence.errors)}`);
    }
    if (browserErrors.length !== 0) throw new Error(`browser page/console/request errors: ${JSON.stringify(browserErrors)}`);
    console.log(JSON.stringify({ status: 'pass', frames: evidence.frameCount, browserPath: true, backend, materialLoad: evidence.materialLoad, renderDiagnostics: evidence.renderDiagnostics, semanticEvaluation: evidence.semanticEvaluation, pairedSentinelEvaluation: evidence.pairedSentinelEvaluation, browserErrors }));
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`physical-material browser smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try { process.kill(-vite.pid, 'SIGTERM'); } catch { vite.kill('SIGTERM'); }
  await delay(500);
  if (vite.exitCode === null && vite.signalCode === null) {
    try { process.kill(-vite.pid, 'SIGKILL'); } catch { vite.kill('SIGKILL'); }
  }
  vite.stdout.destroy();
  vite.stderr.destroy();
}
