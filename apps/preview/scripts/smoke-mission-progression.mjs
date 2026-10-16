#!/usr/bin/env node
// Player-visible proof for the authored three-step mission. It intentionally
// refuses inspection score actions: the unlock must come from real projectile
// hits, then the HUD action must apply the GUID target profile, a second real
// hit must open the authored three-target relay. A wrong target must not
// advance it, and one real hit per active target must unlock extraction. The
// player must then meet the authored beacon too early, collect exactly three
// uniquely authored EnergyCores through real controller/physics overlap, and
// return to the beacon to enter typed Victory. The existing FBX companion must
// visibly mark the RedBox interval. Victory must
// freeze Play-owned mutation while preserving the final score; the same Reset
// transaction must restore prepared WebM/TTF/atlas state and support a second
// complete player cycle and replay.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { aimAtVisibleTarget, visibleTargetCandidates } from './smoke-visible-target.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_MISSION_PROGRESS_DIR ?? resolve(ROOT, '.forgeax-debug/mission-progression'));
const PORT = Number.parseInt(process.env.FORGEAX_MISSION_PROGRESS_PORT ?? '5224', 10);
const MODE = process.env.FORGEAX_MISSION_PROGRESS_MODE ?? 'dev';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EMITTER_WORLD_POSITION = [-4.2, 0.7, -1.5];
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

const hudHost = () => page.locator('[data-ui-asset]').filter({ has: page.locator('[data-ui-slot="mission"]') }).first();
const openAssetLab = async () => {
  const details = hudHost().locator('details.asset-lab');
  if ((await details.getAttribute('open')) === null) await details.locator('summary').click();
};
const readHud = () => hudHost().evaluate((host) => {
  const shadow = host.shadowRoot;
  const text = (selector) => shadow?.querySelector(selector)?.textContent ?? null;
  const profile = shadow?.querySelector('[data-ui-action="target-profile"]');
  return {
    score: text('[data-ui-slot="score"]'),
    mission: text('[data-ui-slot="mission"]'),
    missionComplete: shadow?.querySelector('[data-ui-slot="mission"]')?.getAttribute('data-complete') ?? null,
    missionPhase: shadow?.querySelector('[data-ui-slot="mission"]')?.getAttribute('data-phase') ?? null,
    assetStatus: text('[data-ui-slot="asset-lab-status"]'),
    target: text('[data-ui-slot="target-status"]'),
    charge: text('[data-ui-slot="charge-label"]'),
    chargeState: shadow?.querySelector('[data-ui-slot="charge"]')?.getAttribute('data-state') ?? null,
    combo: text('[data-ui-slot="combo"]'),
    profileButton: profile?.outerHTML ?? null,
    profileDisabled: profile?.hasAttribute('disabled') ?? null,
    fbxButtonDisabled: shadow?.querySelector('[data-ui-action="fbx-companion"]')?.hasAttribute('disabled') ?? null,
    assetButtonsDisabled: [...shadow?.querySelectorAll('.asset-control') ?? []].every((button) => button.hasAttribute('disabled')),
  };
});
const readSnapshot = () => page.evaluate(() => globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'));
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
const holdKey = async (key, duration = 90) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(duration);
  await page.keyboard.up(key);
};
const screenshot = (name) => page.screenshot({ path: resolve(ARTIFACT_DIR, `${name}.png`) });
const originalPickup = (snapshot) => snapshot.healthPickup?.pickups?.find((pickup) => pickup.authoredLocalId === 26);
const neutralizeBouncyBall = async (label) => {
  const deadline = Date.now() + 8_000;
  const aimSamples = [];
  let attempts = 0;
  let observed;
  let firstLiveAim;
  // The authored BouncyBall is a moving kinematic target. A single pointer
  // pick establishes the player shot direction; continuously redirecting the
  // pointer while F is held changes the shot ray between projectile spawns
  // and misses the target. Pick once from the first live red candidate, with
  // the authored opening point as the deterministic fallback, then keep the
  // real F input held while the target is disabled.
  await page.waitForTimeout(120);
  observed = await readSnapshot();
  const initialSnapshot = observed?.value;
  if (!observed?.ok || initialSnapshot?.state?.phase !== 'Play') {
    throw new Error(`${label} ended before initial BouncyBall aim: ${JSON.stringify({ snapshot: initialSnapshot, attempts, firstLiveAim, aimSamples })}`);
  }
  const initialHazard = initialSnapshot.counterattack?.hazardPosition;
  const projected = Array.isArray(initialHazard)
    ? await projectWorld([initialHazard[0], 0.55, initialHazard[2]])
    : undefined;
  firstLiveAim = {
    hazard: Array.isArray(initialHazard) ? [...initialHazard] : initialHazard,
    projected,
    player: initialSnapshot.counterattack?.playerPosition,
  };
  const redCandidates = visibleTargetCandidates(await page.screenshot(), 'red')
    .filter(({ x, y, width, height }) => (
      x >= 220 && x <= 720 && y >= 235 && y <= 450
      && width >= 16 && height >= 16
      && Math.abs(width - height) <= Math.max(8, Math.round((width + height) * 0.28))
    ));
  const visualCandidate = redCandidates
    .sort((left, right) => {
      const score = (candidate) => {
        const shape = Math.abs(candidate.width - candidate.height) / Math.max(candidate.width + candidate.height, 1);
        const projectedDistance = projected === undefined
          ? 0
          : Math.hypot(candidate.x - projected[0], candidate.y - projected[1]);
        return shape * 180 + projectedDistance * 0.22;
      };
      return score(left) - score(right);
    })[0];
  const point = visualCandidate === undefined
    ? [304, 379]
    : [visualCandidate.x, visualCandidate.y];
  attempts = 1;
  aimSamples.push({
    fixedTicks: initialSnapshot.state.fixedTicks,
    hazard: Array.isArray(initialHazard) ? [...initialHazard] : initialHazard,
    point,
    visualCandidate,
    projected,
    projectileActive: initialSnapshot.projectiles?.active,
    playerActive: initialSnapshot.projectiles?.playerActive,
    hostileActive: initialSnapshot.projectiles?.hostileActive,
  });
  await page.mouse.click(point[0], point[1]);
  await page.keyboard.down('f');
  try {
    while (Date.now() < deadline) {
      observed = await readSnapshot();
      if (observed?.value?.counterattack?.hazardMode === 'disabled') break;
      const snapshot = observed?.value;
      if (!observed?.ok || snapshot?.state?.phase !== 'Play') {
        throw new Error(`${label} ended before BouncyBall witness: ${JSON.stringify({ snapshot, attempts, firstLiveAim, aimSamples })}`);
      }
      await page.waitForTimeout(60);
    }
  } finally {
    await page.keyboard.up('f');
  }
  if (observed?.value?.counterattack?.hazardMode !== 'disabled') {
    throw new Error(`${label} BouncyBall disable timed out: ${JSON.stringify({ snapshot: observed, attempts, aimSamples })}`);
  }
  await page.waitForTimeout(100);
  const witness = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!witness.snapshot?.ok
    || witness.snapshot.value.state.phase !== 'Play'
    || witness.snapshot.value.counterattack.hazardMode !== 'disabled'
    || witness.snapshot.value.counterattack.hazardActive) {
    throw new Error(`${label} did not disable BouncyBall through normal fire: ${JSON.stringify(witness)}`);
  }
  return witness;
};

const assertPressure = (counterattack, tier, label) => {
  if (counterattack?.pressureTier !== tier
    || !(counterattack.patrolSpeed > 0)
    || !(counterattack.chaseSpeed > 0)
    || !(counterattack.pursuitRadius > 0)) {
    throw new Error(`${label} did not project the derived pressure contract: ${JSON.stringify(counterattack)}`);
  }
};

const probeActiveMotion = async (beforeSnapshot, label) => {
  const initial = beforeSnapshot.counterattack;
  if (!initial.hazardActive || initial.hazardMode !== 'chase' || !Array.isArray(initial.hazardPosition)) {
    throw new Error(`${label} did not expose a live chasing BouncyBall: ${JSON.stringify(initial)}`);
  }
  let startSnapshot;
  const settleDeadline = Date.now() + 10_000;
  do {
    await page.waitForTimeout(50);
    startSnapshot = await readSnapshot();
  } while ((startSnapshot?.value?.state?.simulationSeconds ?? beforeSnapshot.state.simulationSeconds)
    <= beforeSnapshot.state.simulationSeconds && Date.now() < settleDeadline);
  if (!startSnapshot?.ok
    || startSnapshot.value.state.simulationSeconds <= beforeSnapshot.state.simulationSeconds) {
    throw new Error(`${label} simulation did not advance to a settled motion sample: ${JSON.stringify(startSnapshot)}`);
  }
  const before = startSnapshot.value.counterattack;
  assertPressure(before, initial.pressureTier, label);
  if (!before.hazardActive || before.hazardMode !== 'chase' || !Array.isArray(before.hazardPosition)) {
    throw new Error(`${label} stopped live pursuit before the motion sample: ${JSON.stringify(before)}`);
  }
  const minimumFixedSteps = 8;
  let afterSnapshot;
  let displacement = 0;
  let elapsed = 0;
  let fixedSteps = 0;
  const deadline = Date.now() + 10_000;
  do {
    await page.waitForTimeout(50);
    afterSnapshot = await readSnapshot();
    const candidate = afterSnapshot?.value?.counterattack;
    if (!candidate?.hazardActive || candidate.hazardMode !== 'chase' || !Array.isArray(candidate.hazardPosition)) break;
    displacement = Math.hypot(
      candidate.hazardPosition[0] - before.hazardPosition[0],
      candidate.hazardPosition[2] - before.hazardPosition[2],
    );
    elapsed = afterSnapshot.value.state.simulationSeconds - startSnapshot.value.state.simulationSeconds;
    fixedSteps = afterSnapshot.value.state.fixedTicks - startSnapshot.value.state.fixedTicks;
  } while ((fixedSteps < minimumFixedSteps || elapsed <= 0 || displacement <= 0.05) && Date.now() < deadline);
  const after = afterSnapshot?.value?.counterattack;
  assertPressure(after, before.pressureTier, label);
  if (!after?.hazardActive || after.hazardMode !== 'chase' || !Array.isArray(after.hazardPosition)) {
    throw new Error(`${label} stopped live pursuit during the motion probe: ${JSON.stringify(after)}`);
  }
  const measuredFixedSeconds = fixedSteps > 0 ? elapsed / fixedSteps : 0;
  if (fixedSteps < minimumFixedSteps || displacement <= 0.05 || elapsed <= 0 || measuredFixedSeconds <= 0 || displacement / elapsed > before.chaseSpeed * 1.15) {
    throw new Error(`${label} motion did not obey the tier chase speed: ${JSON.stringify({ before, after, displacement, elapsed, fixedSteps, measuredFixedSeconds })}`);
  }
  return { before, after, displacement, elapsed, fixedSteps, measuredFixedSeconds, measuredSpeed: displacement / elapsed };
};

const drivePlayerTo = async (target, label, timeout = 15_000, tolerance = 0.42) => {
  for (const key of ['w', 'a', 's', 'd']) await page.keyboard.up(key);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  let bestDistance = Number.POSITIVE_INFINITY;
  let stalledPulses = 0;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    const position = snapshot?.value?.counterattack?.playerPosition;
    if (!Array.isArray(position)) throw new Error(`${label} has no player pose: ${JSON.stringify(snapshot)}`);
    if (snapshot.value.state.phase !== 'Play') return snapshot;
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
    const deadband = stalledPulses > 0 ? 0.04 : 0.16;
    const keys = [];
    if (dx < -deadband) keys.push('a');
    if (dx > deadband) keys.push('d');
    if (dz < -deadband) keys.push('w');
    if (dz > deadband) keys.push('s');
    if (keys.length === 0) {
      throw new Error(`${label} stalled before arrival: ${JSON.stringify({ target, position, distance, bestDistance, stalledPulses })}`);
    }
    const pulse = Math.max(
      18,
      Math.min(70, Math.round(Math.max(distance - tolerance, 0.05) / 6 * 1_000 * (stalledPulses > 0 ? 0.55 : 0.7))),
    );
    for (const key of keys) await page.keyboard.down(key);
    await page.waitForTimeout(pulse);
    for (const key of keys) await page.keyboard.up(key);
  }
  throw new Error(`${label} timed out without bounded progress: ${JSON.stringify({ target, bestDistance, stalledPulses, snapshot: await readSnapshot() })}`);
};

const waitForExtraction = async (predicate, label, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot();
    if (snapshot?.ok && predicate(snapshot.value.extraction, snapshot.value)) return snapshot;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(await readSnapshot())}`);
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

  await page.goto(`${ORIGIN}/?game=game-default&render-evidence`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.__forgeaxPreviewInspection?.list().reads.some(({ id }) => id === 'game-default.snapshot') ?? false, undefined, { timeout: 60_000, polling: 100 });
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 60_000, polling: 100 });
  await page.waitForTimeout(500);

  await holdKey('r');
  await page.waitForTimeout(350);
  const baseline = { snapshot: await readSnapshot(), hud: await readHud() };
  assertPressure(baseline.snapshot?.value?.counterattack, 0, 'cold baseline');
  const baselinePickup = baseline.snapshot?.ok ? originalPickup(baseline.snapshot.value) : undefined;
  if (!baseline.snapshot?.ok || baseline.hud.mission !== 'Mission 1/3 · Score 50 · 0/50' || baseline.hud.profileDisabled !== true || baseline.snapshot.value.targetProfile?.active !== 'original' || baselinePickup?.available !== true || baselinePickup.sensor !== true || baselinePickup.physicsReady !== true) {
    throw new Error(`mission baseline failed: ${JSON.stringify(baseline)}`);
  }
  await screenshot('mission-locked');

  // A disabled public button is the first guard. The same action is also
  // guarded in the ECS-owned action adapter for keyboard/inspection callers.
  await hudHost().locator('[data-ui-action="target-profile"]').evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
  await page.waitForTimeout(150);
  const lockedAttempt = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!lockedAttempt.snapshot?.ok || lockedAttempt.snapshot.value.targetProfile?.active !== 'original' || lockedAttempt.hud.score !== 'Score  0' || lockedAttempt.hud.missionComplete !== 'false') {
    throw new Error(`locked profile action bypassed mission: ${JSON.stringify(lockedAttempt)}`);
  }

  const neutralized = await neutralizeBouncyBall('first mission');

  // The authored scoring bodies are dynamic physics entities, so a target can
  // drift after a hit. Fire through the real canvas path at the initial
  // authored target points in quick succession; each click still goes through
  // pointer picking, projectile simulation, collision feedback, and score.
  // This keeps the smoke deterministic without mutating score or ECS state.
  const fireAt = async (x, y) => {
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
  };
  const firstHit = { snapshot: await readSnapshot(), hud: await readHud() };
  // Avoid the RedBox precision target until mission 3: it must remain at its
  // authored profile point for the following precision-hit proof.
  const authoredAimPoints = [
    [304, 379],
    [659, 208], [649, 208], [669, 208],
    [640, 176], [630, 176], [650, 176], [640, 166], [640, 186],
  ];
  for (const [x, y] of authoredAimPoints) {
    if (Number.parseInt((await readHud()).score?.replace(/\D/g, '') ?? '0', 10) >= 50) break;
    await fireAt(x, y);
  }
  const unlocked = { snapshot: await readSnapshot(), hud: await readHud() };
  const unlockedScore = Number.parseInt(unlocked.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!unlocked.snapshot?.ok || unlockedScore < 50 || unlocked.hud.mission !== 'Mission 2/3 · Press P to apply the authored target profile' || unlocked.hud.profileDisabled !== false || unlocked.snapshot.value.targetProfile?.active !== 'original') {
    throw new Error(`real hits did not unlock mission: ${JSON.stringify({ firstHit, unlocked })}`);
  }
  await screenshot('mission-unlocked');

  await hudHost().locator('[data-ui-action="target-profile"]').evaluate((button) => (button instanceof HTMLButtonElement ? button.click() : undefined));
  await page.waitForTimeout(350);
  const profileActive = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!profileActive.snapshot?.ok || profileActive.snapshot.value.targetProfile?.active !== 'profile' || profileActive.snapshot.value.targetProfile?.precisionHits !== 0 || profileActive.snapshot.value.targetProfile?.precisionComplete !== false || profileActive.snapshot.value.targetProfile?.rotationSpeed !== 0.18 || profileActive.hud.missionComplete !== 'false' || profileActive.hud.mission !== 'Mission 3/3 · Hit the rotating precision target' || !profileActive.hud.target?.startsWith('TARGET · RedBox · ') || !profileActive.hud.target?.includes('+20 · PRECISION MOTION') || !profileActive.hud.assetStatus?.includes('Target profile active')) {
    throw new Error(`profile did not open precision step: ${JSON.stringify({ unlocked, profileActive })}`);
  }
  await screenshot('mission-precision-ready');

  // The RedBox is stable at this authored viewport. This real canvas click
  // exercises pointer picking, deferred projectile simulation, target
  // feedback, and the profile-owned precision completion callback.
  // The target rotates around its authored center; sweep the small visible
  // footprint so the proof remains a real pointer shot even when the first
  // frame lands on a rotating edge.
  const precisionAimPoints = [[566, 214], [550, 204], [566, 204], [582, 204], [550, 214], [582, 214], [550, 224], [566, 224], [582, 224]];
  for (const [x, y] of precisionAimPoints) {
    await page.mouse.click(x, y);
    await page.waitForTimeout(260);
    const precisionAttempt = await readSnapshot();
    if (precisionAttempt?.value?.targetProfile?.precisionHits >= 1) break;
  }
  await page.waitForTimeout(300);
  const relayStarted = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!relayStarted.snapshot?.ok || relayStarted.snapshot.value.targetProfile?.active !== 'profile' || relayStarted.snapshot.value.targetProfile?.precisionHits !== 1 || relayStarted.snapshot.value.targetProfile?.precisionComplete !== true || relayStarted.snapshot.value.targetRelay?.status !== 'active' || relayStarted.snapshot.value.targetRelay?.currentStep !== 1 || relayStarted.snapshot.value.targetRelay?.acceptedHits !== 0 || relayStarted.hud.missionComplete !== 'false' || relayStarted.hud.mission !== 'Relay 1/3 · BlueBall · hit active target' || !relayStarted.hud.target?.startsWith('TARGET · BlueBall · ') || !relayStarted.hud.assetStatus?.includes('Target profile active')) {
    throw new Error(`precision hit did not open relay: ${JSON.stringify({ unlocked, profileActive, relayStarted })}`);
  }
  await screenshot('relay-blue-ready');

  const rejectedBefore = relayStarted.snapshot.value.targetRelay.rejectedHits;
  const wrongTargetHit = await aimAtVisibleTarget(
    page,
    ['red'],
    async () => {
      const relay = (await readSnapshot())?.value?.targetRelay;
      return relay?.rejectedHits > rejectedBefore || relay?.acceptedHits > 0;
    },
    { delay: 2_500, preferRectangular: true, minY: 300, maxY: 380 },
  );
  const wrongTarget = { snapshot: await readSnapshot(), hud: await readHud() };
  if (wrongTargetHit === undefined || !wrongTarget.snapshot?.ok || wrongTarget.snapshot.value.targetRelay?.currentStep !== 1 || wrongTarget.snapshot.value.targetRelay?.acceptedHits !== 0 || wrongTarget.snapshot.value.targetRelay?.rejectedHits <= rejectedBefore || wrongTarget.hud.mission !== 'Relay 1/3 · BlueBall · hit active target') {
    throw new Error(`wrong target advanced relay: ${JSON.stringify({ relayStarted, wrongTargetHit, wrongTarget })}`);
  }
  await screenshot('relay-wrong-target-rejected');

  const hitRelayTarget = async (points, acceptedBefore) => {
    for (let pass = 0; pass < 3; pass++) {
      for (const [x, y] of points) {
        await fireAt(x, y);
        const attempt = await readSnapshot();
        if ((attempt?.value?.targetRelay?.acceptedHits ?? acceptedBefore) > acceptedBefore) return attempt;
      }
    }
    return readSnapshot();
  };
  const hitRedRelay = async (label) => {
    await drivePlayerTo([3, 0], `${label} RedBox firing lane`, 12_000, 0.3);
    await screenshot(`${label}-red-lane`);
    const before = await readSnapshot();
    const hit = await aimAtVisibleTarget(
      page,
      ['red', 'yellow'],
      async () => (await readSnapshot())?.value?.targetRelay?.acceptedHits > 1,
      { delay: 2_500, preferRectangular: true },
    );
    const after = await readSnapshot();
    await drivePlayerTo([0, 0], `${label} aim baseline`);
    if (hit === undefined
      || before?.value?.targetRelay?.acceptedHits !== 1
      || before?.value?.targetRelay?.activeTargetName !== 'RedBox'
      || after?.value?.targetRelay?.acceptedHits !== 2) {
      throw new Error(`${label} visible RedBox hit failed: ${JSON.stringify({ before, hit, after })}`);
    }
    return { before, hit, after };
  };
  const hitYellowRelay = async (label) => {
    await drivePlayerTo([5, 0], `${label} YellowPillar approach`);
    await drivePlayerTo([5, 3.5], `${label} YellowPillar firing lane`, 12_000, 0.3);
    await screenshot(`${label}-yellow-lane`);
    const before = await readSnapshot();
    const hit = await aimAtVisibleTarget(
      page,
      ['yellow', 'red'],
      async () => (await readSnapshot())?.value?.targetRelay?.acceptedHits > 2,
      { delay: 2_500, preferRectangular: true },
    );
    const after = await readSnapshot();
    await drivePlayerTo([5, 0], `${label} core-safe return`);
    await drivePlayerTo([0, 0], `${label} aim baseline`);
    if (hit === undefined
      || before?.value?.targetRelay?.acceptedHits !== 2
      || after?.value?.targetRelay?.acceptedHits !== 3
      || after?.value?.targetRelay?.status !== 'complete') {
      throw new Error(`${label} visible YellowPillar hit failed: ${JSON.stringify({ before, hit, after })}`);
    }
    return { before, hit, after };
  };
  const completeExtraction = async (prefix, rewardKind) => {
    const unlockedExtraction = await waitForExtraction(
      (extraction, snapshot) => snapshot.state.phase === 'Play'
        && snapshot.targetRelay.status === 'complete'
        && extraction.status === 'collecting'
        && extraction.collected === 0,
      `${prefix} extraction unlock`,
    );
    assertPressure(unlockedExtraction.value.counterattack, 0, `${prefix} extraction baseline`);
    await drivePlayerTo([5, 0], `${prefix} core-safe return`);
    await drivePlayerTo([0, 0], `${prefix} barrier aim baseline`);
    let barrierOpened;
    const projectedEmitter = await projectWorld(EMITTER_WORLD_POSITION);
    const barrierAimPoints = projectedEmitter === undefined
      ? [[365, 233], [355, 233], [375, 233], [365, 223], [365, 243]]
      : [[0, 0], [-10, -10], [10, -10], [-10, 10], [10, 10]]
        .map(([offsetX, offsetY]) => [projectedEmitter[0] + offsetX, projectedEmitter[1] + offsetY]);
    for (const point of barrierAimPoints) {
      await page.keyboard.down('c');
      await page.waitForTimeout(900);
      await page.mouse.click(point[0], point[1]);
      await page.waitForTimeout(80);
      await page.keyboard.up('c');
      await page.waitForTimeout(250);
      const candidate = await readSnapshot();
      if (candidate?.value?.barrierRoute?.opens === 1) {
        barrierOpened = candidate;
        break;
      }
    }
    if (!barrierOpened?.ok
      || barrierOpened.value.barrierRoute.active
      || barrierOpened.value.barrierRoute.activeVisual
      || barrierOpened.value.barrierRoute.damagingContact
      || barrierOpened.value.barrierRoute.physicsReady) {
      throw new Error(`${prefix} charged barrier route did not open: ${JSON.stringify(barrierOpened)}`);
    }
    await screenshot(`${prefix}-barrier-open`);
    await drivePlayerTo([0, -4.5], `${prefix} early beacon`);
    const refused = await waitForExtraction(
      (extraction) => extraction.refusedContacts === 1 && extraction.collected === 0,
      `${prefix} early beacon refusal`,
    );
    await screenshot(`${prefix}-beacon-refused`);

    const authoredCoreRoutes = [
      [[-2.5, -4.5], [-2.5, -2.5]],
      [[4, 1.5]],
      [[4, 5.8], [-5, 5.8], [-5, 4]],
    ];
    const collections = [];
    const healthRecoveries = [];
    const pressureEvidence = [];
    let previousPressure = unlockedExtraction.value.counterattack;
    for (let index = 0; index < authoredCoreRoutes.length; index++) {
      for (const [waypointIndex, waypoint] of authoredCoreRoutes[index].entries()) {
        await drivePlayerTo(waypoint, `${prefix} EnergyCore ${index + 1} waypoint ${waypointIndex + 1}`);
      }
      const collected = await waitForExtraction(
        (extraction) => extraction.collected === index + 1
          && extraction.cores.filter((core) => core.available).length === authoredCoreRoutes.length - index - 1,
        `${prefix} EnergyCore ${index + 1} collection`,
      );
      const tier = index + 1;
      assertPressure(collected.value.counterattack, tier, `${prefix} EnergyCore ${tier}`);
      const pressure = collected.value.counterattack;
      if (pressure.patrolSpeed <= previousPressure.patrolSpeed
        || pressure.chaseSpeed <= previousPressure.chaseSpeed
        || pressure.pursuitRadius <= previousPressure.pursuitRadius
        || pressure.chaseSpeed > unlockedExtraction.value.counterattack.chaseSpeed * 1.5) {
        throw new Error(`${prefix} EnergyCore ${tier} did not strictly raise bounded pressure: ${JSON.stringify({ previousPressure, pressure })}`);
      }
      const collectionHud = await readHud();
      if (!collectionHud.mission?.includes(`Threat ${tier}/3`)) {
        throw new Error(`${prefix} EnergyCore ${tier} did not announce pressure through HUD feedback: ${JSON.stringify({ collectionHud, worldScoreText: collected.value.worldScoreText })}`);
      }
      pressureEvidence.push({
        tier,
        counterattack: collected.value.counterattack,
        hud: collectionHud,
        worldScoreText: collected.value.worldScoreText,
        expectedWorldScoreText: collected.value.worldScoreText?.text?.includes(`THREAT ${tier}/3`) ?? false,
      });
      previousPressure = pressure;
      collections.push(collected);
      await screenshot(`${prefix}-core-${index + 1}`);
      const healthBeforeRecovery = collected.value.counterattack.playerHealth;
      if (healthBeforeRecovery < collected.value.counterattack.playerMaxHealth) {
        // Pressure damage is real during the long authored routes. Recover only
        // through the authored HealthPickup before the next witness; never
        // patch PlayerHealth or bypass its sensor/contact path.
        const pickup = originalPickup(collected.value);
        if (!pickup?.available || pickup.sensor !== true || pickup.physicsReady !== true) {
          throw new Error(`${prefix} EnergyCore ${tier} has no authored health recovery: ${JSON.stringify(collected)}`);
        }
        await drivePlayerTo([2.5, 0], `${prefix} EnergyCore ${tier} health recovery`);
        const recovered = await waitForExtraction(
          (_extraction, snapshot) => snapshot.counterattack.playerHealth > healthBeforeRecovery
            && snapshot.healthPickup?.pickups?.some((item) => item.authoredLocalId === 26 && !item.available),
          `${prefix} EnergyCore ${tier} health pickup`,
        );
        healthRecoveries.push(recovered);
      }
    }
    const ready = collections.at(-1);
    if (!ready?.value?.extraction?.active
      || ready.value.extraction.status !== 'ready'
      || ready.value.extraction.collectedMask !== 7
      || ready.value.extraction.deferredDespawns !== 3
      || ready.value.extraction.wrongContacts < 1
      || !ready.value.extraction.beacon.activeVisual) {
      throw new Error(`${prefix} exact extraction activation failed: ${JSON.stringify(ready)}`);
    }
    await screenshot(`${prefix}-beacon-active`);
    const rewardPosition = rewardKind === 'shield' ? [-1.5, -2.8] : [1.5, -2.8];
    const rewardApproach = [];
    for (const waypoint of [[-5, 0], [0, 0], [0, -2.8], rewardPosition]) {
      rewardApproach.push(await drivePlayerTo(
        waypoint,
        `${prefix} ${rewardKind} reward waypoint ${rewardApproach.length + 1}`,
      ));
    }
    const reward = await waitForExtraction(
      (_extraction, snapshot) => snapshot.rewardChoice?.state === `${rewardKind}-ready`
        && snapshot.rewardChoice?.selections === 1,
      `${prefix} ${rewardKind} reward choice`,
    );
    if (reward.value.rewardChoice.pedestals.length !== 2
      || reward.value.rewardChoice.pedestals.some((pedestal) => !pedestal.physicsReady)) {
      throw new Error(`${prefix} authored reward sensors failed: ${JSON.stringify(reward)}`);
    }
    await screenshot(`${prefix}-${rewardKind}-ready`);
    let rewardEffect;
    if (rewardKind === 'shield') {
      const rewardFresh = await readSnapshot();
      if (!rewardFresh?.ok
        || rewardFresh.value.rewardChoice?.state !== 'shield-ready'
        || rewardFresh.value.rewardChoice.selections !== 1) {
        throw new Error(`${prefix} Shield-ready projection did not settle: ${JSON.stringify(rewardFresh)}`);
      }
      const maxTierMotion = await probeActiveMotion(rewardFresh.value, `${prefix} Shield-armed max tier`);
      const hazardBeforeShield = await readSnapshot();
      if (hazardBeforeShield?.value?.counterattack?.hazardMode !== 'disabled') {
        // Core pressure can re-arm BouncyBall after the opening F shot. Keep
        // the Shield timing lane safe by using the same real F projectile path
        // after the required max-tier motion witness has been captured.
        await neutralizeBouncyBall(`${prefix} Shield timing`);
      }
      const shieldApproach = [];
      for (const waypoint of [[-3, -1], [-3, 1], [0, 1], [0, 2]]) {
        shieldApproach.push(await drivePlayerTo(
          waypoint,
          `${prefix} Shield timing waypoint ${shieldApproach.length + 1}`,
        ));
      }
      const shieldLane = shieldApproach.at(-1);
      if (!shieldLane?.ok || shieldLane.value.state.phase !== 'Play') {
        throw new Error(`${prefix} Shield timing lane ended before block proof: ${JSON.stringify(shieldLane)}`);
      }
      let blocked;
      const shieldInitial = await readSnapshot();
      if (shieldInitial?.ok
        && shieldInitial.value.rewardChoice?.state === 'consumed'
        && shieldInitial.value.rewardChoice?.shieldConsumptions === 1
        && shieldInitial.value.sentinel.shieldBlocks >= 1
        && shieldInitial.value.counterattack.lastShieldedHealth !== null) {
        blocked = shieldInitial;
      } else {
        if (shieldInitial?.value?.projectiles?.hostileActive > 0) {
          await waitForExtraction(
            (_extraction, snapshot) => snapshot.projectiles?.hostileActive === 0,
            `${prefix} clear existing Sentinel shot`,
          );
        }
        const shotsBefore = (await readSnapshot()).value.sentinel.shotsFired;
        await waitForExtraction(
          (_extraction, snapshot) => snapshot.sentinel?.mode === 'telegraph'
            && snapshot.sentinel.shotsFired === shotsBefore
            && snapshot.sentinel.ticks >= 35,
          `${prefix} Shield telegraph`,
        );
        const inFlight = await waitForExtraction(
          (_extraction, snapshot) => snapshot.projectiles?.hostileActive === 1
            && snapshot.sentinel.shotsFired === shotsBefore + 1,
          `${prefix} Shield projectile`,
        );
        await waitForExtraction(
          (_extraction, snapshot) => snapshot.projectiles?.hostileActive === 1
            && snapshot.state.fixedTicks >= inFlight.value.state.fixedTicks + 10,
          `${prefix} Shield projectile approach`,
        );
        const healthBefore = (await readSnapshot()).value.counterattack.playerHealth;
        blocked = await waitForExtraction(
          (_extraction, snapshot) => snapshot.rewardChoice?.state === 'consumed'
            && snapshot.rewardChoice?.shieldConsumptions === 1
            && snapshot.sentinel.shieldBlocks >= 1
            && snapshot.counterattack.playerHealth === healthBefore
            && snapshot.counterattack.lastShieldedHealth === healthBefore,
          `${prefix} Sentinel Shield block`,
          15_000,
        );
      }
      const nextDamage = await waitForExtraction(
        (_extraction, snapshot) => snapshot.counterattack.playerHealth === blocked.value.counterattack.lastShieldedHealth - 1,
        `${prefix} post-Shield damage`,
        15_000,
      );
      rewardEffect = { shieldApproach, shieldLane, maxTierMotion, blocked, nextDamage };
    } else {
      await drivePlayerTo([3, -1], `${prefix} Overcharge safe exit`);
      await drivePlayerTo([3, 2], `${prefix} Overcharge safe ascent`);
      await drivePlayerTo([0, 3], `${prefix} Overcharge firing lane`);
      const firingLane = (await readSnapshot()).value;
      if (firingLane.state.phase !== 'Play') {
        throw new Error(`${prefix} Overcharge route entered the extraction beacon before firing: ${JSON.stringify(firingLane)}`);
      }
      await page.keyboard.down('a');
      await page.waitForTimeout(70);
      await page.keyboard.up('a');
      const overchargeLane = (await readSnapshot()).value;
      const spawnedBefore = overchargeLane.projectiles.spawned;
      await holdKey('c', 950);
      rewardEffect = await waitForExtraction(
        (_extraction, snapshot) => snapshot.rewardChoice?.state === 'consumed'
          && snapshot.rewardChoice?.overchargeConsumptions === 1
          && snapshot.projectiles.spawned > spawnedBefore,
        `${prefix} Overcharge charged projectile`,
      );
      rewardEffect = { overchargeLane, fired: rewardEffect };
    }
    await screenshot(`${prefix}-${rewardKind}-consumed`);
    await drivePlayerTo([0, -4.5], `${prefix} active beacon`);
    const victory = await waitForExtraction(
      (extraction, snapshot) => snapshot.state.phase === 'Victory'
        && extraction.victoryRequests === 1
        && extraction.collected === 3,
      `${prefix} extraction Victory`,
    );
    return { unlockedExtraction, barrierOpened, refused, collections, healthRecoveries, pressureEvidence, ready, rewardApproach, reward, rewardEffect, victory };
  };
  await hitRelayTarget([[627, 297], [617, 297], [637, 297], [627, 287], [627, 307]], 0);
  const redVariation = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!redVariation.snapshot?.ok || redVariation.snapshot.value.targetRelay?.status !== 'active' || redVariation.snapshot.value.targetRelay?.currentStep !== 2 || redVariation.snapshot.value.targetRelay?.acceptedHits !== 1 || redVariation.snapshot.value.targetRelay?.activeTargetName !== 'RedBox' || redVariation.snapshot.value.targetRelay?.variationActive !== true || redVariation.snapshot.value.fbxSkinnedTarget?.companionActive !== true || redVariation.snapshot.value.visibility?.effective !== 'hidden' || redVariation.hud.mission !== 'Relay 2/3 · RedBox · hit active target') {
    throw new Error(`BlueBall did not advance to visible RedBox variation: ${JSON.stringify({ wrongTarget, redVariation })}`);
  }
  await screenshot('relay-red-fbx-variation');

  const firstRedHit = await hitRedRelay('first-relay');
  const yellowReady = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!yellowReady.snapshot?.ok || yellowReady.snapshot.value.targetRelay?.status !== 'active' || yellowReady.snapshot.value.targetRelay?.currentStep !== 3 || yellowReady.snapshot.value.targetRelay?.acceptedHits !== 2 || yellowReady.snapshot.value.targetRelay?.activeTargetName !== 'YellowPillar' || yellowReady.snapshot.value.targetRelay?.variationActive !== false || yellowReady.snapshot.value.fbxSkinnedTarget?.companionActive !== false || (yellowReady.snapshot.value.fbxSkinnedTarget?.hitPulses ?? 0) < 1 || yellowReady.hud.mission !== 'Relay 3/3 · YellowPillar · hit active target') {
    throw new Error(`RedBox did not advance to YellowPillar through the FBX hit path: ${JSON.stringify({ redVariation, yellowReady })}`);
  }
  await screenshot('relay-yellow-ready');

  // Carry the existing media/font/atlas variations into Victory so the one
  // Reset transaction must restore them together with the gameplay state.
  await openAssetLab();
  await hudHost().locator('[data-ui-action="video-texture"]').click();
  await hudHost().locator('[data-ui-action="font-source"]').click();
  await hudHost().locator('[data-ui-action="sprite-atlas"]').click();
  await page.waitForTimeout(250);
  const preparedVariations = { snapshot: await readSnapshot(), hud: await readHud() };
  if (!preparedVariations.snapshot?.ok || preparedVariations.snapshot.value.videoTexture?.active !== 'video' || preparedVariations.snapshot.value.worldScoreText?.fontSource !== 'ttf-plugin' || preparedVariations.snapshot.value.spriteAtlas?.active !== true) {
    throw new Error(`guided variations were not active before Victory: ${JSON.stringify(preparedVariations)}`);
  }

  const firstYellowHit = await hitYellowRelay('first-relay');
  const extractionCycle = await completeExtraction('first', 'shield');
  const completed = { snapshot: await readSnapshot(), render: await readRenderEvidence(), hud: await readHud() };
  const completedScore = Number.parseInt(completed.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!completed.snapshot?.ok || completed.snapshot.value.state?.phase !== 'Victory' || completed.snapshot.value.state?.victoryTransitions !== 1 || completed.snapshot.value.targetRelay?.status !== 'complete' || completed.snapshot.value.targetRelay?.acceptedHits !== 3 || completed.snapshot.value.targetRelay?.cleared !== 3 || completed.snapshot.value.targetRelay?.rejectedHits < 1 || completed.snapshot.value.targetRelay?.activeTarget !== null || completed.snapshot.value.extraction?.collected !== 3 || completed.snapshot.value.extraction?.collectedMask !== 7 || completed.snapshot.value.extraction?.active !== true || completed.snapshot.value.extraction?.victoryRequests !== 1 || completed.hud.missionComplete !== 'true' || completed.hud.missionPhase !== 'Victory' || completed.hud.mission !== `Victory · Final score ${completedScore} · R to replay` || completed.hud.assetButtonsDisabled !== true || completedScore <= unlockedScore) {
    throw new Error(`active extraction beacon did not enter typed Victory: ${JSON.stringify({ yellowReady, extractionCycle, completed })}`);
  }
  await screenshot('victory-final-score');

  // Victory must ignore player movement, charge, shooting, collision feedback,
  // score, relay, and extraction mutation while its UI actions stay disabled.
  await holdKey('w', 240);
  await holdKey('c', 240);
  await holdKey('f');
  await page.waitForTimeout(500);
  const frozen = { snapshot: await readSnapshot(), render: await readRenderEvidence(), hud: await readHud() };
  if (!frozen.snapshot?.ok || frozen.snapshot.value.state?.phase !== 'Victory' || frozen.snapshot.value.state?.fixedTicks !== completed.snapshot.value.state?.fixedTicks || frozen.hud.score !== completed.hud.score || frozen.hud.mission !== completed.hud.mission || JSON.stringify(frozen.snapshot.value.counterattack) !== JSON.stringify(completed.snapshot.value.counterattack) || JSON.stringify(frozen.snapshot.value.targetRelay) !== JSON.stringify(completed.snapshot.value.targetRelay) || JSON.stringify(frozen.snapshot.value.extraction) !== JSON.stringify(completed.snapshot.value.extraction) || JSON.stringify(frozen.snapshot.value.rewardChoice) !== JSON.stringify(completed.snapshot.value.rewardChoice) || JSON.stringify(frozen.snapshot.value.targetHealth) !== JSON.stringify(completed.snapshot.value.targetHealth) || JSON.stringify(frozen.snapshot.value.targetDisabling) !== JSON.stringify(completed.snapshot.value.targetDisabling) || JSON.stringify(frozen.snapshot.value.hitStreak) !== JSON.stringify(completed.snapshot.value.hitStreak) || JSON.stringify(frozen.snapshot.value.healthPickup) !== JSON.stringify(completed.snapshot.value.healthPickup) || JSON.stringify(frozen.snapshot.value.projectiles) !== JSON.stringify(completed.snapshot.value.projectiles) || JSON.stringify(frozen.render?.deferredCommands) !== JSON.stringify(completed.render?.deferredCommands) || JSON.stringify(frozen.render?.characterController?.position) !== JSON.stringify(completed.render?.characterController?.position) || frozen.snapshot.value.videoTexture?.active !== 'video' || frozen.hud.chargeState !== completed.hud.chargeState) {
    throw new Error(`Victory did not freeze Play mutation: ${JSON.stringify({ completed, frozen })}`);
  }
  await screenshot('victory-frozen');

  await holdKey('r');
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 5_000, polling: 50 });
  const reset = { snapshot: await readSnapshot(), hud: await readHud() };
  const resetFont = reset.snapshot.value.worldScoreText;
  const resetFontColor = resetFont?.color ?? [];
  const resetPickup = reset.snapshot?.ok ? originalPickup(reset.snapshot.value) : undefined;
  if (!reset.snapshot?.ok || reset.snapshot.value.state?.phase !== 'Play' || reset.snapshot.value.state?.resetTransitions !== (baseline.snapshot.value.state?.resetTransitions ?? 0) + 1 || reset.snapshot.value.counterattack?.pressureTier !== baseline.snapshot.value.counterattack?.pressureTier || reset.snapshot.value.counterattack?.patrolSpeed !== baseline.snapshot.value.counterattack?.patrolSpeed || reset.snapshot.value.counterattack?.chaseSpeed !== baseline.snapshot.value.counterattack?.chaseSpeed || reset.snapshot.value.counterattack?.pursuitRadius !== baseline.snapshot.value.counterattack?.pursuitRadius || reset.snapshot.value.targetProfile?.active !== 'original' || reset.snapshot.value.targetProfile?.precisionHits !== 0 || reset.snapshot.value.targetProfile?.precisionComplete !== false || reset.snapshot.value.targetRelay?.status !== 'locked' || reset.snapshot.value.targetRelay?.currentStep !== 0 || reset.snapshot.value.targetRelay?.acceptedHits !== 0 || reset.snapshot.value.targetRelay?.rejectedHits !== 0 || reset.snapshot.value.extraction?.status !== 'locked' || reset.snapshot.value.extraction?.collected !== 0 || reset.snapshot.value.extraction?.collectedMask !== 0 || reset.snapshot.value.extraction?.refusedContacts !== 0 || reset.snapshot.value.extraction?.victoryRequests !== 0 || reset.snapshot.value.extraction?.cores?.length !== 3 || reset.snapshot.value.extraction.cores.some((core) => !core.available || !core.sensor || !core.physicsReady) || reset.snapshot.value.extraction?.beacon?.activeVisual !== false || reset.snapshot.value.rewardChoice?.state !== 'none' || reset.snapshot.value.rewardChoice?.selections !== 0 || reset.snapshot.value.rewardChoice?.shieldConsumptions !== 0 || reset.snapshot.value.rewardChoice?.overchargeConsumptions !== 0 || reset.snapshot.value.rewardChoice?.pedestals?.length !== 2 || reset.snapshot.value.rewardChoice.pedestals.some((pedestal) => !pedestal.physicsReady) || resetPickup?.available !== true || resetPickup.sensor !== true || resetPickup.physicsReady !== true || resetPickup.admittedCollections !== 0 || resetPickup.deferredDespawns !== 0 || reset.snapshot.value.videoTexture?.active !== 'original' || reset.snapshot.value.videoTexture?.hitReactions !== 0 || reset.snapshot.value.videoTexture?.lastHitPlayhead !== null || reset.snapshot.value.spriteAtlas?.active !== false || reset.snapshot.value.spriteAtlas?.animatedShots !== 0 || reset.snapshot.value.spriteAtlas?.animatedHits !== 0 || reset.snapshot.value.fbxSkinnedTarget?.companionActive !== false || reset.snapshot.value.fbxSkinnedTarget?.hitPulses !== 0 || reset.snapshot.value.visibility?.effective !== 'visible' || resetFont?.fontSource !== 'legacy-pack' || Math.abs((resetFont?.fontSize ?? 0) - 0.024) > 1e-5 || Math.abs((resetFontColor[0] ?? 0) - 1) > 1e-5 || Math.abs((resetFontColor[1] ?? 0) - 0.8) > 1e-5 || Math.abs((resetFontColor[2] ?? 0) - 0.2) > 1e-5 || reset.hud.score !== 'Score  0' || reset.hud.mission !== 'Mission 1/3 · Score 50 · 0/50' || reset.hud.missionPhase !== 'Play' || reset.hud.profileDisabled !== true || reset.hud.fbxButtonDisabled !== true || reset.hud.missionComplete !== 'false' || reset.hud.target !== 'TARGET · RedBox · 100/100 HP · +10') {
    throw new Error(`mission reset failed: ${JSON.stringify(reset)}`);
  }
  await screenshot('mission-reset');

  // Re-enter the exact player path and complete a second Victory, then replay
  // once more to prove that the transaction remains reusable.
  const secondNeutralized = await neutralizeBouncyBall('second mission');
  for (const [x, y] of authoredAimPoints) {
    if (Number.parseInt((await readHud()).score?.replace(/\D/g, '') ?? '0', 10) >= 50) break;
    await fireAt(x, y);
  }
  await hudHost().locator('[data-ui-action="target-profile"]').click();
  await page.waitForTimeout(250);
  for (const [x, y] of precisionAimPoints) {
    await fireAt(x, y);
    const attempt = await readSnapshot();
    if (attempt?.value?.targetRelay?.status === 'active') break;
  }
  await hitRelayTarget([[627, 297], [617, 297], [637, 297], [627, 287], [627, 307]], 0);
  const secondRedHit = await hitRedRelay('second-relay');
  const secondYellowHit = await hitYellowRelay('second-relay');
  const secondExtractionCycle = await completeExtraction('second', 'overcharge');
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.victoryTransitions === 2, undefined, { timeout: 5_000, polling: 50 });
  const secondVictory = { snapshot: await readSnapshot(), hud: await readHud() };
  const secondScore = Number.parseInt(secondVictory.hud.score?.replace(/\D/g, '') ?? '0', 10);
  if (!secondVictory.snapshot?.ok || secondVictory.snapshot.value.state?.phase !== 'Victory' || secondVictory.snapshot.value.targetRelay?.status !== 'complete' || secondVictory.snapshot.value.targetRelay?.acceptedHits !== 3 || secondVictory.snapshot.value.extraction?.collected !== 3 || secondVictory.snapshot.value.extraction?.victoryRequests !== 1 || secondVictory.hud.mission !== `Victory · Final score ${secondScore} · R to replay` || secondScore < 50) {
    throw new Error(`second player cycle did not re-enter Victory: ${JSON.stringify({ reset, secondExtractionCycle, secondVictory })}`);
  }
  await screenshot('victory-second-cycle');

  await holdKey('r');
  await page.waitForFunction(async () => (await globalThis.__forgeaxPreviewInspection?.read('game-default.snapshot'))?.value?.state?.phase === 'Play', undefined, { timeout: 5_000, polling: 50 });
  const secondReset = { snapshot: await readSnapshot(), hud: await readHud() };
  const secondResetPickup = secondReset.snapshot?.ok ? originalPickup(secondReset.snapshot.value) : undefined;
  if (!secondReset.snapshot?.ok || secondReset.snapshot.value.state?.resetTransitions !== (baseline.snapshot.value.state?.resetTransitions ?? 0) + 2 || secondReset.snapshot.value.counterattack?.pressureTier !== baseline.snapshot.value.counterattack?.pressureTier || secondReset.snapshot.value.counterattack?.patrolSpeed !== baseline.snapshot.value.counterattack?.patrolSpeed || secondReset.snapshot.value.counterattack?.chaseSpeed !== baseline.snapshot.value.counterattack?.chaseSpeed || secondReset.snapshot.value.counterattack?.pursuitRadius !== baseline.snapshot.value.counterattack?.pursuitRadius || secondReset.snapshot.value.targetRelay?.status !== 'locked' || secondReset.snapshot.value.extraction?.status !== 'locked' || secondReset.snapshot.value.extraction?.collected !== 0 || secondReset.snapshot.value.extraction?.cores?.some((core) => !core.available || !core.sensor || !core.physicsReady) || secondResetPickup?.available !== true || secondResetPickup.sensor !== true || secondResetPickup.physicsReady !== true || secondReset.hud.score !== 'Score  0' || secondReset.hud.mission !== 'Mission 1/3 · Score 50 · 0/50') {
    throw new Error(`second replay did not restore Play: ${JSON.stringify(secondReset)}`);
  }
  await screenshot('mission-second-reset');

  if (pageErrors.length > 0 || consoleErrors.length > 0 || badResponses.length > 0) throw new Error(`browser diagnostics failed: ${JSON.stringify({ pageErrors, consoleErrors, badResponses })}`);
  writeReport('passed', { baseline, lockedAttempt, neutralized, firstHit, unlocked, profileActive, relayStarted, wrongTargetHit, wrongTarget, redVariation, firstRedHit, yellowReady, preparedVariations, firstYellowHit, extractionCycle, completed, frozen, reset, secondNeutralized, secondRedHit, secondYellowHit, secondExtractionCycle, secondVictory, secondReset });
  console.log(`Mission progression smoke PASS (${MODE}): score=${unlockedScore} precision=hit relay=3/3 pressure=0>1>2>3 maxTierMotion=live reward=Shield+Overcharge-x5 extraction=3/3 victory=frozen replay=2x secondScore=${secondScore} reset=exact`);
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
