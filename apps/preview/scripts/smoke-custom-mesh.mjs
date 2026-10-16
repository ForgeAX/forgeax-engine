#!/usr/bin/env node
// Focused game-default custom MeshAsset/TextureAsset integration smoke.
// The render-evidence handle invokes the same owner used by the G InputSnapshot
// action; the canonical browser smoke separately exercises the key binding.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_CUSTOM_MESH_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/custom-mesh'));
const PORT = Number.parseInt(process.env.FORGEAX_CUSTOM_MESH_PORT ?? '5188', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?render-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 });
    break;
  } catch (error) {
    if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
    await sleep(250);
  }
}
await page.waitForTimeout(2_000);

const before = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot());
if (!before?.customProjectileMesh?.available || before.customProjectileMesh.uvMode !== 'upper' || before.customProjectileMesh.textureSource !== 'procedural' || typeof before.customProjectileMesh.textureFormat !== 'string' || before.customProjectileMesh.textureFormat.length === 0) {
  throw new Error(`custom projectile mesh unavailable: ${JSON.stringify(before?.customProjectileMesh)}`);
}
await page.evaluate(() => {
  const evidence = globalThis.__forgeaxGameDefaultRenderEvidence;
  if (!evidence?.toggleCustomProjectileMesh) throw new Error('custom projectile toggle witness missing');
  evidence.toggleCustomProjectileMesh();
});
await page.waitForTimeout(180);
const toggled = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
if (toggled.customProjectileMesh.uvMode !== 'lower' || toggled.customProjectileMesh.toggles !== before.customProjectileMesh.toggles + 1) {
  throw new Error(`custom projectile toggle failed: ${JSON.stringify({ before: before.customProjectileMesh, toggled: toggled.customProjectileMesh })}`);
}
await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
await page.waitForTimeout(180);
const reset = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
if (reset.customProjectileMesh.uvMode !== 'upper') {
  throw new Error(`custom projectile reset failed: ${JSON.stringify(reset.customProjectileMesh)}`);
}

const report = { before: before.customProjectileMesh, toggled: toggled.customProjectileMesh, reset: reset.customProjectileMesh, pageErrors, serverOutput };
writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`[custom-mesh] PASS before=${before.customProjectileMesh.uvMode} toggled=${toggled.customProjectileMesh.uvMode} reset=${reset.customProjectileMesh.uvMode}`);
console.log(`[custom-mesh] artifacts=${ARTIFACT_DIR}`);
await browser.close();
server.kill('SIGTERM');
