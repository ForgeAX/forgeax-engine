#!/usr/bin/env node
// Player-visible proof for the game-default BouncyBall counterattack loop.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MODE = process.env.FORGEAX_COUNTERATTACK_MODE ?? 'dev';
const PORT = Number.parseInt(process.env.FORGEAX_COUNTERATTACK_PORT ?? '5237', 10);
const ARTIFACT_DIR = resolve(process.env.FORGEAX_COUNTERATTACK_DIR ?? resolve(ROOT, `.forgeax-debug/counterattack-${MODE}`));
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

const readSnapshot = async () => {
  const result = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
  if (!result?.ok) throw new Error(`snapshot unavailable: ${JSON.stringify(result)}`);
  return result.value;
};

const readHud = () => page.evaluate(() => {
  const host = document.querySelector('[data-ui-asset]');
  const shadow = host?.shadowRoot;
  const health = shadow?.querySelector('[data-ui-slot="health"]');
  const mission = shadow?.querySelector('[data-ui-slot="mission"]');
  return {
    healthText: health?.textContent ?? null,
    healthCurrent: health?.getAttribute('data-current') ?? null,
    healthState: health?.getAttribute('data-state') ?? null,
    missionText: mission?.textContent ?? null,
    missionPhase: mission?.getAttribute('data-phase') ?? null,
  };
});

const holdKey = async (key, duration) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};

const reset = async () => {
  await holdKey('r', 120);
  await page.waitForFunction(
    async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play',
    undefined,
    { timeout: 5_000, polling: 50 },
  );
  await page.waitForTimeout(250);
  return readSnapshot();
};

async function waitForSnapshot(predicate, label, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await readSnapshot();
    if (predicate(latest)) return latest;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

function expectClean(snapshot, label) {
  const c = snapshot.counterattack;
  const pickup = snapshot.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === 26);
  const repair = snapshot.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === 25);
  if (snapshot.state.phase !== 'Play' || c.playerHealth !== 3 || c.acceptedHits !== 0 || !c.hazardActive || snapshot.targetDisabling.disabledCount !== 0 || snapshot.targetHealth.damageEvents !== 0 || snapshot.projectiles.active !== 0 || snapshot.projectiles.spawned !== 0 || snapshot.healthPickup.pickups.length !== 2 || !pickup?.available || !pickup.visible || !pickup.sensor || !pickup.physicsReady || pickup.admittedCollections !== 0 || pickup.deferredDespawns !== 0 || pickup.fullHealthContactRefused || repair?.available || repair?.visible || repair?.sensor || repair?.physicsReady || repair?.admittedCollections !== 0 || repair?.deferredDespawns !== 0 || repair?.fullHealthContactRefused) {
    throw new Error(`${label} was not clean: ${JSON.stringify(snapshot)}`);
  }
}

function writeReport(status, evidence = {}) {
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({ status, mode: MODE, ...evidence, pageErrors, consoleErrors, badResponses, serverOutput }, null, 2)}\n`);
}

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${ORIGIN}/`)).ok) break;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  if (Date.now() >= deadline) throw new Error(`Preview server did not start: ${serverOutput}`);

  browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-driver-bug-workarounds', '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits', '--autoplay-policy=no-user-gesture-required'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
  page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`); });

  await page.goto(`${ORIGIN}/?game=game-default`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 30_000, polling: 100 });
  await page.waitForTimeout(300);
  const baseline = await readSnapshot();
  expectClean(baseline, 'baseline');

  await page.keyboard.down('d');
  await page.waitForTimeout(1_800);
  await page.keyboard.up('d');
  const dodge = await readSnapshot();
  const dodgePickup = dodge.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === 26);
  if (dodge.counterattack.playerHealth !== 3 || dodge.counterattack.acceptedHits !== 0 || dodge.state.phase !== 'Play' || !dodgePickup?.available || !dodgePickup.fullHealthContactRefused) {
    throw new Error(`dodge failed: ${JSON.stringify(dodge)}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, '01-dodge.png') });

  const resetAfterDodge = await reset();
  expectClean(resetAfterDodge, 'reset after dodge');

  const firstHit = await waitForSnapshot((snapshot) => snapshot.counterattack.acceptedHits === 1, 'first real contact');
  const firstHud = await readHud();
  if (firstHit.counterattack.playerHealth !== 2 || firstHit.counterattack.cooldown <= 0 || firstHud.healthCurrent !== '2' || firstHud.healthText !== '♥♥♡') {
    throw new Error(`first hit did not remove exactly one authored heart: ${JSON.stringify({ firstHit, firstHud })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, '02-contact.png') });
  await page.waitForTimeout(450);
  const cooldown = await readSnapshot();
  if (cooldown.counterattack.playerHealth !== 2 || cooldown.counterattack.acceptedHits !== 1 || cooldown.counterattack.cooldown <= 0) {
    throw new Error(`attacker cooldown did not suppress repeat contact: ${JSON.stringify(cooldown)}`);
  }

  await holdKey('d', 650);
  const recovered = await waitForSnapshot(
    (snapshot) => snapshot.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === 26)?.admittedCollections === 1,
    'real health pickup contact',
  );
  const recoveredHud = await readHud();
  const recoveredPickup = recovered.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === 26);
  if (recovered.counterattack.playerHealth !== 3 || recoveredPickup?.available || recoveredPickup?.deferredDespawns !== 1 || recoveredHud.healthCurrent !== '3' || recoveredHud.healthText !== '♥♥♥' || recovered.worldScoreText.text !== '+1 HEART' || recovered.vfxHit.triggers < 2) {
    throw new Error(`pickup did not restore exactly one authored heart with existing feedback: ${JSON.stringify({ recovered, recoveredHud })}`);
  }
  const recoveryWitness = {
    health: recovered.counterattack.playerHealth,
    admittedCollections: recoveredPickup.admittedCollections,
    deferredDespawns: recoveredPickup.deferredDespawns,
  };
  await page.waitForTimeout(500);
  const recoveredStable = await readSnapshot();
  if (JSON.stringify(recoveryWitness) !== JSON.stringify({
    health: recoveredStable.counterattack.playerHealth,
    admittedCollections: recoveredStable.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === 26)?.admittedCollections,
    deferredDespawns: recoveredStable.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === 26)?.deferredDespawns,
  })) {
    throw new Error(`despawned pickup admitted a second recovery: ${JSON.stringify(recoveredStable)}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, '03-recovered.png') });

  const resetAfterRecovery = await reset();
  expectClean(resetAfterRecovery, 'reset after recovery');
  const restoredPickupPosition = resetAfterRecovery.healthPickup.pickups.find((pickup) => pickup.authoredLocalId === 26)?.position ?? [];
  if (Math.abs(restoredPickupPosition[0] - 2.5) > 0.001 || Math.abs(restoredPickupPosition[1] - 0.55) > 0.001 || Math.abs(restoredPickupPosition[2]) > 0.001) {
    throw new Error(`reset did not restore authored pickup pose: ${JSON.stringify(resetAfterRecovery.healthPickup)}`);
  }

  const defeat = await waitForSnapshot((snapshot) => snapshot.state.phase === 'Defeat', 'Defeat transition');
  const defeatHud = await readHud();
  if (defeat.counterattack.playerHealth !== 0 || defeat.counterattack.acceptedHits !== 3 || defeat.state.defeatTransitions !== 1 || defeatHud.healthCurrent !== '0' || defeatHud.missionPhase !== 'Defeat') {
    throw new Error(`Defeat outcome failed: ${JSON.stringify({ defeat, defeatHud })}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, '04-defeat.png') });

  const frozenBefore = await readSnapshot();
  await holdKey('f', 600);
  await page.waitForTimeout(500);
  const frozenAfter = await readSnapshot();
  const frozenFields = (snapshot) => ({
    fixedTicks: snapshot.state.fixedTicks,
    health: snapshot.counterattack.playerHealth,
    hazardPosition: snapshot.counterattack.hazardPosition,
    cooldown: snapshot.counterattack.cooldown,
    acceptedHits: snapshot.counterattack.acceptedHits,
    projectiles: snapshot.projectiles,
    relay: snapshot.targetRelay,
    targetHealth: snapshot.targetHealth,
    healthPickup: snapshot.healthPickup,
  });
  if (JSON.stringify(frozenFields(frozenBefore)) !== JSON.stringify(frozenFields(frozenAfter))) {
    throw new Error(`Defeat did not freeze Play-owned mutation: ${JSON.stringify({ frozenBefore: frozenFields(frozenBefore), frozenAfter: frozenFields(frozenAfter) })}`);
  }

  const replay = await reset();
  expectClean(replay, 'Defeat replay');

  await page.mouse.click(304, 379);
  await page.keyboard.down('f');
  const neutralized = await waitForSnapshot((snapshot) => snapshot.counterattack.hazardMode === 'disabled', 'projectile neutralization', 4_000);
  await page.keyboard.up('f');
  if (neutralized.state.phase !== 'Play' || neutralized.targetDisabling.disabledCount !== 1 || neutralized.targetHealth.damageEvents <= 0 || neutralized.counterattack.hazardActive || neutralized.counterattack.playerHealth <= 0) {
    throw new Error(`real projectile did not neutralize BouncyBall through TargetHealth/Disabled: ${JSON.stringify(neutralized)}`);
  }
  const healthAfterNeutralize = neutralized.counterattack.playerHealth;
  const hitsAfterNeutralize = neutralized.counterattack.acceptedHits;
  await page.waitForTimeout(1_500);
  const neutralizedFreeze = await readSnapshot();
  if (neutralizedFreeze.counterattack.playerHealth !== healthAfterNeutralize || neutralizedFreeze.counterattack.acceptedHits !== hitsAfterNeutralize || neutralizedFreeze.counterattack.hazardMode !== 'disabled') {
    throw new Error(`disabled BouncyBall kept attacking: ${JSON.stringify(neutralizedFreeze)}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, '05-neutralized.png') });

  const finalReset = await reset();
  expectClean(finalReset, 'final held-R reset');
  const finalHud = await readHud();
  if (finalHud.healthCurrent !== '3' || finalHud.healthText !== '♥♥♥' || finalHud.healthState !== 'ready') {
    throw new Error(`authored HUD did not reset: ${JSON.stringify(finalHud)}`);
  }
  await page.screenshot({ path: resolve(ARTIFACT_DIR, '06-reset.png') });

  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) {
    throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  }
  writeReport('passed', { baseline, dodge, resetAfterDodge, firstHit, firstHud, cooldown, recovered, recoveredHud, recoveredStable, resetAfterRecovery, defeat, defeatHud, frozenBefore, frozenAfter, replay, neutralized, neutralizedFreeze, finalReset, finalHud });
  console.log(`Counterattack smoke PASS (${MODE}): refusal, damage/recovery, deferred despawn, Defeat freeze, replay, neutralization, reset`);
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
