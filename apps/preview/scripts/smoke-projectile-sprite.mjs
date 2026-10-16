#!/usr/bin/env node
// Verify the game-default projectile visual cycle is a reversible slice over
// the existing input, command-buffer, light, and reset owners.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_PROJECTILE_SPRITE_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/projectile-sprite'));
const PORT = Number.parseInt(process.env.FORGEAX_PROJECTILE_SPRITE_PORT ?? '5190', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'], chromiumSandbox: true});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default&render-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForFunction(() => Boolean(globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot().customProjectileMesh.available), undefined, { timeout: 20_000 });
  const before = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.toggleProjectileVisual());
  await page.waitForTimeout(180);
  const toggled = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  if (toggled.customProjectileMesh.representation !== 'sprite') throw new Error(`sprite representation did not activate: ${JSON.stringify(toggled.customProjectileMesh)}`);

  await page.mouse.click(500, 300);
  await page.waitForFunction((count) => (globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot().deferredCommands.spawned ?? 0) > count, before.deferredCommands.spawned, { timeout: 5_000 });
  const fired = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  if (fired.customProjectileMesh.representation !== 'sprite') throw new Error(`fired projectile lost sprite representation: ${JSON.stringify(fired.customProjectileMesh)}`);

  await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.toggleProjectileVisual());
  await page.waitForTimeout(180);
  const lit = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  if (lit.customProjectileMesh.representation !== 'sprite-lit') throw new Error(`lit sprite representation did not activate: ${JSON.stringify(lit.customProjectileMesh)}`);

  await page.waitForTimeout(400);
  await page.mouse.click(500, 300);
  await page.waitForFunction((count) => (globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot().deferredCommands.spawned ?? 0) > count, fired.deferredCommands.spawned, { timeout: 5_000 });
  const firedLit = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  if (firedLit.customProjectileMesh.representation !== 'sprite-lit') throw new Error(`fired lit projectile lost sprite-lit representation: ${JSON.stringify(firedLit.customProjectileMesh)}`);
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'sprite-lit-projectile.png') });

  await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
  await page.waitForTimeout(180);
  const reset = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  if (reset.customProjectileMesh.representation !== 'mesh') throw new Error(`sprite reset did not restore baseline: ${JSON.stringify({ projectile: reset.customProjectileMesh, commands: reset.deferredCommands })}`);

  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'sprite-projectile.png') });
  const report = { before: before.customProjectileMesh, toggled: toggled.customProjectileMesh, fired: { projectile: fired.customProjectileMesh, commands: fired.deferredCommands }, lit: lit.customProjectileMesh, firedLit: { projectile: firedLit.customProjectileMesh, commands: firedLit.deferredCommands }, reset: { projectile: reset.customProjectileMesh, commands: reset.deferredCommands }, pageErrors, consoleErrors, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[projectile-sprite] PASS cycle=${toggled.customProjectileMesh.representation}->${lit.customProjectileMesh.representation}->${reset.customProjectileMesh.representation} spawned=${firedLit.deferredCommands.spawned}`);
  console.log(`[projectile-sprite] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
