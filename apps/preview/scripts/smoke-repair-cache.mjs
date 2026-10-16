#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MODE = process.env.FORGEAX_REPAIR_CACHE_MODE ?? 'dev';
const PORT = Number.parseInt(process.env.FORGEAX_REPAIR_CACHE_PORT ?? '5241', 10);
const ARTIFACT_DIR = resolve(process.env.FORGEAX_REPAIR_CACHE_DIR ?? resolve(ROOT, `.forgeax-debug/repair-cache-${MODE}`));
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
const cycles = [];
let browser;
let page;

const readSnapshot = async () => {
  const deadline = Date.now() + 5_000;
  let result;
  while (Date.now() < deadline) {
    result = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
    if (result?.ok) return result.value;
    await page.waitForTimeout(25);
  }
  throw new Error(`snapshot unavailable: ${JSON.stringify(result)}`);
};
const pickup = (snapshot, localId) => snapshot.healthPickup.pickups.find((candidate) => candidate.authoredLocalId === localId);
const screenshot = (name) => page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`) });
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
  await page.waitForTimeout(300);
  return readSnapshot();
};
const waitForSnapshot = async (predicate, label, timeout = 12_000) => {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await readSnapshot();
    if (predicate(latest)) return latest;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
};
const drivePlayerTo = async (target, label, timeout = 12_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    const position = snapshot.counterattack.playerPosition;
    if (snapshot.state.phase !== 'Play') return snapshot;
    const dx = target[0] - position[0];
    const dz = target[1] - position[2];
    if (Math.hypot(dx, dz) <= 0.42) return snapshot;
    const keys = [];
    if (dx < -0.18) keys.push('a');
    if (dx > 0.18) keys.push('d');
    if (dz < -0.18) keys.push('w');
    if (dz > 0.18) keys.push('s');
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(90);
    for (const key of keys) await page.keyboard.up(key);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(await readSnapshot())}`);
};
const drivePlayerToRepair = async (label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  await page.keyboard.down('Shift');
  try {
    while (Date.now() < deadline) {
      const snapshot = await readSnapshot();
      const position = snapshot.counterattack.playerPosition;
      const repair = pickup(snapshot, 25);
      const target = repair?.position;
      if (!target || snapshot.state.phase !== 'Play') return snapshot;
      if (repair.admittedCollections === 1) return snapshot;
      const dx = target[0] - position[0];
      const dz = target[2] - position[2];
      const keys = [];
      if (dx < -0.18) keys.push('a');
      if (dx > 0.18) keys.push('d');
      if (dz < -0.18) keys.push('w');
      if (dz > 0.18) keys.push('s');
      for (const key of keys) await page.keyboard.down(key);
      await page.waitForTimeout(70);
      for (const key of keys) await page.keyboard.up(key);
    }
  } finally {
    await page.keyboard.up('Shift');
  }
  throw new Error(`${label} timed out: ${JSON.stringify(await readSnapshot())}`);
};

function assertClosed(snapshot, label) {
  const original = pickup(snapshot, 26);
  const repair = pickup(snapshot, 25);
  if (snapshot.state.phase !== 'Play'
    || snapshot.repairCache.targetLocalId !== 24
    || snapshot.repairCache.pickupLocalId !== 25
    || snapshot.repairCache.opened
    || snapshot.repairCache.opens !== 0
    || snapshot.healthPickup.pickups.length !== 2
    || !original?.available || !original.visible || !original.sensor || !original.physicsReady
    || repair === undefined || repair.available || repair.visible || repair.sensor || repair.physicsReady
    || original.admittedCollections !== 0 || original.deferredDespawns !== 0
    || repair.admittedCollections !== 0 || repair.deferredDespawns !== 0) {
    throw new Error(`${label} did not restore the authored closed cache: ${JSON.stringify(snapshot)}`);
  }
}

async function findNormalAimPoint(cycle) {
  const points = [
    [659, 208], [649, 208], [669, 208], [640, 176], [630, 176], [650, 176],
    [640, 166], [640, 186], [700, 230], [680, 230], [720, 230], [680, 190], [700, 190],
  ];
  for (const point of points) {
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(320);
    const snapshot = await readSnapshot();
    if (snapshot.repairCache.ordinaryHits > 0) return { point, snapshot };
  }
  throw new Error(`cycle ${cycle} could not hit NestedTarget through the canvas: ${JSON.stringify(await readSnapshot())}`);
}

async function runCycle(cycle) {
  const baseline = await reset();
  assertClosed(baseline, `cycle ${cycle} baseline`);
  await drivePlayerTo([2.5, 0], `cycle ${cycle} full-health pickup`);
  const refused = await waitForSnapshot(
    (snapshot) => pickup(snapshot, 26)?.fullHealthContactRefused === true,
    `cycle ${cycle} full-health refusal`,
  );
  if (refused.counterattack.playerHealth !== 3 || !pickup(refused, 26)?.available) {
    throw new Error(`cycle ${cycle} full-health contact consumed the original pickup: ${JSON.stringify(refused)}`);
  }

  const normal = await findNormalAimPoint(cycle);
  if (normal.snapshot.repairCache.opened || pickup(normal.snapshot, 25)?.available) {
    throw new Error(`cycle ${cycle} ordinary hit opened the cache: ${JSON.stringify(normal)}`);
  }
  await screenshot(`${cycle}-ordinary-closed`);

  const chargedBaseline = await reset();
  assertClosed(chargedBaseline, `cycle ${cycle} charged baseline`);
  await page.keyboard.down('c');
  await page.waitForTimeout(900);
  await page.mouse.click(normal.point[0], normal.point[1]);
  await page.waitForTimeout(80);
  await page.keyboard.up('c');
  const opened = await waitForSnapshot(
    (snapshot) => snapshot.repairCache.opened && pickup(snapshot, 25)?.physicsReady === true,
    `cycle ${cycle} charged cache open`,
  );
  const revealed = pickup(opened, 25);
  if (opened.repairCache.opens !== 1 || !revealed?.available || !revealed.visible || !revealed.sensor || !revealed.physicsReady || pickup(opened, 26)?.available !== true) {
    throw new Error(`cycle ${cycle} charged impact did not reveal exactly one authored pickup: ${JSON.stringify(opened)}`);
  }
  await screenshot(`${cycle}-charged-open`);

  if (!pickup(opened, 25)?.position) throw new Error(`cycle ${cycle} lost the revealed pickup: ${JSON.stringify(opened)}`);
  await drivePlayerToRepair(`cycle ${cycle} repair pickup`);
  const recovered = await waitForSnapshot(
    (snapshot) => pickup(snapshot, 25)?.admittedCollections === 1,
    `cycle ${cycle} repair collection`,
  );
  if (recovered.counterattack.acceptedHits !== 1
    || recovered.counterattack.playerHealth !== 3
    || pickup(recovered, 25)?.available
    || pickup(recovered, 25)?.deferredDespawns !== 1
    || pickup(recovered, 26)?.available !== true
    || recovered.repairCache.opens !== 1) {
    throw new Error(`cycle ${cycle} repair pickup did not follow one real damage with one-heart recovery: ${JSON.stringify(recovered)}`);
  }
  await screenshot(`${cycle}-recovered`);

  const defeated = await waitForSnapshot((snapshot) => snapshot.state.phase === 'Defeat', `cycle ${cycle} Defeat`, 30_000);
  const frozenBefore = {
    fixedTicks: defeated.state.fixedTicks,
    repairCache: { ...defeated.repairCache, position: undefined },
    healthPickup: defeated.healthPickup,
    health: defeated.counterattack.playerHealth,
  };
  await holdKey('c', 800);
  await page.waitForTimeout(500);
  const frozen = await readSnapshot();
  const frozenAfter = {
    fixedTicks: frozen.state.fixedTicks,
    repairCache: { ...frozen.repairCache, position: undefined },
    healthPickup: frozen.healthPickup,
    health: frozen.counterattack.playerHealth,
  };
  if (JSON.stringify(frozenAfter) !== JSON.stringify(frozenBefore)) {
    throw new Error(`cycle ${cycle} terminal state mutated the cache: ${JSON.stringify({ frozenBefore, frozenAfter })}`);
  }
  const terminalDrift = Math.hypot(...frozen.repairCache.position.map((value, index) => value - defeated.repairCache.position[index]));
  if (terminalDrift > 0.0001) throw new Error(`cycle ${cycle} terminal target pose drifted: ${terminalDrift}`);
  await screenshot(`${cycle}-defeat-frozen`);

  const restored = await reset();
  assertClosed(restored, `cycle ${cycle} replay`);
  cycles.push({ cycle, normalAim: normal.point, refused, opened, recovered, defeated, frozen, restored });
}

function writeReport(status, extra = {}) {
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({ status, mode: MODE, cycles, ...extra, pageErrors, consoleErrors, badResponses, serverOutput }, null, 2)}\n`);
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
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 60_000, polling: 100 });
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 60_000, polling: 100 });
  await page.waitForTimeout(500);

  await runCycle(1);
  await runCycle(2);
  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) {
    throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  }
  writeReport('passed');
  console.log(`Repair cache smoke PASS (${MODE}): 2x ordinary refusal, charged reveal, BouncyBall damage, one-heart recovery, Defeat freeze, exact reset`);
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
