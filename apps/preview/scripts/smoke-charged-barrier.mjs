#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { visibleTargetCandidates } from './smoke-visible-target.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MODE = process.env.FORGEAX_CHARGED_BARRIER_MODE ?? 'dev';
const PORT = Number.parseInt(process.env.FORGEAX_CHARGED_BARRIER_PORT ?? '5243', 10);
const CYCLE_COUNT = Number.parseInt(process.env.FORGEAX_CHARGED_BARRIER_CYCLES ?? '2', 10);
const ARTIFACT_DIR = resolve(process.env.FORGEAX_CHARGED_BARRIER_DIR ?? resolve(ROOT, `.forgeax-debug/charged-barrier-${MODE}`));
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
const EMITTER_WORLD_POSITION = [-4.2, 0.7, -1.5];
const RELAY_TARGET_POSITIONS = {
  BlueBall: [4.5, 0.8, 1.5],
  RedBox: [3, 0.5, -2],
  YellowPillar: [2, 0.75, 3.5],
};

const hudHost = () => page.locator('[data-ui-asset]').filter({ has: page.locator('[data-ui-slot="mission"]') }).first();
const readScore = async () => Number.parseInt(
  (await hudHost().locator('[data-ui-slot="score"]').textContent())?.replace(/\D/g, '') ?? '0',
  10,
);
const readSnapshot = async () => {
  const result = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
  if (!result?.ok) {
    const context = await page.evaluate(() => ({
      readyState: document.readyState,
      url: location.href,
      hasInspection: globalThis.__forgeaxPreviewInspection !== undefined,
      reads: globalThis.__forgeaxPreviewInspection?.list?.().reads?.map(({ id }) => id) ?? [],
    }));
    throw new Error(`snapshot unavailable after read: ${JSON.stringify({ result, context })}`);
  }
  return result.value;
};
const readRenderEvidence = () => page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot());
const projectWorld = async (position) => {
  const evidence = await readRenderEvidence();
  const camera = evidence?.cameraPosition;
  const fov = evidence?.cameraPerspectiveFov;
  if (!Array.isArray(camera) || camera.length !== 3 || typeof fov !== 'number' || !(fov > 0)) return undefined;
  const dx = position[0] - camera[0];
  const dy = position[1] - camera[1];
  const dz = position[2] - camera[2];
  const pitch = -Math.atan2(13, 9);
  const sinPitch = Math.sin(pitch);
  const cosPitch = Math.cos(pitch);
  const cameraY = cosPitch * dy + sinPitch * dz;
  const depth = sinPitch * dy - cosPitch * dz;
  if (!(depth > 0)) return undefined;
  const focal = 540 / (2 * Math.tan(fov / 2));
  return [480 + dx * focal / depth, 270 - cameraY * focal / depth];
};
const projectEmitter = () => projectWorld(EMITTER_WORLD_POSITION);
const holdKey = async (key, duration) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};
const waitForSnapshot = async (predicate, label, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await readSnapshot();
    if (predicate(latest)) return latest;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
};
const reset = async () => {
  await holdKey('r', 120);
  await page.waitForFunction(
    async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play',
    undefined,
    { timeout: 5_000, polling: 50 },
  );
  await page.waitForTimeout(300);
  const snapshot = await readSnapshot();
  const characterController = await page.evaluate(
    () => globalThis.__forgeaxGameDefaultRenderEvidence?.characterController?.(),
  );
  return { ...snapshot, characterController };
};
const screenshot = (name) => page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`) });

function assertDormant(snapshot, label) {
  const barrier = snapshot.barrierRoute;
  if (snapshot.state.phase !== 'Play'
    || snapshot.targetRelay.status !== 'locked'
    || barrier.emitterLocalId !== 33 || barrier.barrierLocalId !== 34
    || barrier.active || barrier.activeVisual || barrier.damagingContact || barrier.physicsReady
    || barrier.opens !== 0 || barrier.ordinaryHits !== 0 || barrier.alreadyOpenHits !== 0
    || barrier.acceptedDamageHits !== 0 || barrier.damageCooldown !== 0) {
    throw new Error(`${label} did not restore the authored dormant route: ${JSON.stringify(snapshot)}`);
  }
}

function assertActive(snapshot, label) {
  const barrier = snapshot.barrierRoute;
  if (snapshot.state.phase !== 'Play'
    || barrier.emitterLocalId !== 33 || barrier.barrierLocalId !== 34
    || !barrier.active || !barrier.activeVisual || !barrier.damagingContact || !barrier.physicsReady
    || barrier.opens !== 0 || barrier.ordinaryHits !== 0 || barrier.alreadyOpenHits !== 0
    || barrier.acceptedDamageHits !== 0 || barrier.damageCooldown !== 0) {
    throw new Error(`${label} did not restore the authored active route: ${JSON.stringify(snapshot)}`);
  }
}

async function unlockBarrier(label) {
  const fireAt = async (point) => {
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(260);
  };
  const authoredAimPoints = [
    [304, 379],
    [659, 208], [649, 208], [669, 208],
    [640, 176], [630, 176], [650, 176], [640, 166], [640, 186],
  ];
  for (const point of authoredAimPoints) {
    if (await readScore() >= 50) break;
    await fireAt(point);
  }
  if (await readScore() < 50) throw new Error(`${label} real score unlock failed: ${JSON.stringify(await readSnapshot())}`);
  await hudHost().locator('[data-ui-action="target-profile"]').evaluate(
    (button) => (button instanceof HTMLButtonElement ? button.click() : undefined),
  );
  await page.waitForTimeout(350);

  const precisionAimPoints = [
    [566, 214], [550, 204], [566, 204], [582, 204], [550, 214],
    [582, 214], [550, 224], [566, 224], [582, 224],
  ];
  for (const point of precisionAimPoints) {
    await fireAt(point);
    if ((await readSnapshot()).targetRelay.status === 'active') break;
  }
  const hitVisibleRelayTarget = async (colors, acceptedBefore, targetName, options = {}) => {
    const before = await readSnapshot();
    const targetPosition = RELAY_TARGET_POSITIONS[targetName];
    const offsets = [[0, 0], [-12, -12], [12, -12], [-12, 12], [12, 12]];
    const attempted = [];
    const retryDeadline = Date.now() + 45_000;
    let noCandidatePasses = 0;
    let lastSnapshot = before;
    const witnessHit = (point, snapshot) => {
      if (snapshot.targetRelay.acceptedHits <= acceptedBefore) {
        if (snapshot.targetRelay.activeTargetName !== targetName) {
          throw new Error(`${label} relay target changed without an accepted ${targetName} hit: ${JSON.stringify({ point, snapshot })}`);
        }
        return undefined;
      }
      if (snapshot.targetRelay.activeTargetName === targetName) {
        throw new Error(`${label} relay accepted ${targetName} without advancing: ${JSON.stringify({ point, snapshot })}`);
      }
      return { point, snapshot };
    };
    for (let pass = 0; pass < 18 && Date.now() < retryDeadline; pass++) {
      const current = await readSnapshot();
      lastSnapshot = current;
      if (current.state.phase !== 'Play') {
        throw new Error(`${label} relay ${targetName} entered ${current.state.phase} before accepted hit: ${JSON.stringify({ current, pass, attempted })}`);
      }
      if (current.targetRelay.activeTargetName !== targetName) {
        throw new Error(`${label} relay target changed before ${targetName}: ${JSON.stringify({ current, pass, attempted })}`);
      }
      // The camera follows the player and the dynamic BlueBall can move after
      // a reset. Re-project the authored target for every shot rather than
      // carrying one screen coordinate through the whole firing sweep.
      for (const [offsetX, offsetY] of offsets) {
        const projected = targetPosition === undefined ? undefined : await projectWorld(targetPosition);
        if (projected === undefined) break;
        const point = [projected[0] + offsetX, projected[1] + offsetY];
        await fireAt(point);
        const snapshot = await readSnapshot();
        lastSnapshot = snapshot;
        const hit = witnessHit(point, snapshot);
        if (hit !== undefined) return hit;
      }
      const projected = targetPosition === undefined ? undefined : await projectWorld(targetPosition);
      const screenshot = await page.screenshot();
      const candidates = colors
        .flatMap((color) => visibleTargetCandidates(screenshot, color))
        .filter(({ y }) => y >= (options.minY ?? Number.NEGATIVE_INFINITY) && y <= (options.maxY ?? Number.POSITIVE_INFINITY))
        // Keep only a short history. A moving target can legitimately return
        // near an earlier pixel, and permanent suppression turns a bounded
        // aiming retry into an unbounded no-candidate stall.
        .filter(({ x, y }) => attempted.slice(-6).every((previous) => Math.hypot(previous.x - x, previous.y - y) > 18))
        .sort((left, right) => {
          if (options.preferRectangular === true) {
            const shape = (candidate) => Math.min(candidate.width, candidate.height) >= 12
              && Math.max(candidate.width, candidate.height) >= 20
              ? Math.max(candidate.width / candidate.height, candidate.height / candidate.width) : 0;
            if (shape(left) !== shape(right)) return shape(right) - shape(left);
          }
          if (projected !== undefined) {
            return Math.hypot(left.x - projected[0], left.y - projected[1])
              - Math.hypot(right.x - projected[0], right.y - projected[1]);
          }
          const leftScore = left.pixels / (1 + Math.hypot(left.x - 480, left.y - 270) * 0.02);
          const rightScore = right.pixels / (1 + Math.hypot(right.x - 480, right.y - 270) * 0.02);
          return rightScore - leftScore;
        });
      const candidate = candidates[0];
      if (candidate === undefined) {
        noCandidatePasses += 1;
        if (noCandidatePasses >= 6) {
          throw new Error(`${label} ${targetName} relay produced no live aim candidate: ${JSON.stringify({ pass, noCandidatePasses, attempted: attempted.slice(-6), snapshot: lastSnapshot, projected })}`);
        }
        await page.waitForTimeout(100);
        continue;
      }
      noCandidatePasses = 0;
      attempted.push(candidate);
      if (attempted.length > 12) attempted.shift();
      console.log(`[charged-barrier] ${label} relay ${targetName} reacquire ${pass + 1}: ${candidate.x},${candidate.y} (${candidate.width}x${candidate.height}, ${candidate.pixels}px)`);
      for (const [offsetX, offsetY] of offsets) {
        const point = [candidate.x + offsetX, candidate.y + offsetY];
        await fireAt(point);
        const snapshot = await readSnapshot();
        lastSnapshot = snapshot;
        const hit = witnessHit(point, snapshot);
        if (hit !== undefined) return hit;
      }
    }
    const after = await readSnapshot();
    throw new Error(`${label} visible ${targetName} relay hit failed within bounded retry: ${JSON.stringify({ before, after, lastSnapshot, attempts: attempted.slice(-12), noCandidatePasses, retryMs: 45_000 })}`);
  };
  await hitVisibleRelayTarget(['blue'], 0, 'BlueBall', { minY: 160, maxY: 420 });
  await drivePlayerTo([3, 0], `${label} RedBox firing lane`, 12_000);
  await screenshot(`${label.replaceAll(' ', '-')}-red-lane`);
  await hitVisibleRelayTarget(['red', 'yellow'], 1, 'RedBox', { preferRectangular: true });
  await drivePlayerTo([5, 0], `${label} YellowPillar approach`);
  await drivePlayerTo([5, 3.5], `${label} YellowPillar firing lane`);
  await screenshot(`${label.replaceAll(' ', '-')}-yellow-lane`);
  const relayBeforeYellow = await readSnapshot();
  await hitVisibleRelayTarget(['yellow', 'red'], relayBeforeYellow.targetRelay.acceptedHits, 'YellowPillar', { preferRectangular: true });
  const yellowHit = await readSnapshot();
  if (yellowHit.targetRelay.acceptedHits !== relayBeforeYellow.targetRelay.acceptedHits + 1) {
    throw new Error(`${label} visible YellowPillar hit failed: ${JSON.stringify({ before: relayBeforeYellow, after: yellowHit })}`);
  }
  await drivePlayerTo([5, 0], `${label} core-safe return`);
  await drivePlayerTo([0, 0], `${label} emitter aim baseline`);
  return waitForSnapshot(
    (snapshot) => snapshot.targetRelay.status === 'complete' && snapshot.barrierRoute.physicsReady === true,
    `${label} relay-complete barrier activation`,
  );
}

async function prepareActive(label) {
  const dormant = await reset();
  assertDormant(dormant, `${label} dormant baseline`);
  await page.mouse.click(304, 379);
  await page.keyboard.down('f');
  try {
    await waitForSnapshot(
      (snapshot) => snapshot.counterattack.hazardMode === 'disabled',
      `${label} real BouncyBall neutralization`,
      5_000,
    );
  } finally {
    await page.keyboard.up('f');
  }
  const active = await unlockBarrier(label);
  assertActive(active, `${label} active route`);
  return { dormant, active };
}

async function findEmitterAim(cycle) {
  const baseline = (await readSnapshot()).barrierRoute.ordinaryHits;
  const offsets = [
    [0, 0], [-16, -16], [0, -16], [16, -16], [-16, 0], [16, 0],
    [-16, 16], [0, 16], [16, 16],
  ];
  for (const [offsetX, offsetY] of offsets) {
    const projected = await projectEmitter();
    if (projected === undefined) break;
    const point = [projected[0] + offsetX, projected[1] + offsetY];
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(260);
    const snapshot = await readSnapshot();
    if (snapshot.barrierRoute.ordinaryHits > baseline) return { point, snapshot };
  }
  const attempted = [];
  for (let pass = 0; pass < 18; pass++) {
    const projected = await projectEmitter();
    const screenshot = await page.screenshot();
    const candidates = ['blue', 'green']
      .flatMap((color) => visibleTargetCandidates(screenshot, color))
      .filter(({ y }) => y >= 190 && y <= 460)
      .filter(({ x, y }) => attempted.every((previous) => Math.hypot(previous.x - x, previous.y - y) > 18))
      .sort((left, right) => {
        if (projected !== undefined) {
          return Math.hypot(left.x - projected[0], left.y - projected[1])
            - Math.hypot(right.x - projected[0], right.y - projected[1]);
        }
        return right.pixels - left.pixels;
      });
    const candidate = candidates[0];
    if (candidate === undefined) {
      await page.waitForTimeout(100);
      continue;
    }
    attempted.push(candidate);
    for (const [offsetX, offsetY] of offsets) {
      const point = [candidate.x + offsetX, candidate.y + offsetY];
      console.log(`[charged-barrier] cycle ${cycle} emitter attempt ${pass + 1}: ${point[0]},${point[1]} (${candidate.width}x${candidate.height}, ${candidate.pixels}px)`);
      await page.mouse.click(point[0], point[1]);
      await page.waitForTimeout(260);
      const snapshot = await readSnapshot();
      if (snapshot.barrierRoute.ordinaryHits > baseline) return { point, snapshot };
    }
  }
  throw new Error(`cycle ${cycle} could not hit the authored emitter: ${JSON.stringify(await readSnapshot())}`);
}

async function drivePlayerTo(target, label, timeout = 15_000, tolerance = 0.42) {
  for (const key of ['w', 'a', 's', 'd']) await page.keyboard.up(key);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  let bestDistance = Number.POSITIVE_INFINITY;
  let stalledPulses = 0;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    const position = snapshot.counterattack.playerPosition;
    if (snapshot.barrierRoute.acceptedDamageHits > 0 || snapshot.state.phase !== 'Play') return snapshot;
    const dx = target[0] - position[0];
    const dz = target[1] - position[2];
    const distance = Math.hypot(dx, dz);
    if (distance <= tolerance) return snapshot;
    if (distance + 0.025 < bestDistance) {
      bestDistance = distance;
      stalledPulses = 0;
    } else {
      stalledPulses += 1;
    }
    const keys = [];
    const deadband = stalledPulses > 0 ? 0.04 : 0.16;
    if (Math.abs(dx) >= Math.abs(dz)) {
      if (dx < -deadband) keys.push('a');
      if (dx > deadband) keys.push('d');
      if (stalledPulses === 0 && Math.abs(dz) > deadband) keys.push(dz < 0 ? 'w' : 's');
    } else {
      if (dz < -deadband) keys.push('w');
      if (dz > deadband) keys.push('s');
      if (stalledPulses === 0 && Math.abs(dx) > deadband) keys.push(dx < 0 ? 'a' : 'd');
    }
    if (keys.length === 0) {
      throw new Error(`${label} stalled before arrival: ${JSON.stringify({ target, position, distance, bestDistance, stalledPulses })}`);
    }
    const pulse = Math.max(18, Math.min(90, Math.round(Math.max(distance - tolerance, 0.05) / 6 * 1_000 * (stalledPulses > 0 ? 0.55 : 0.7))));
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(pulse);
    for (const key of keys) await page.keyboard.up(key);
  }
  throw new Error(`${label} timed out without bounded progress: ${JSON.stringify({ target, bestDistance, stalledPulses, snapshot: await readSnapshot() })}`);
}

async function chargedImpact(point) {
  await page.keyboard.down('c');
  await page.waitForTimeout(900);
  await page.mouse.click(point[0], point[1]);
  await page.waitForTimeout(80);
  await page.keyboard.up('c');
  await page.waitForTimeout(340);
}

async function chargedImpactUntilOpen(point, cycle) {
  const offsets = [[0, 0], [-10, -10], [10, -10], [-10, 10], [10, 10]];
  for (const [offsetX, offsetY] of offsets) {
    const projected = await projectEmitter();
    const firstPoint = projected ?? point;
    const aim = [firstPoint[0] + offsetX, firstPoint[1] + offsetY];
    await chargedImpact(aim);
    const snapshot = await readSnapshot();
    if (snapshot.barrierRoute.opens === 1) return { aim, snapshot };
  }
  throw new Error(`cycle ${cycle} charged emitter sweep failed: ${JSON.stringify(await readSnapshot())}`);
}

async function chargedImpactUntilAlreadyOpen(point, cycle, opened) {
  const baseline = opened.barrierRoute.alreadyOpenHits;
  const offsets = [
    [0, 0], [-16, -16], [0, -16], [16, -16], [-16, 0], [16, 0],
    [-16, 16], [0, 16], [16, 16],
  ];
  for (const [offsetX, offsetY] of offsets) {
    const projected = await projectEmitter();
    const firstPoint = projected ?? point;
    const aim = [firstPoint[0] + offsetX, firstPoint[1] + offsetY];
    await chargedImpact(aim);
    await page.waitForTimeout(340);
    const snapshot = await readSnapshot();
    if (snapshot.barrierRoute.alreadyOpenHits === baseline + 1) return { aim, snapshot };
  }
  const attempted = [];
  for (let pass = 0; pass < 24; pass++) {
    const screenshot = await page.screenshot();
    const candidates = ['blue', 'green']
      .flatMap((color) => visibleTargetCandidates(screenshot, color))
      .filter(({ y }) => y >= 190 && y <= 460)
      .filter(({ x, y }) => attempted.every((previous) => Math.hypot(previous.x - x, previous.y - y) > 18));
    const candidate = candidates[0];
    if (candidate === undefined) {
      await page.waitForTimeout(100);
      continue;
    }
    attempted.push(candidate);
    for (const [offsetX, offsetY] of offsets) {
      const aim = [candidate.x + offsetX, candidate.y + offsetY];
      console.log(`[charged-barrier] cycle ${cycle} duplicate attempt ${pass + 1}: ${aim[0]},${aim[1]} (${candidate.width}x${candidate.height}, ${candidate.pixels}px)`);
      await chargedImpact(aim);
      await page.waitForTimeout(340);
      const snapshot = await readSnapshot();
      if (snapshot.barrierRoute.alreadyOpenHits === baseline + 1) {
        return { aim, snapshot };
      }
    }
  }
  throw new Error(`cycle ${cycle} duplicate charged emitter sweep failed: ${JSON.stringify(await readSnapshot())}`);
}

async function runCycle(cycle) {
  await prepareActive(`cycle ${cycle} ordinary`);
  const normal = await findEmitterAim(cycle);
  if (!normal.snapshot.barrierRoute.active || normal.snapshot.barrierRoute.opens !== 0) {
    throw new Error(`cycle ${cycle} ordinary projectile opened the barrier: ${JSON.stringify(normal.snapshot)}`);
  }
  await screenshot(`${cycle}-ordinary-refused`);

  const contactBaseline = await prepareActive(`cycle ${cycle} contact`);
  const healthBeforeContact = contactBaseline.active.counterattack.playerHealth;
  await drivePlayerTo([-2.5, -1.5], `cycle ${cycle} real barrier contact`);
  const damaged = await waitForSnapshot(
    (snapshot) => snapshot.barrierRoute.acceptedDamageHits === 1,
    `cycle ${cycle} admitted barrier damage`,
  );
  if (damaged.counterattack.playerHealth !== healthBeforeContact - 1 || damaged.barrierRoute.damageCooldown <= 0) {
    throw new Error(`cycle ${cycle} barrier did not use shared one-heart damage admission: ${JSON.stringify(damaged)}`);
  }
  await page.waitForTimeout(350);
  const cooldown = await readSnapshot();
  if (cooldown.counterattack.playerHealth !== healthBeforeContact - 1 || cooldown.barrierRoute.acceptedDamageHits !== 1 || cooldown.barrierRoute.damageCooldown <= 0) {
    throw new Error(`cycle ${cycle} repeated barrier contact escaped shared cooldown: ${JSON.stringify(cooldown)}`);
  }
  await screenshot(`${cycle}-reckless-contact`);

  await prepareActive(`cycle ${cycle} charged`);
  // Reset/re-entry rebuilds the camera and physics scene. Re-acquire the
  // authored emitter with normal input instead of reusing a stale screen
  // coordinate from the previous scene instance.
  const chargedAim = await findEmitterAim(cycle);
  const openedBy = await chargedImpactUntilOpen(chargedAim.point, cycle);
  const opened = await waitForSnapshot(
    (snapshot) => snapshot.barrierRoute.opens === 1 && snapshot.barrierRoute.active === false,
    `cycle ${cycle} charged opening`,
  );
  if (opened.barrierRoute.activeVisual || opened.barrierRoute.damagingContact || opened.barrierRoute.physicsReady) {
    throw new Error(`cycle ${cycle} opening did not remove visual and contact together: ${JSON.stringify(opened)}`);
  }
  await screenshot(`${cycle}-charged-open`);

  // Opening removes the barrier projection and can shift the orbit camera by
  // a few pixels. Re-acquire the still-authored emitter with bounded fresh
  // charged points rather than trusting the pre-open coordinate.
  const duplicateBy = await chargedImpactUntilAlreadyOpen(openedBy.aim, cycle, opened);
  const duplicate = duplicateBy.snapshot;
  if (duplicate.barrierRoute.opens !== 1 || duplicate.barrierRoute.active
    || duplicate.barrierRoute.alreadyOpenHits !== 1
    || duplicate.barrierRoute.ordinaryHits !== opened.barrierRoute.ordinaryHits) {
    throw new Error(`cycle ${cycle} duplicate charged hit changed the opened route: ${JSON.stringify(duplicate)}`);
  }

  const restored = await reset();
  assertDormant(restored, `cycle ${cycle} replay`);
  cycles.push({ cycle, aim: normal.point, chargedAim: chargedAim.point, openedBy: openedBy.aim, duplicateAim: duplicateBy.aim, normal: normal.snapshot, damaged, cooldown, opened, duplicate, restored });
}

function writeReport(status, extra = {}) {
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({ status, mode: MODE, cycles, ...extra, pageErrors, consoleErrors, badResponses, serverOutput }, null, 2)}\n`);
}

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* Vite is starting. */ }
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
  await page.goto(`${ORIGIN}/?game=game-default&render-evidence`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 60_000, polling: 100 });
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 60_000, polling: 100 });
  await page.waitForTimeout(500);
  for (let cycle = 1; cycle <= CYCLE_COUNT; cycle++) await runCycle(cycle);
  const rendererHealth = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.renderer.health());
  if (rendererHealth?.reason !== 'alive') {
    throw new Error(`renderer health failed: ${JSON.stringify(rendererHealth)}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) {
    throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  }
  writeReport('passed', { rendererHealth });
  console.log(`Charged barrier smoke PASS (${MODE}): ordinary refusal, real contact/cooldown, charged open, duplicate refusal, two resets`);
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
