#!/usr/bin/env node
// Player-visible proof for the authored hit-streak loop. It uses the same
// canvas click and keyboard path as a first user, then observes the game-owned
// snapshot and HUD instead of calling an inspection-only score action.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_HIT_STREAK_DIR ?? resolve(ROOT, '.forgeax-debug/hit-streak'));
const PORT = Number.parseInt(process.env.FORGEAX_HIT_STREAK_PORT ?? '5221', 10);
const MODE = process.env.FORGEAX_HIT_STREAK_MODE ?? 'dev';
const ORIGIN = `http://127.0.0.1:${PORT}`;
mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn(
  'pnpm',
  MODE === 'production'
    ? ['--filter', '@forgeax/preview', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
    : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
let browser;
let page;

const readSnapshot = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
const readHud = () => page.evaluate(() => {
  const host = document.querySelector('[data-ui-asset]');
  const shadow = host?.shadowRoot;
  const combo = shadow?.querySelector('[data-ui-slot="combo"]');
  const score = shadow?.querySelector('[data-ui-slot="score"]');
  return {
    comboText: combo?.textContent ?? null,
    comboState: combo?.getAttribute('data-state') ?? null,
    scoreText: score?.textContent ?? null,
  };
});
const holdKey = async (key, duration = 90) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};

function writeReport(status, extra = {}) {
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({ status, mode: MODE, ...extra, pageErrors, consoleErrors, badResponses, serverOutput }, null, 2)}\n`);
}

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/`);
      if (response.ok) break;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`Preview server did not start: ${serverOutput}`);

  browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
      '--autoplay-policy=no-user-gesture-required',
    ],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`); });

  await page.goto(`${ORIGIN}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  await page.waitForFunction(
    async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play',
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  await page.waitForTimeout(500);

  await holdKey('r');
  await page.waitForTimeout(350);
  const baseline = await readSnapshot();
  const baselineHealthEvents = baseline?.value?.targetHealth?.damageEvents ?? 0;
  if (!baseline?.ok || baseline?.value?.hitStreak?.hits !== 0) throw new Error(`combo baseline failed: ${JSON.stringify(baseline)}`);

  // The isolated BouncyBall is stable at this viewport. A click sets the ECS
  // aim direction and fires the first normal projectile in the same input
  // frame without also traversing the authored crate stack behind RedBox.
  await page.mouse.click(304, 379);
  await page.waitForTimeout(850);
  const first = await readSnapshot();
  const firstHud = await readHud();
  if (!first?.ok || (first.value.targetHealth?.damageEvents ?? 0) <= baselineHealthEvents || first.value.hitStreak?.hits !== 1 || first.value.hitStreak?.multiplier !== 1 || firstHud.comboState !== 'active' || !firstHud.comboText?.includes('Combo x1.00')) {
    throw new Error(`first hit did not start combo: ${JSON.stringify({ baseline, first, firstHud })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'combo-first-hit.png') });

  // Keep the second hit inside the 1.65s ECS window. The 90ms hold spans a
  // frame scan but stays below the authored 180ms projectile cooldown.
  await holdKey('f');
  await page.waitForTimeout(850);
  const second = await readSnapshot();
  const secondHud = await readHud();
  if (!second?.ok || (second.value.targetHealth?.damageEvents ?? 0) <= (first.value.targetHealth?.damageEvents ?? 0) || second.value.hitStreak?.hits !== 2 || Math.abs((second.value.hitStreak?.multiplier ?? 0) - 1.25) > 0.001 || secondHud.comboState !== 'active' || !secondHud.comboText?.includes('Combo x1.25')) {
    throw new Error(`second hit did not grow combo: ${JSON.stringify({ first, second, secondHud })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'combo-active.png') });

  await page.waitForTimeout(2_100);
  const expired = await readSnapshot();
  const expiredHud = await readHud();
  if (!expired?.ok || expired.value.hitStreak?.hits !== 0 || expiredHud.comboState !== 'expired' || !expiredHud.comboText?.includes('Combo expired')) {
    throw new Error(`combo did not expire through Update: ${JSON.stringify({ expired, expiredHud })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'combo-expired.png') });

  // Authored targets are dynamic physics bodies, so use the normal reset
  // transaction before replaying the fixed viewport aim point. This keeps the
  // replay proof on the player's lifecycle path rather than relying on a
  // moving target's incidental position.
  await holdKey('r');
  await page.waitForTimeout(350);
  await page.mouse.click(304, 379);
  await page.waitForTimeout(850);
  const replay = await readSnapshot();
  const replayHud = await readHud();
  if (!replay?.ok || replay.value.hitStreak?.hits !== 1 || replay.value.hitStreak?.multiplier !== 1 || replayHud.comboState !== 'active') {
    throw new Error(`expired combo did not replay from one hit: ${JSON.stringify({ replay, replayHud })}`);
  }

  await holdKey('r');
  await page.waitForTimeout(350);
  const reset = await readSnapshot();
  const resetHud = await readHud();
  const resetHealth = reset?.value?.targetHealth?.totalCurrent ?? 0;
  const resetMaxHealth = reset?.value?.targetHealth?.totalMax ?? 0;
  if (!reset?.ok || reset.value.hitStreak?.hits !== 0 || reset.value.hitStreak?.multiplier !== 1 || resetHud.comboState !== 'ready' || !resetHud.comboText?.includes('Combo ready') || resetHealth !== resetMaxHealth || resetHud.scoreText !== 'Score  0') {
    throw new Error(`combo reset failed: ${JSON.stringify({ reset, resetHud })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'combo-reset.png') });

  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  writeReport('passed', { baseline, first, firstHud, second, secondHud, expired, expiredHud, replay, replayHud, reset, resetHud });
  console.log(`Hit streak smoke PASS (${MODE}): first=x1.00 second=x1.25 expired=ready reset=ready`);
  console.log(`artifacts=${ARTIFACT_DIR}`);
} catch (error) {
  writeReport('failed', { error: String(error) });
  throw new Error(`${String(error)}\nBrowser evidence: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
} finally {
  await browser?.close();
  if (server.pid !== undefined) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  }
  await sleep(300);
}
