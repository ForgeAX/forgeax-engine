#!/usr/bin/env node
import { decodeCatalogWire } from '@forgeax/engine-pack';
// Focused game-default VFX composition proof. It exercises both authored Pack v2
// effects without depending on the broader inspection smoke's optional codec
// assertions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_VFX_CHARGE_DIR ?? resolve(ROOT, '.forgeax-debug/vfx-charge'));
const PORT = Number.parseInt(process.env.FORGEAX_VFX_CHARGE_PORT ?? '5217', 10);
const MODE = process.env.FORGEAX_VFX_CHARGE_MODE ?? 'dev';
mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteArgs = MODE === 'production'
  ? ['--filter', '@forgeax/preview', 'exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort']
  : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'];
const server = spawn(
  'pnpm',
  viteArgs,
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`);
});

const readSnapshot = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
const runAction = (id) => page.evaluate((actionId) => globalThis.__forgeaxPreviewInspection?.run(actionId), id);

let report;
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`Preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 30_000, polling: 100 });
  await page.waitForTimeout(1_000);

  let catalog;
  if (MODE === 'production') {
    const catalogWire = await page.evaluate(async () => (await fetch('/pack-index.json')).json());
    catalog = decodeCatalogWire(catalogWire).unwrap().filter((row) =>
      row.guid === 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9' || row.guid === 'e696463c-b254-5efb-95df-5a44ebe3b508');
  } else {
    catalog = await page.evaluate(async (mode) => {
      const response = await fetch(mode === 'production' ? '/pack-index.json' : '/__pack/scopes/preview/1/catalog.json');
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : payload.entries;
      return Array.isArray(rows)
        ? rows.filter((row) => row.guid === 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9' || row.guid === 'e696463c-b254-5efb-95df-5a44ebe3b508')
        : [];
    }, MODE);
  }
  if (catalog.length !== 2 || catalog.some((row) => row.kind !== 'particle-effect' || typeof row.packageUrl !== 'string')) {
    throw new Error(`VFX catalog rows failed: ${JSON.stringify(catalog)}`);
  }

  const before = await readSnapshot();
  const baseline = before?.value?.vfxHit;
  if (!before?.ok || baseline?.mode !== 'hit' || baseline?.guid !== 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9' || baseline?.emitterCount !== 2 || baseline?.emitterStatuses?.some((status) => status !== 'ready' && status !== 'gpu')) {
    throw new Error(`VFX baseline failed: ${JSON.stringify(before)}`);
  }

  const chargeAction = await runAction('game-default.trigger-vfx-charge');
  await page.waitForTimeout(400);
  const afterCharge = await readSnapshot();
  const charge = afterCharge?.value?.vfxHit;
  const chargeKinds = charge?.batchKinds ?? [];
  if (!chargeAction?.ok || !afterCharge?.ok || charge?.mode !== 'charge' || charge?.guid !== 'e696463c-b254-5efb-95df-5a44ebe3b508' || charge?.playing !== true || charge?.seed !== 1 || charge?.triggers !== 1 || charge?.emitterCount !== 2 || charge?.emitterStatuses?.some((status) => status !== 'ready' && status !== 'gpu') || !chargeKinds.includes('billboard') || !chargeKinds.includes('mesh') || charge?.bucketCount !== 2 || charge?.readiness !== 'ready' || charge?.errorCode !== null) {
    throw new Error(`VFX charge failed: ${JSON.stringify({ chargeAction, afterCharge })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'charge-active.png') });

  const hitAction = await runAction('game-default.trigger-vfx-hit');
  await page.waitForTimeout(250);
  const afterHit = await readSnapshot();
  const hit = afterHit?.value?.vfxHit;
  if (!hitAction?.ok || !afterHit?.ok || hit?.mode !== 'hit' || hit?.guid !== 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9' || hit?.seed !== 2 || hit?.triggers !== 2 || hit?.emitterStatuses?.some((status) => status !== 'ready' && status !== 'gpu') || hit?.errorCode !== null) {
    throw new Error(`VFX charge-to-hit switch failed: ${JSON.stringify({ hitAction, afterHit })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'hit-active.png') });

  const resetAction = await runAction('game-default.reset');
  await page.waitForTimeout(250);
  const afterReset = await readSnapshot();
  const reset = afterReset?.value?.vfxHit;
  if (!resetAction?.ok || !afterReset?.ok || reset?.mode !== 'hit' || reset?.guid !== 'cbc4f40d-d148-53ee-89e7-310ef3abcfe9' || reset?.playing !== false || reset?.seed !== 0 || reset?.triggers !== 0 || reset?.alive !== 0) {
    throw new Error(`VFX reset failed: ${JSON.stringify({ resetAction, afterReset })}`);
  }

  // Dogfood the same authored effect through the real player path. The red
  // primary target is stable in the default 960x540 camera, so this click is
  // the smallest deterministic aim input that exercises picking + charge +
  // deferred projectile + target feedback together.
  await page.evaluate(() => document.querySelector('canvas')?.focus());
  await page.keyboard.down('r');
  await page.waitForTimeout(80);
  await page.keyboard.up('r');
  await page.waitForTimeout(250);
  const gameplayBefore = await readSnapshot();
  await page.evaluate(() => document.querySelector('canvas')?.focus());
  await page.keyboard.down('c');
  await page.waitForTimeout(950);
  await page.waitForFunction(() => document.querySelector('[data-ui-asset]')?.shadowRoot?.querySelector('[data-ui-slot="charge-meter"]')?.getAttribute('aria-valuenow') === '100', undefined, { timeout: 10_000 });
  const chargeHud = await page.evaluate(() => document.querySelector('[data-ui-asset]')?.shadowRoot?.textContent ?? '');
  const chargeMeter = await page.evaluate(() => {
    const charge = document.querySelector('[data-ui-asset]')?.shadowRoot?.querySelector('[data-ui-slot="charge"]');
    return charge === null || charge === undefined
      ? { state: null, value: null, width: null }
      : {
        state: charge.getAttribute('data-state'),
        value: charge.querySelector('[data-ui-slot="charge-meter"]')?.getAttribute('aria-valuenow') ?? null,
        width: charge.querySelector('[data-ui-slot="charge-fill"]')?.getAttribute('style') ?? null,
      };
  });
  if (!chargeHud.includes('Charging · 100%') || chargeMeter.state !== 'charging' || chargeMeter.value !== '100' || !chargeMeter.width?.includes('width: 100%')) {
    throw new Error(`player charge HUD failed: ${JSON.stringify({ chargeHud, chargeMeter })}`);
  }
  await page.mouse.click(570, 220);
  await page.keyboard.up('c');
  await page.waitForTimeout(900);
  const gameplayAfter = await readSnapshot();
  const gameplayHealthBefore = gameplayBefore?.value?.targetHealth?.totalCurrent ?? 0;
  const gameplayHealthAfter = gameplayAfter?.value?.targetHealth?.totalCurrent ?? 0;
  const gameplayHit = gameplayAfter?.value?.vfxHit;
  if (!gameplayAfter?.ok || gameplayAfter?.value?.targetHealth?.damageEvents <= (gameplayBefore?.value?.targetHealth?.damageEvents ?? 0) || gameplayHealthAfter >= gameplayHealthBefore || gameplayHit?.mode !== 'hit' || gameplayHit?.playing !== true) {
    throw new Error(`player charge shot failed: ${JSON.stringify({ gameplayBefore, gameplayAfter, chargeHud })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'player-charge-shot.png') });
  await page.keyboard.down('r');
  await page.waitForTimeout(80);
  await page.keyboard.up('r');
  await page.waitForTimeout(350);
  const gameplayReset = await readSnapshot();
  const chargeReset = await page.evaluate(() => {
    const charge = document.querySelector('[data-ui-asset]')?.shadowRoot?.querySelector('[data-ui-slot="charge"]');
    return charge === null || charge === undefined
      ? { state: null, value: null }
      : {
        state: charge.getAttribute('data-state'),
        value: charge.querySelector('[data-ui-slot="charge-meter"]')?.getAttribute('aria-valuenow') ?? null,
      };
  });
  const resetBefore = gameplayAfter?.value?.state?.resetTransitions ?? 0;
  const resetAfter = gameplayReset?.value?.state?.resetTransitions ?? 0;
  const resetHealth = gameplayReset?.value?.targetHealth?.totalCurrent ?? 0;
  const resetMaxHealth = gameplayReset?.value?.targetHealth?.totalMax ?? 0;
  if (!gameplayReset?.ok || resetAfter <= resetBefore || resetHealth !== resetMaxHealth || chargeReset.state !== 'ready' || chargeReset.value !== '0') {
    throw new Error(`player charge reset failed: ${JSON.stringify({ gameplayReset, chargeReset })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'player-charge-reset.png') });

  report = { mode: MODE, catalog, before, chargeAction, afterCharge, hitAction, afterHit, resetAction, afterReset, gameplayBefore, gameplayAfter, gameplayReset, chargeHud, chargeMeter, chargeReset, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) throw new Error(`VFX browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  console.log(`VFX charge smoke PASS (${MODE}): catalog=${catalog.length} chargeAlive=${charge.alive} chargeBuckets=${charge.bucketCount} resetAlive=${reset.alive}`);
} finally {
  await browser.close();
  if (server.pid !== undefined) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* process already exited */ }
  }
}
