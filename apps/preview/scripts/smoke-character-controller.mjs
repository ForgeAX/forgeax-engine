#!/usr/bin/env node
// Prove game-default's authored Player uses the public CharacterController path.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_CHARACTER_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/character-controller'));
const PORT = Number.parseInt(process.env.FORGEAX_CHARACTER_PORT ?? '5190', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });
const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'], chromiumSandbox: true});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`); });
const read = () => page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot());
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await page.goto(`http://127.0.0.1:${PORT}/?game=game-default&render-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 }); break; }
    catch (error) { if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`); await sleep(250); }
  }
  await page.waitForTimeout(1_500);
  const before = await read();
  if (!before?.characterController) throw new Error(`character controller witness unavailable: ${JSON.stringify(before)}`);
  const beforeX = before.characterController.position[0];
  await page.keyboard.down('d');
  await page.waitForTimeout(500);
  await page.keyboard.up('d');
  const moved = await read();
  await page.keyboard.down(' ');
  await page.waitForTimeout(180);
  await page.keyboard.up(' ');
  const jumped = await read();
  await page.waitForTimeout(900);
  const landed = await read();
  await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
  await page.waitForFunction((expectedX) => {
    const witness = globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot().characterController;
    return witness?.grounded === true && Math.abs(witness.position[0] - expectedX) < 0.08 && Math.abs(witness.position[1] - 0.71) < 0.08;
  }, beforeX, { timeout: 5_000 });
  const reset = await read();
  const report = { before, moved, jumped, landed, reset, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter((line) => !line.includes('favicon') && !line.includes('Failed to load resource'));
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  if (moved.characterController.position[0] <= beforeX + 0.35) throw new Error(`D did not move Player: ${JSON.stringify({ before: before.characterController, moved: moved.characterController })}`);
  if (jumped.characterController.position[1] <= before.characterController.position[1] + 0.05 && jumped.characterController.grounded === true) throw new Error(`Space did not leave the ground: ${JSON.stringify({ before: before.characterController, jumped: jumped.characterController })}`);
  if (landed.characterController.grounded !== true) throw new Error(`Player did not land: ${JSON.stringify(landed.characterController)}`);
  if (Math.abs(reset.characterController.position[0] - beforeX) > 0.08 || Math.abs(reset.characterController.position[1] - before.characterController.position[1]) > 0.08 || reset.characterController.grounded !== true) throw new Error(`reset did not restore Player: ${JSON.stringify({ before: before.characterController, reset: reset.characterController })}`);
  console.log(`[character-controller] PASS movedX=${moved.characterController.position[0].toFixed(2)} jumpedY=${jumped.characterController.position[1].toFixed(2)} resetGrounded=${reset.characterController.grounded}`);
  console.log(`[character-controller] artifacts=${ARTIFACT_DIR}`);
} finally { await browser.close(); server.kill('SIGTERM'); await sleep(300); }
