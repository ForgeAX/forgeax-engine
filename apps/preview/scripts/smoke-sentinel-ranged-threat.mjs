#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { visibleTargetCandidates } from './smoke-visible-target.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MODE = process.env.FORGEAX_SENTINEL_MODE ?? 'dev';
const PORT = Number.parseInt(process.env.FORGEAX_SENTINEL_PORT ?? '5251', 10);
const ARTIFACT_DIR = resolve(process.env.FORGEAX_SENTINEL_DIR ?? resolve(ROOT, `.forgeax-debug/sentinel-ranged-${MODE}`));
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
const evidence = {};
let browser;
let page;
const RELAY_TARGET_POSITIONS = {
  BlueBall: [4.5, 0.8, 1.5],
  RedBox: [3, 0.5, -2],
  YellowPillar: [2, 0.75, 3.5],
};

const hudHost = () => page.locator('[data-ui-asset]').filter({ has: page.locator('[data-ui-slot="mission"]') }).first();
const readSnapshot = async () => {
  const result = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
  if (!result?.ok) throw new Error(`snapshot unavailable: ${JSON.stringify(result)}`);
  return result.value;
};
const readRenderEvidence = () => page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence?.snapshot());
const projectWorld = async (position) => {
  const renderEvidence = await readRenderEvidence();
  const camera = renderEvidence?.cameraPosition;
  const fov = renderEvidence?.cameraPerspectiveFov;
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
const waitForSnapshot = async (predicate, label, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await readSnapshot();
    if (predicate(latest)) return latest;
    await page.waitForTimeout(40);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
};
const holdKey = async (key, duration = 100) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};
const capture = async (name, snapshot) => {
  await page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`) });
  evidence[name] = snapshot;
};
const reset = async () => {
  const before = await readSnapshot();
  const expectedResetTransitions = (before.state.resetTransitions ?? 0) + 1;
  await holdKey('r', 140);
  return waitForSnapshot(
    (snapshot) => snapshot.state.phase === 'Play'
      && snapshot.state.resetTransitions === expectedResetTransitions
      && snapshot.sentinel.mode === 'dormant'
      && snapshot.projectiles.active === 0
      && snapshot.targetProfile.active === 'original'
      && snapshot.targetProfile.precisionHits === 0
      && snapshot.targetProfile.precisionComplete === false
      && snapshot.targetRelay.status === 'locked'
      && snapshot.targetRelay.currentStep === 0
      && snapshot.targetRelay.acceptedHits === 0
      && snapshot.targetRelay.activeTarget === null
      && snapshot.targetRelay.activeTargetName === null
      && snapshot.extraction.status === 'locked'
      && snapshot.extraction.collected === 0
      && snapshot.rewardChoice.state === 'none'
      && snapshot.rewardChoice.selections === 0
      && snapshot.rewardChoice.shieldConsumptions === 0
      && snapshot.rewardChoice.overchargeConsumptions === 0
      && snapshot.barrierRoute.active === false
      && snapshot.barrierRoute.activeVisual === false
      && snapshot.barrierRoute.damagingContact === false
      && snapshot.barrierRoute.physicsReady === false,
    'held-R reset',
  );
};

async function drivePlayerTo(target, label, timeout = 15_000, tolerance = 0.42, { allowTerminal = false } = {}) {
  for (const key of ['w', 'a', 's', 'd']) await page.keyboard.up(key);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  let bestDistance = Number.POSITIVE_INFINITY;
  let stalledPulses = 0;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    if (snapshot.state.phase !== 'Play') {
      if (allowTerminal && (snapshot.state.phase === 'Defeat' || snapshot.state.phase === 'Victory')) return snapshot;
      throw new Error(`${label} ended before arrival: ${JSON.stringify({ target, snapshot })}`);
    }
    const position = snapshot.counterattack.playerPosition;
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
    if (dx < -deadband) keys.push('a');
    if (dx > deadband) keys.push('d');
    if (dz < -deadband) keys.push('w');
    if (dz > deadband) keys.push('s');
    if (keys.length === 0) {
      throw new Error(`${label} stalled before arrival: ${JSON.stringify({ target, position, distance, bestDistance, stalledPulses })}`);
    }
    const pulse = Math.max(18, Math.min(70, Math.round(Math.max(distance - tolerance, 0.05) / 6 * 1_000 * (stalledPulses > 0 ? 0.55 : 0.7))));
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(pulse);
    for (const key of keys) await page.keyboard.up(key);
  }
  throw new Error(`${label} timed out without bounded progress: ${JSON.stringify({ target, bestDistance, stalledPulses, snapshot: await readSnapshot() })}`);
}

async function fireAt(point) {
  await page.mouse.click(point[0], point[1]);
  await page.waitForTimeout(240);
}

async function neutralizeBouncyBall(label, point) {
  if (point === undefined) {
    const snapshot = await readSnapshot();
    const player = snapshot.counterattack.playerPosition;
    const hazard = snapshot.counterattack.hazardPosition;
    if (!Array.isArray(hazard)) throw new Error(`${label} has no BouncyBall position`);
    point = [
      Math.max(20, Math.min(940, 480 + (hazard[0] - player[0]) * 35)),
      Math.max(80, Math.min(500, 260 + (hazard[2] - player[2]) * 30)),
    ];
  }
  await page.mouse.click(point[0], point[1]);
  await page.keyboard.down('f');
  try {
    return await waitForSnapshot(
      (snapshot) => snapshot.counterattack.hazardMode === 'disabled',
      `${label} BouncyBall disable`,
      10_000,
    );
  } finally {
    await page.keyboard.up('f');
  }
}

async function unlockRoute(label) {
  await neutralizeBouncyBall(label, [304, 379]);
  const score = async () => Number.parseInt(
    (await hudHost().locator('[data-ui-slot="score"]').textContent())?.replace(/\D/g, '') ?? '0', 10,
  );
  for (const point of [
    [304, 379], [659, 208], [649, 208], [669, 208],
    [640, 176], [630, 176], [650, 176], [640, 166], [640, 186],
  ]) {
    if (await score() >= 50) break;
    await fireAt(point);
  }
  if (await score() < 50) throw new Error(`${label} score unlock failed`);
  await hudHost().locator('[data-ui-action="target-profile"]').evaluate(
    (button) => (button instanceof HTMLButtonElement ? button.click() : undefined),
  );
  await waitForSnapshot((snapshot) => snapshot.targetProfile.active === 'profile', `${label} profile`);
  const precisionOffsets = [[0, 0], [-12, -12], [12, -12], [-12, 12], [12, 12]];
  const precisionAttempted = [];
  let precisionHit;
  for (let pass = 0; pass < 12 && precisionHit === undefined; pass++) {
    const projected = await projectWorld(RELAY_TARGET_POSITIONS.RedBox);
    if (projected !== undefined) {
      for (const [offsetX, offsetY] of precisionOffsets) {
        const point = [projected[0] + offsetX, projected[1] + offsetY];
        await fireAt(point);
        const snapshot = await readSnapshot();
        if (snapshot.targetProfile.precisionHits > 0) {
          precisionHit = { point, snapshot, source: 'authored-projection' };
          break;
        }
      }
    }
    if (precisionHit !== undefined) break;
    const screenshot = await page.screenshot();
    const candidates = ['red', 'yellow']
      .flatMap((color) => visibleTargetCandidates(screenshot, color))
      .filter(({ y }) => y >= 150 && y <= 360)
      .filter(({ x, y }) => precisionAttempted.every((previous) => Math.hypot(previous.x - x, previous.y - y) > 18))
      .sort((left, right) => {
        const shape = (candidate) => Math.min(candidate.width, candidate.height) >= 12
          && Math.max(candidate.width, candidate.height) >= 20
          ? Math.max(candidate.width / candidate.height, candidate.height / candidate.width) : 0;
        if (shape(left) !== shape(right)) return shape(right) - shape(left);
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
    precisionAttempted.push(candidate);
    console.log(`[sentinel] ${label} precision reacquire ${pass + 1}: ${candidate.x},${candidate.y} (${candidate.width}x${candidate.height}, ${candidate.pixels}px)`);
    for (const [offsetX, offsetY] of precisionOffsets) {
      const point = [candidate.x + offsetX, candidate.y + offsetY];
      await fireAt(point);
      const snapshot = await readSnapshot();
      if (snapshot.targetProfile.precisionHits > 0) {
        precisionHit = { point, snapshot, source: 'visible-candidate' };
        break;
      }
    }
  }
  if (precisionHit === undefined) {
    throw new Error(`${label} precision target acquisition failed: ${JSON.stringify({ snapshot: await readSnapshot(), attempts: precisionAttempted.length })}`);
  }
  await waitForSnapshot(
    (snapshot) => snapshot.targetProfile.precisionHits === 1
      && snapshot.targetProfile.precisionComplete === true
      && snapshot.targetRelay.status === 'active'
      && snapshot.targetRelay.activeTargetName === 'BlueBall',
    `${label} precision relay activation`,
  );
  const hitVisibleRelayTarget = async (colors, acceptedBefore, targetName, options = {}) => {
    const before = await readSnapshot();
    const targetPosition = RELAY_TARGET_POSITIONS[targetName];
    const offsets = [[0, 0], [-12, -12], [12, -12], [-12, 12], [12, 12]];
    const attempted = [];
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
    for (let pass = 0; pass < 18; pass++) {
      const current = await readSnapshot();
      if (current.targetRelay.activeTargetName !== targetName) {
        throw new Error(`${label} relay target changed before ${targetName}: ${JSON.stringify(current)}`);
      }
      // The camera follows the player and the BlueBall can move after a reset.
      // Re-project the authored target for every shot; pixels are only a bounded
      // aiming hint and accepted target transition is the proof.
      for (const [offsetX, offsetY] of offsets) {
        const projected = targetPosition === undefined ? undefined : await projectWorld(targetPosition);
        if (projected === undefined) break;
        const point = [projected[0] + offsetX, projected[1] + offsetY];
        await fireAt(point);
        const snapshot = await readSnapshot();
        const hit = witnessHit(point, snapshot);
        if (hit !== undefined) return hit;
      }
      const projected = targetPosition === undefined ? undefined : await projectWorld(targetPosition);
      const screenshot = await page.screenshot();
      const candidates = colors
        .flatMap((color) => visibleTargetCandidates(screenshot, color))
        .filter(({ y }) => y >= (options.minY ?? Number.NEGATIVE_INFINITY) && y <= (options.maxY ?? Number.POSITIVE_INFINITY))
        .filter(({ x, y }) => attempted.every((previous) => Math.hypot(previous.x - x, previous.y - y) > 18))
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
        await page.waitForTimeout(100);
        continue;
      }
      attempted.push(candidate);
      console.log(`[sentinel] ${label} relay ${targetName} reacquire ${pass + 1}: ${candidate.x},${candidate.y} (${candidate.width}x${candidate.height}, ${candidate.pixels}px)`);
      for (const [offsetX, offsetY] of offsets) {
        const point = [candidate.x + offsetX, candidate.y + offsetY];
        await fireAt(point);
        const snapshot = await readSnapshot();
        const hit = witnessHit(point, snapshot);
        if (hit !== undefined) return hit;
      }
    }
    const after = await readSnapshot();
    throw new Error(`${label} visible ${targetName} relay hit failed: ${JSON.stringify({ before, after, attempts: attempted.length })}`);
  };
  await hitVisibleRelayTarget(['blue'], 0, 'BlueBall', { minY: 160, maxY: 420 });
  await drivePlayerTo([3, -0.8], `${label} RedBox firing lane`);
  await hitVisibleRelayTarget(['red', 'yellow'], 1, 'RedBox', { preferRectangular: true });
  await capture(`${label.replaceAll(' ', '-')}-relay-yellow`, await readSnapshot());
  await drivePlayerTo([2, 2.45], `${label} YellowPillar firing lane`);
  await hitVisibleRelayTarget(['yellow', 'red'], 2, 'YellowPillar', { preferRectangular: true });
  await waitForSnapshot(
    (snapshot) => snapshot.targetRelay.status === 'complete' && snapshot.barrierRoute.physicsReady,
    `${label} route activation`,
  );
  await drivePlayerTo([0, 0], `${label} barrier aim`);
  for (const point of [[365, 233], [355, 233], [375, 233], [365, 223], [365, 243]]) {
    await page.keyboard.down('c');
    await page.waitForTimeout(900);
    await page.mouse.click(point[0], point[1]);
    await page.waitForTimeout(80);
    await page.keyboard.up('c');
    await page.waitForTimeout(220);
    const snapshot = await readSnapshot();
    if (snapshot.barrierRoute.opens === 1) return snapshot;
  }
  throw new Error(`${label} charged barrier open failed`);
}

async function collectCores(label, captureWake) {
  const routes = [
    [[-2.5, -2.5]],
    [[4, 1.5]],
    [[7, 1.5], [7, 6], [-7, 6], [-7, 4], [-5, 4]],
  ];
  const collected = [];
  for (let index = 0; index < routes.length; index++) {
    for (const waypoint of routes[index]) {
      // Core Beta shares its authored position with the dynamic BlueBall. The
      // player reaches the sensor's valid contact envelope before the target's
      // body stops further travel, so keep the movement witness just outside
      // the target while the collection assertion below remains authoritative.
      const tolerance = index === 1 && waypoint[0] === 4 && waypoint[1] === 1.5 ? 0.5 : 0.42;
      await drivePlayerTo(waypoint, `${label} core ${index + 1}`, 15_000, tolerance);
    }
    const snapshot = await waitForSnapshot(
      (candidate) => candidate.extraction.collected === index + 1,
      `${label} core ${index + 1} collection`,
    );
    collected.push(snapshot);
    if (index === 0 && captureWake) {
      const telegraph = await waitForSnapshot(
        (candidate) => candidate.sentinel.mode === 'telegraph' && candidate.sentinel.ticks > 0
          && candidate.bossVfx?.phase === 'telegraph' && candidate.bossVfx.telegraphEvents > 0,
        `${label} first-core telegraph`,
      );
      await capture('VE-02-telegraph', telegraph);
      await capture('BOSS-01-telegraph', telegraph);
      const inFlight = await waitForSnapshot(
        (candidate) => candidate.projectiles.hostileActive === 1
          && candidate.bossVfx?.phase === 'flight' && candidate.bossVfx.flightEvents > 0,
        `${label} hostile projectile flight`,
      );
      await capture('VE-03-projectile', inFlight);
      await capture('BOSS-02-flight', inFlight);
      const blocked = await waitForSnapshot(
        (candidate) => candidate.sentinel.coverBlocked >= 1 && candidate.projectiles.hostileActive === 0
          && candidate.bossVfx?.contactEvents > 0 && candidate.bossVfx.activeCarriers === 0,
        `${label} cover block`,
      );
      await capture('VE-04-cover-block', blocked);
      await capture('BOSS-03-contact', blocked);
    }
    const health = (await readSnapshot()).counterattack;
    if (health.playerHealth < health.playerMaxHealth) {
      const pickup = (await readSnapshot()).healthPickup.pickups
        .find((candidate) => candidate.authoredLocalId === 26);
      if (pickup?.available !== true) {
        throw new Error(`${label} core ${index + 1} has no authored health recovery: ${JSON.stringify(await readSnapshot())}`);
      }
      await drivePlayerTo([2.5, 0], `${label} core ${index + 1} health recovery`);
      await waitForSnapshot(
        (candidate) => candidate.counterattack.playerHealth > health.playerHealth
          && candidate.healthPickup.pickups.some((item) => item.authoredLocalId === 26 && !item.available),
        `${label} core ${index + 1} health pickup`,
      );
    }
  }
  return collected;
}

async function chooseReward(kind, label) {
  await drivePlayerTo(kind === 'shield' ? [-1.5, -2.8] : [1.5, -2.8], `${label} ${kind}`);
  return waitForSnapshot(
    (snapshot) => snapshot.rewardChoice.state === `${kind}-ready`,
    `${label} ${kind} reward`,
  );
}

async function chooseShieldForProjectile(label) {
  const waitingPoint = [0, -1.2];
  // Select at the authored pedestal before taking the long return path. The
  // shield remains armed until a real Sentinel projectile arrives, so this
  // keeps the proof physical without risking a lethal traversal while the
  // reward is still unclaimed.
  // The extraction beacon is already active after the third core. Approach the
  // pedestal from just north of it so the route stays outside the beacon while
  // keeping the pressure traversal short enough to select Shield before a
  // terminal hit.
  for (const [index, waypoint] of [[-1.5, -1.4], [-1.5, -2.8]].entries()) {
    await drivePlayerTo(waypoint, `${label} early Shield approach ${index + 1}`);
  }
  await waitForSnapshot(
    (snapshot) => snapshot.rewardChoice.state === 'shield-ready',
    `${label} early Shield selection`,
  );
  await drivePlayerTo(waitingPoint, `${label} shield timing lane`);
  const waitForShieldWitness = (predicate, witnessLabel, timeout = 15_000) => waitForSnapshot(
    (snapshot) => {
      if (snapshot.state.phase !== 'Play') {
        throw new Error(`${witnessLabel} ended before Shield witness: ${JSON.stringify(snapshot)}`);
      }
      return predicate(snapshot);
    },
    witnessLabel,
    timeout,
  );
  const initial = await readSnapshot();
  if (initial.projectiles.hostileActive > 0) {
    await waitForShieldWitness(
      (snapshot) => snapshot.projectiles.hostileActive === 0,
      `${label} clear existing Sentinel shot`,
    );
  }
  const shotsBefore = (await readSnapshot()).sentinel.shotsFired;
  await waitForShieldWitness(
    (snapshot) => snapshot.sentinel.mode === 'telegraph'
      && snapshot.sentinel.shotsFired === shotsBefore
      && snapshot.sentinel.ticks >= 35,
    `${label} telegraph at shield lane`,
  );
  const inFlight = await waitForShieldWitness(
    (snapshot) => snapshot.projectiles.hostileActive === 1
      && snapshot.sentinel.shotsFired === shotsBefore + 1,
    `${label} projectile in flight`,
  );
  await waitForShieldWitness(
    (snapshot) => snapshot.projectiles.hostileActive === 1
      && snapshot.state.fixedTicks >= inFlight.state.fixedTicks + 10,
    `${label} projectile approach`,
  );
  const healthBefore = (await readSnapshot()).counterattack.playerHealth;
  const blocked = await waitForShieldWitness(
    (snapshot) => snapshot.rewardChoice.state === 'consumed'
      && snapshot.sentinel.shieldBlocks >= 1
      && snapshot.rewardChoice.shieldConsumptions === 1
      && snapshot.counterattack.lastShieldedHealth === healthBefore,
    `${label} Sentinel Shield block`,
    10_000,
  );
  return { ready: inFlight, blocked };
}

function assertBaseline(snapshot, label) {
  if (!snapshot.sentinel.available || snapshot.sentinel.unavailableReason !== null
    || snapshot.sentinel.entity === null || snapshot.sentinel.authoredLocalId !== 35
    || snapshot.sentinel.covers.length !== 2
    || snapshot.sentinel.covers[0].authoredLocalId !== 36
    || snapshot.sentinel.covers[1].authoredLocalId !== 37
    || snapshot.sentinel.covers.some((cover) => !cover.physicsReady)
    || snapshot.sentinel.mode !== 'dormant' || snapshot.sentinel.health !== 100
    || snapshot.sentinel.disabled || snapshot.sentinel.shotsFired !== 0
    || snapshot.sentinel.coverBlocked !== 0 || snapshot.sentinel.playerHits !== 0
    || snapshot.sentinel.shieldBlocks !== 0 || snapshot.sentinel.refused !== 0
    || snapshot.projectiles.active !== 0
    || snapshot.bossVfx?.phase !== 'dormant'
    || snapshot.bossVfx?.activePlayers !== 0
    || snapshot.bossVfx?.activeCarriers !== 0
    || snapshot.targetRelay.status !== 'locked'
    || snapshot.targetRelay.currentStep !== 0
    || snapshot.targetRelay.acceptedHits !== 0
    || snapshot.targetRelay.activeTarget !== null
    || snapshot.targetRelay.activeTargetName !== null
    || snapshot.barrierRoute.active
    || snapshot.barrierRoute.activeVisual
    || snapshot.barrierRoute.damagingContact
    || snapshot.barrierRoute.physicsReady
    || snapshot.targetProfile.active !== 'original'
    || snapshot.targetProfile.precisionHits !== 0
    || snapshot.targetProfile.precisionComplete !== false
    || snapshot.extraction.status !== 'locked'
    || snapshot.extraction.collected !== 0
    || snapshot.rewardChoice.state !== 'none'
    || snapshot.rewardChoice.selections !== 0
    || snapshot.rewardChoice.shieldConsumptions !== 0
    || snapshot.rewardChoice.overchargeConsumptions !== 0) {
    throw new Error(`${label} baseline failed: ${JSON.stringify(snapshot.sentinel)}`);
  }
  if (JSON.parse(JSON.stringify(snapshot)).sentinel.available !== true) {
    throw new Error(`${label} projection is not JSON round-trippable`);
  }
}

function writeReport(status, extra = {}) {
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify({
    status, mode: MODE, evidence, ...extra, pageErrors, consoleErrors, badResponses, serverOutput,
  }, null, 2)}\n`);
}

try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${ORIGIN}/`)).ok) break; } catch { /* Vite is starting. */ }
    await sleep(200);
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
  const dormant = await waitForSnapshot((snapshot) => snapshot.sentinel.available && snapshot.state.phase === 'Play', 'positive authored readiness', 60_000);
  assertBaseline(dormant, 'cold');
  await capture('VE-01-dormant', dormant);

  await unlockRoute('Shield journey');
  await collectCores('Shield journey', true);
  const shield = await chooseShieldForProjectile('Shield journey');
  const shieldReady = shield.ready;
  const shieldBlock = shield.blocked;
  await capture('VE-05-shield-block', shieldBlock);
  await drivePlayerTo([0, 6], 'Shield journey Defeat lane', 15_000, 0.42, { allowTerminal: true });
  const defeat = await waitForSnapshot(
    (snapshot) => snapshot.state.phase === 'Defeat' && snapshot.counterattack.playerHealth === 0
      && snapshot.state.defeatTransitions === dormant.state.defeatTransitions + 1
      && snapshot.projectiles.hostileActive === 0
      && snapshot.bossVfx?.phase === 'dormant' && snapshot.bossVfx.activePlayers === 0
      && snapshot.bossVfx.activeCarriers === 0,
    'Sentinel Defeat',
    30_000,
  );
  await capture('VE-07-defeat', defeat);
  const replayOne = await reset();
  assertBaseline(replayOne, 'Shield replay');

  await unlockRoute('Overcharge journey');
  await collectCores('Overcharge journey', false);
  await chooseReward('overcharge', 'Overcharge journey');
  await neutralizeBouncyBall('Overcharge journey rearmed');
  await drivePlayerTo([0, 5.8], 'Overcharge Sentinel lane');
  for (let shot = 0; shot < 4; shot++) {
    await holdKey('c', 1000);
    const snapshot = await readSnapshot();
    if (snapshot.sentinel.disabled) break;
    await page.waitForTimeout(180);
  }
  const disabled = await waitForSnapshot(
    (snapshot) => snapshot.sentinel.disabled && snapshot.sentinel.health === 0
      && snapshot.projectiles.hostileActive === 0
      && snapshot.bossVfx?.phase === 'dormant' && snapshot.bossVfx.activePlayers === 0
      && snapshot.bossVfx.activeCarriers === 0,
    'Sentinel shared target neutralization',
  );
  await capture('VE-06-disabled', disabled);
  await drivePlayerTo([0, -4.5], 'Overcharge active beacon', 15_000, 0.42, { allowTerminal: true });
  const victory = await waitForSnapshot(
    (snapshot) => snapshot.state.phase === 'Victory' && snapshot.extraction.victoryRequests === 1
      && snapshot.state.victoryTransitions === dormant.state.victoryTransitions + 1
      && snapshot.projectiles.hostileActive === 0
      && snapshot.bossVfx?.phase === 'dormant' && snapshot.bossVfx.activePlayers === 0
      && snapshot.bossVfx.activeCarriers === 0,
    'typed Victory',
  );
  await capture('VE-07-victory', victory);
  const replayTwo = await reset();
  assertBaseline(replayTwo, 'Overcharge replay');
  await capture('VE-07-reset', replayTwo);

  const rendererHealth = await page.evaluate(() => globalThis.__forgeaxPreviewInspection?.renderer.health());
  if (rendererHealth?.reason !== 'alive' || pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) {
    throw new Error(`browser diagnostics failed: ${JSON.stringify({ rendererHealth, pageErrors, consoleErrors, badResponses })}`);
  }
  writeReport('passed', { dormant, shieldReady, shieldBlock, defeat, replayOne, disabled, victory, replayTwo, rendererHealth });
  console.log(`Sentinel ranged threat smoke PASS (${MODE}): cover, Shield, Defeat/replay, Overcharge, Disabled, Victory/replay`);
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
