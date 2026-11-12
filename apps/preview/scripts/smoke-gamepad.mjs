#!/usr/bin/env node
// Prove game-default's semantic gamepad bindings reach the existing mesh/reset/shoot loop.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_GAMEPAD_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/gamepad'));
const PORT = Number.parseInt(process.env.FORGEAX_GAMEPAD_PORT ?? '5189', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });
const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'], chromiumSandbox: true});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
await page.addInitScript(() => {
  let current = { south: false, y: false, trigger: 0 };
  const button = (value) => ({ pressed: value > 0.5, touched: value > 0, value });
  const pad = () => ({ id: 'ForgeAX game-default mock', index: 0, connected: true, mapping: 'standard', buttons: [button(current.south ? 1 : 0), button(0), button(0), button(current.y ? 1 : 0), button(0), button(0), button(0), button(current.trigger)], axes: [0, 0, 0, 0], timestamp: performance.now() });
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [pad()] });
  globalThis.__setGameDefaultGamepad = (next) => { current = { ...current, ...next }; };
});
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { await page.goto(`http://127.0.0.1:${PORT}/?game=game-default&render-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 }); break; }
    catch (error) { if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`); await sleep(250); }
  }
  await page.waitForTimeout(2_000);
  const before = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot());
  if (!before?.customProjectileMesh?.available || !before.gamepad?.connected || !before.gamepad.standardMapping) throw new Error(`gamepad witness unavailable: ${JSON.stringify({ mesh: before?.customProjectileMesh, gamepad: before?.gamepad })}`);
  await page.evaluate(() => globalThis.__setGameDefaultGamepad({ y: true }));
  await page.waitForFunction(() => (globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot().customProjectileMesh?.toggles ?? 0) > 0, undefined, { timeout: 5_000 });
  const toggled = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  await page.evaluate(() => globalThis.__setGameDefaultGamepad({ y: false, trigger: 1 }));
  await page.waitForFunction(() => (globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot().deferredCommands?.spawned ?? 0) > 0, undefined, { timeout: 5_000 });
  const fired = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  await page.evaluate(() => globalThis.__setGameDefaultGamepad({ trigger: 0 }));
  await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.reset());
  await page.waitForTimeout(220);
  const reset = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.snapshot());
  if (toggled.customProjectileMesh.toggles <= before.customProjectileMesh.toggles) throw new Error(`Y action did not toggle mesh: ${JSON.stringify({ before: before.customProjectileMesh, toggled: toggled.customProjectileMesh })}`);
  if (fired.deferredCommands.spawned <= before.deferredCommands.spawned || fired.gamepad.rightTrigger < 0.9) throw new Error(`R2 action did not fire: ${JSON.stringify({ before: before.deferredCommands, fired: fired.deferredCommands, gamepad: fired.gamepad })}`);
  const report = { before: { gamepad: before.gamepad, mesh: before.customProjectileMesh, commands: before.deferredCommands }, toggled: toggled.customProjectileMesh, fired: { gamepad: fired.gamepad, commands: fired.deferredCommands }, reset: { mesh: reset.customProjectileMesh }, pageErrors, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[gamepad] PASS connected=${before.gamepad.connected} yToggles=${toggled.customProjectileMesh.toggles} fired=${fired.deferredCommands.spawned - before.deferredCommands.spawned} reset=${reset.customProjectileMesh.uvMode}`);
} finally { await browser.close(); server.kill('SIGTERM'); }
