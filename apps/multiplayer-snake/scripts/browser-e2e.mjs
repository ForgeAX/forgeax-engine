import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_REPLICATION_LIMITS, decodeReplicationPacket } from '@forgeax/engine-net';
import { HOST_ACTIVATION_REPORT_SERVICE } from '@forgeax/engine-host/transport';
import { startAuthority } from './authority-e2e.mjs';
import { startChaosWebSocketProxy } from './chaos-websocket.mjs';
import { installTestCanvasBudget } from '../../../scripts/test/browser-canvas-budget.mjs';
import testQuality from '../../../scripts/test/render-quality.json' with { type: 'json' };

export const RECONNECT_TARGET_ID = 'multiplayer-snake-reconnect';
// Keep the HUD readable at twice the drawing-buffer budget without making
// software Chromium composite a full desktop surface for every replica.
export const RECONNECT_VIEWPORT = Object.freeze({
  width: testQuality.viewport.width * 2,
  height: testQuality.viewport.height * 2,
});
export const RECONNECT_EXPECTATIONS = Object.freeze([
  {
    id: 'authority-derived-convergence',
    statement: 'The post-resync scene shows the authority-derived multiplayer state without visible stale or duplicate replicated entities.',
  },
  {
    id: 'continued-browser-operation',
    statement: 'Rendering and interaction remain visibly active after recovery instead of freezing on the disconnected frame or showing a blank or broken scene.',
  },
]);
const REQUIRED_PHASES = ['join', 'input-isolation', 'growth', 'death', 'respawn', 'late-join', 'recovery', 'disconnect'];
const MAX_BROWSER_STARTUP_TIMEOUT_MS = 180_000;
const BROWSER_STARTUP_TIMEOUT_MS = Math.min(
  Math.max(
    Number.parseInt(process.env.FORGEAX_SNAKE_BROWSER_STARTUP_TIMEOUT_MS ?? '180000', 10) ||
      180_000,
    1,
  ),
  MAX_BROWSER_STARTUP_TIMEOUT_MS,
);
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const defaultEvidenceDirectory = resolve(
  repositoryRoot,
  'artifacts',
  'multiplayer-snake-browser-reconnect',
);

function pendingVisualAssessment(invocationId) {
  return {
    invocationId,
    status: 'pending',
    verdict: 'unreviewed',
    expectations: RECONNECT_EXPECTATIONS.map((expectation) => ({
      id: expectation.id,
      statement: expectation.statement,
      observed: '',
      verdict: 'unreviewed',
      confidence: 'unrated',
    })),
  };
}

function normalizeVisualAssessment(input, invocationId) {
  const source = input ?? {};
  const entries = new Map(
    (Array.isArray(source.expectations) ? source.expectations : [])
      .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string')
      .map((entry) => [entry.id, entry]),
  );
  return {
    invocationId,
    status: source.status === 'passed' || source.status === 'failed' ? source.status : 'pending',
    verdict: source.verdict === 'pass' || source.verdict === 'fail' ? source.verdict : 'unreviewed',
    expectations: RECONNECT_EXPECTATIONS.map((expectation) => {
      const entry = entries.get(expectation.id);
      return {
        id: expectation.id,
        statement: expectation.statement,
        observed: typeof entry?.observed === 'string' ? entry.observed : '',
        verdict: entry?.verdict === 'pass' || entry?.verdict === 'fail' ? entry.verdict : 'unreviewed',
        confidence: ['high', 'medium', 'low'].includes(entry?.confidence) ? entry.confidence : 'unrated',
      };
    }),
  };
}

export function validateReconnectTrace(trace) {
  const failures = [];
  if (trace?.schemaVersion !== 1) failures.push({ code: 'trace-schema-mismatch' });
  if (trace?.targetId !== RECONNECT_TARGET_ID) failures.push({ code: 'trace-target-mismatch' });
  if (!trace?.invocationId) failures.push({ code: 'trace-invocation-missing' });
  const lifecycle = trace?.recovery?.lifecycle ?? [];
  const kinds = lifecycle.map((sample) => sample?.snapshot?.state?.kind);
  for (const kind of ['recovering', 'resyncing', 'active']) {
    if (!kinds.includes(kind)) failures.push({ code: `trace-missing-${kind}` });
  }
  const before = trace?.recovery?.before?.snapshot;
  const baseline = trace?.recovery?.baseline;
  const firstActive = baseline?.firstActive;
  const baselinePacket = baseline?.packet;
  if (!['started', 'already-recovering'].includes(trace?.recovery?.outcome?.kind))
    failures.push({ code: 'recovery-not-started' });
  if (before?.sessionId !== firstActive?.sessionId) failures.push({ code: 'session-identity-changed' });
  if (!Number.isSafeInteger(baseline?.freshEpoch) || baseline.freshEpoch <= (before?.epoch ?? -1)) {
    failures.push({ code: 'fresh-baseline-not-proven' });
  }
  if (baselinePacket?.kind !== 'baseline' || baselinePacket.sequence !== 1) {
    failures.push({ code: 'baseline-sequence-not-one' });
  }
  if (baselinePacket?.epoch !== firstActive?.epoch) {
    failures.push({ code: 'baseline-packet-mismatch' });
  }
  const preBaselineAttempt = trace?.recovery?.preBaselineAttempt;
  if (preBaselineAttempt?.accepted !== false || preBaselineAttempt.beforeSendCount !== preBaselineAttempt.afterSendCount) {
    failures.push({ code: 'pre-baseline-command-accepted' });
  }
  const convergence = trace?.recovery?.convergence;
  if (convergence?.uniqueIdentityCount !== convergence?.identityCount ||
    convergence?.uniquePlayerCount !== convergence?.playerCount) failures.push({ code: 'duplicate-replicated-identity' });
  const interaction = trace?.recovery?.interaction;
  if (interaction?.accepted !== true || interaction?.afterSendCount <= interaction?.beforeSendCount) {
    failures.push({ code: 'post-recovery-interaction-missing' });
  }
  if (!trace?.cleanup?.allRetired || trace?.cleanup?.allZeroOwnedResources !== true) {
    failures.push({ code: 'cleanup-not-proven' });
  }
  return { ok: failures.length === 0, failures };
}

export function validateReconnectVisualReport(report) {
  const failures = [];
  if (report?.schemaVersion !== 1) failures.push({ code: 'report-schema-mismatch' });
  if (report?.targetId !== RECONNECT_TARGET_ID) failures.push({ code: 'report-target-mismatch' });
  if (!report?.invocationId || report?.visualAssessment?.invocationId !== report.invocationId) {
    failures.push({ code: 'report-invocation-mismatch' });
  }
  if (report?.trace?.targetId !== RECONNECT_TARGET_ID || report?.trace?.invocationId !== report.invocationId) {
    failures.push({ code: 'report-trace-mismatch' });
  }
  if (report?.screenshot?.targetId !== RECONNECT_TARGET_ID || report?.screenshot?.bytes <= 0 ||
    report?.screenshot?.width !== RECONNECT_VIEWPORT.width || report?.screenshot?.height !== RECONNECT_VIEWPORT.height) {
    failures.push({ code: 'report-screenshot-missing' });
  }
  const assessment = report?.visualAssessment;
  if (assessment?.status !== 'passed' || assessment?.verdict !== 'pass') {
    failures.push({ code: 'visual-assessment-pending' });
  }
  const entries = new Map((assessment?.expectations ?? []).map((entry) => [entry?.id, entry]));
  for (const expectation of RECONNECT_EXPECTATIONS) {
    const entry = entries.get(expectation.id);
    if (entry?.verdict === 'fail') {
      failures.push({ code: 'visual-expectation-failed', expectationId: expectation.id });
    } else if (entry?.verdict !== 'pass' || typeof entry.observed !== 'string' || entry.observed.length === 0 ||
      !['high', 'medium', 'low'].includes(entry.confidence)) {
      failures.push({ code: 'visual-expectation-incomplete', expectationId: expectation.id });
    }
  }
  return { ok: failures.length === 0, failures };
}

function createInvocationId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
}

function inspectScreenshot(bytes, path) {
  if (bytes.length < 24 || bytes[0] !== 137 || bytes.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('reconnect-visual: screenshot is not a PNG');
  }
  return {
    targetId: RECONNECT_TARGET_ID,
    path,
    bytes: bytes.length,
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function falsifierAssessment(trace, invocationId) {
  const checks = trace.visual?.checks;
  if (checks === undefined || (checks.authorityDerivedConvergence && checks.continuedBrowserOperation)) {
    return undefined;
  }
  const verdicts = {
    'authority-derived-convergence': checks.authorityDerivedConvergence ? 'pass' : 'fail',
    'continued-browser-operation': checks.continuedBrowserOperation ? 'pass' : 'fail',
  };
  return {
    invocationId,
    status: 'failed',
    verdict: 'fail',
    expectations: RECONNECT_EXPECTATIONS.map((expectation) => ({
      id: expectation.id,
      statement: expectation.statement,
      observed: `falsifier trace recorded ${expectation.id}=${verdicts[expectation.id]}`,
      verdict: verdicts[expectation.id],
      confidence: 'high',
    })),
  };
}

async function readVisualAssessment(trace, invocationId) {
  const assessmentPath = process.env.FORGEAX_VISUAL_ASSESSMENT_PATH;
  if (assessmentPath !== undefined && assessmentPath.length > 0) {
    return normalizeVisualAssessment(JSON.parse(await readFile(assessmentPath, 'utf8')), invocationId);
  }
  return falsifierAssessment(trace, invocationId) ?? pendingVisualAssessment(invocationId);
}

async function publishReconnectEvidence({ trace, screenshot, invocationId, url, outputDirectory }) {
  await mkdir(outputDirectory, { recursive: true });
  const tracePath = resolve(outputDirectory, `${RECONNECT_TARGET_ID}.trace.json`);
  const reportPath = resolve(outputDirectory, `${RECONNECT_TARGET_ID}.visual.json`);
  const visualAssessment = await readVisualAssessment(trace, invocationId);
  const report = {
    schemaVersion: 1,
    targetId: RECONNECT_TARGET_ID,
    invocationId,
    url,
    browser: 'chrome-beta',
    viewport: RECONNECT_VIEWPORT,
    tracePath,
    screenshot,
    trace,
    visualAssessment,
  };
  await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { tracePath, reportPath, report, validation: validateReconnectVisualReport(report) };
}

function assertNamedPhases(phases) {
  for (const phase of REQUIRED_PHASES) {
    if (!phases.includes(phase)) throw new Error(`missing named browser phase: ${phase}`);
  }
}

function startVite() {
  const child = spawn('pnpm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '0'], {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  const url = new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`vite ready timeout after ${BROWSER_STARTUP_TIMEOUT_MS}ms${output ? `: ${output.slice(-500)}` : ''}`));
    }, BROWSER_STARTUP_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const cleanOutput = output.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
      const match = cleanOutput.match(/Local:\s+(http:\/\/[^\s]+)/);
      if (match && !settled) { settled = true; clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.once('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(error); }
    });
    child.once('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`vite exited (${code}): ${output.slice(-2000)}`)); }
    });
  });
  return { child, url };
}

async function stopProcess(child) {
  if (child === undefined || child.exitCode !== null) return;
  const signal = (name) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, name); } catch { child.kill(name); }
  };
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal('SIGKILL');
      resolve();
    }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    signal('SIGTERM');
  });
}

const STATE_SELECTOR = '[data-testid="snake-state"]';
const MOVEMENT = Object.freeze({
  up: { x: 0, y: -1 }, right: { x: 1, y: 0 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 },
});
const OPPOSITE_DIRECTION = Object.freeze({ up: 'down', right: 'left', down: 'up', left: 'right' });
const DIRECTION_KEYS = Object.freeze({ up: 'ArrowUp', right: 'ArrowRight', down: 'ArrowDown', left: 'ArrowLeft' });

/** Owned resources and accumulated evidence of one browser reconnect journey. */
function createJourney() {
  return {
    sabotage: process.env.SNAKE_SABOTAGE ?? process.env.M17_SABOTAGE ?? '',
    chaosMode: process.env.M17_CHAOS_MODE ?? '',
    authority: undefined,
    chaosProxy: undefined,
    vite: undefined,
    browsers: [],
    contexts: [],
    errors: [],
    phases: [],
    recoveryLifecycle: [],
    canvasEvidence: [],
    recoveryPackets: [],
    captureRecoveryPackets: false,
  };
}

async function releaseJourney(journey) {
  console.log(JSON.stringify({ phase: 'cleanup', owner: 'contexts', count: journey.contexts.length }));
  for (const context of journey.contexts) await context.close().catch(() => {});
  console.log(JSON.stringify({ phase: 'cleanup', owner: 'browsers', count: journey.browsers.length }));
  for (const browser of journey.browsers) await browser.close().catch(() => {});
  console.log(JSON.stringify({ phase: 'cleanup', owner: 'vite' }));
  await stopProcess(journey.vite?.child);
  console.log(JSON.stringify({ phase: 'cleanup', owner: 'network' }));
  await journey.chaosProxy?.close().catch(() => {});
  await journey.authority?.kill().catch(() => {});
  console.log(JSON.stringify({ phase: 'cleanup', owner: 'complete' }));
}

async function startServices(journey) {
  journey.authority = await startAuthority({ tickMs: 15, observablePeerChangeDelayMs: 1_000 });
  const directConnectionUrl = `ws://127.0.0.1:${journey.authority.port}`;
  if (!Number.isInteger(journey.authority.hostPort) || journey.authority.hostPort <= 0)
    throw new Error('authority did not publish an explicit host control endpoint');
  const directHostConnectionUrl = `ws://127.0.0.1:${journey.authority.hostPort}`;
  if (journey.chaosMode.length > 0) {
    journey.chaosProxy = await startChaosWebSocketProxy({
      targetUrl: directConnectionUrl,
      targetHostUrl: directHostConnectionUrl,
      mode: journey.chaosMode,
      sabotage: journey.sabotage,
      delayMs: 40,
    });
  }
  const connectionUrl = journey.chaosProxy?.url ?? directConnectionUrl;
  const hostConnectionUrl = journey.chaosProxy?.hostUrl ?? directHostConnectionUrl;
  const hostQuery = `&host=${encodeURIComponent(hostConnectionUrl)}`;
  journey.vite = startVite();
  const base = await journey.vite.url;
  return { connectionUrl, hostConnectionUrl, hostQuery, base };
}

async function launchBrowser(journey) {
  const browserHeadless = (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase() !== '0';
  const browser = await chromium.launch({
    channel: 'chrome-beta',
    headless: browserHeadless,
    args: [
      '--disable-features=MacAppCodeSignClone',
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
  journey.browsers.push(browser);
  return browser;
}

/** Each real client owns its browser process, budgeted context and error capture. */
async function openClientPage(journey) {
  const browser = await launchBrowser(journey);
  const context = await browser.newContext({ viewport: RECONNECT_VIEWPORT });
  await installTestCanvasBudget(context);
  journey.contexts.push(context);
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') journey.errors.push(message.text()); });
  page.on('pageerror', (error) => journey.errors.push(error.message));
  return page;
}

function stateNode(page) {
  return page.locator(STATE_SELECTOR);
}

async function readSendCount(page) {
  return Number(await stateNode(page).getAttribute('data-direction-command-send-count') ?? 0);
}

async function readStateNodeDatasets(page) {
  return stateNode(page).evaluate((node) => ({
    text: node.textContent,
    datasets: { ...node.dataset },
  }));
}

async function readState(page) {
  const node = stateNode(page);
  const deadline = Date.now() + 10_000;
  let latest = '';
  while (Date.now() < deadline) {
    latest = (await node.textContent()) ?? '';
    if (latest.trimStart().startsWith('{')) {
      try {
        return JSON.parse(latest);
      } catch {
        // The app is replacing the status payload; sample the next frame.
      }
    }
    await page.waitForTimeout(25);
  }
  throw new Error(`snake-state was not JSON after 10000ms: ${latest}`);
}

async function waitForAuthority(journey, predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = journey.authority.observations().at(-1);
    if (latest !== undefined && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`authority ${label} timeout: ${JSON.stringify(latest)}`);
}

async function waitForBrowserReady(journey, page, label) {
  try {
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="snake-state"]');
      if (node?.dataset.netSessionState === 'failed') throw new Error(node.dataset.netErrorDetail);
      return node?.dataset.lifecycle === 'failed' ||
        (node?.dataset.rendererReady === 'true' && node?.dataset.joinSent === 'true' &&
          globalThis.__forgeaxSnake?.completedFrames() > 0);
    }, undefined, { timeout: BROWSER_STARTUP_TIMEOUT_MS });
    if (await stateNode(page).getAttribute('data-lifecycle') === 'failed')
      throw new Error('terminal startup failure');
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const node = document.querySelector('[data-testid="snake-state"]');
      return {
        state: node?.textContent ?? null,
        datasets: node === null ? null : { ...node.dataset },
      };
    }).catch((cause) => ({ evaluateError: String(cause) }));
    throw new Error(`browser readiness failed (${label}): ${JSON.stringify({ diagnostics, errors: journey.errors })}`, { cause: error });
  }
}

async function sampleCanvas(page) {
  return page.evaluate(() => {
    const node = document.querySelector('[data-testid="snake-state"]');
    const canvas = document.querySelector('canvas');
    const text = node?.textContent ?? '{}';
    return {
      state: JSON.parse(text),
      renderEntityCount: Number(node?.getAttribute('data-render-entity-count') ?? -1),
      drawingBuffer: { width: canvas?.width, height: canvas?.height },
    };
  });
}

function assertCanvasBudget(drawingBuffer, label) {
  if (drawingBuffer.width > testQuality.viewport.width ||
    drawingBuffer.height > testQuality.viewport.height ||
    !(drawingBuffer.width > 0 && drawingBuffer.height > 0))
    throw new Error(`canvas budget not applied (${label}): ${JSON.stringify(drawingBuffer)}`);
}

function totalBodyLength(state) {
  return state.snakes.reduce((total, snake) => total + snake.bodyLength, 0);
}

async function captureCanvasEvidence(journey, page, label) {
  const allowMismatch = journey.sabotage === 'visual-hide-body';
  const deadline = Date.now() + 10_000;
  let sample;
  while (true) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) throw new Error(`canvas-rendered: unstable state/render sample at ${label}`);
    await page.waitForFunction((allowMismatch) => {
      const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      const state = JSON.parse(text);
      const rendered = Number(document.querySelector('[data-testid="snake-state"]')?.getAttribute('data-render-entity-count') ?? -1);
      const expected = state.snakes.reduce((total, snake) => total + snake.bodyLength, 0);
      return state.tick > 0 && state.snakes.length > 0 && (allowMismatch || rendered === expected);
    }, allowMismatch, { timeout });
    sample = await sampleCanvas(page);
    assertCanvasBudget(sample.drawingBuffer, label);
    if (allowMismatch || sample.renderEntityCount === totalBodyLength(sample.state)) break;
  }
  journey.canvasEvidence.push({
    label,
    state: sample.state,
    renderEntityCount: sample.renderEntityCount,
    expectedRenderEntityCount: totalBodyLength(sample.state),
  });
  return journey.canvasEvidence.at(-1);
}

async function readRecoverySnapshot(page) {
  return page.evaluate(() => globalThis.__forgeaxSnake?.snapshot() ?? null);
}

async function recordRecoverySample(journey, page, label, snapshotOverride) {
  const snapshot = snapshotOverride ?? await readRecoverySnapshot(page);
  if (snapshot === null) throw new Error(`recovery-trace: public browser probe unavailable at ${label}`);
  const state = await readState(page);
  const sample = {
    label,
    snapshot,
    state: {
      tick: state.tick,
      identities: state.snakes.map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`),
      bodyLength: totalBodyLength(state),
      renderEntityCount: Number(await stateNode(page).getAttribute('data-render-entity-count') ?? -1),
    },
  };
  journey.recoveryLifecycle.push(sample);
  return sample;
}

function recordRecoveryPacketsFrom(journey, page) {
  page.on('websocket', (webSocket) => {
    webSocket.on('framereceived', ({ payload }) => {
      if (!journey.captureRecoveryPackets) return;
      const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
      const decoded = decodeReplicationPacket(bytes, DEFAULT_REPLICATION_LIMITS);
      if (!decoded.ok || (decoded.value.kind !== 'baseline' && decoded.value.kind !== 'delta')) return;
      journey.recoveryPackets.push({
        kind: decoded.value.kind,
        sessionId: decoded.value.sessionId,
        epoch: decoded.value.epoch,
        sequence: decoded.value.sequence,
        tick: decoded.value.tick,
      });
    });
  });
}

function identitySet(state) {
  return new Set(state.snakes.map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`));
}

function tuple(snake) {
  return snake === undefined ? undefined : { direction: snake.direction, score: snake.score, bodyLength: snake.bodyLength };
}

function byPlayer(state, playerNetworkId) {
  return state.snakes.find((snake) => snake.playerNetworkId === playerNetworkId);
}

function sameIncarnation(left, right) {
  return left !== undefined && right !== undefined &&
    left.playerNetworkId === right.playerNetworkId && left.networkEntityId === right.networkEntityId;
}

function assertSemantic(journey, name, condition, detail) {
  const mutated = journey.sabotage === name ? false : condition;
  if (!mutated) throw new Error(`${name}: ${detail}`);
}

async function readTickDiagnostics(targetPage, previous) {
  return stateNode(targetPage).evaluate((node, expectedTick) => ({
    expectedTick,
    state: node.textContent,
    datasets: { ...node.dataset },
    probe: globalThis.__forgeaxSnake === undefined
      ? null
      : {
          snapshot: globalThis.__forgeaxSnake.snapshot(),
          appLastError: globalThis.__forgeaxSnake.appLastError?.() ?? null,
          renderer: globalThis.__forgeaxSnake.rendererInspection?.() ?? null,
        },
  }), previous);
}

async function waitForTick(journey, targetPage, tick) {
  try {
    await targetPage.waitForFunction((previous) => {
      const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      try {
        return JSON.parse(text).tick > previous;
      } catch {
        return false;
      }
    }, tick, { timeout: 5_000 });
  } catch (error) {
    const diagnostics = await Promise.all(journey.contexts.flatMap((context) => context.pages()).map((clientPage) =>
      readTickDiagnostics(clientPage, tick).catch((cause) => ({ evaluateError: String(cause) }))));
    throw new Error(`tick progress timeout: ${JSON.stringify({ diagnostics, authority: journey.authority.observations().slice(-12), errors: journey.errors })}`, { cause: error });
  }
}

// Pick one turn from the freshest replica snapshot.  The authority runs a
// fixed tick and drains at most one command per peer per tick; a precomputed
// path therefore becomes stale whenever a snapshot batches ticks or a
// command arrives just after a tick boundary.  Replanning after every
// observed tick keeps the controller online and never relies on private
// authority state.
function onlineStep(snake, goal) {
  const candidates = Object.keys(MOVEMENT)
    .filter((direction) => direction !== OPPOSITE_DIRECTION[snake.direction])
    .map((direction) => {
      const delta = MOVEMENT[direction];
      const x = snake.x + delta.x;
      const y = snake.y + delta.y;
      const isGoal = x === goal.x && y === goal.y;
      const inside = x >= 0 && x < 24 && y >= 0 && y < 16;
      const safeInterior = (x > 0 && x < 23 && y > 0 && y < 15) || isGoal;
      if (!inside || !safeInterior) return undefined;
      return {
        direction,
        distance: Math.abs(goal.x - x) + Math.abs(goal.y - y),
        axisPenalty: direction === snake.direction ? 0 : 1,
      };
    })
    .filter((candidate) => candidate !== undefined)
    .sort((left, right) => left.distance - right.distance || left.axisPenalty - right.axisPenalty);
  return candidates[0]?.direction ?? snake.direction;
}

function straightAhead(snake) {
  return { x: snake.x + MOVEMENT[snake.direction].x, y: snake.y + MOVEMENT[snake.direction].y };
}

function controlledPlayer(state) {
  return state.snakes.find((snake) => snake.x > 2 && snake.x < 21)?.playerNetworkId ??
    state.snakes[0]?.playerNetworkId;
}

async function pressAndAwaitTick(journey, page, state, direction) {
  const tick = state.tick;
  await page.keyboard.press(DIRECTION_KEYS[direction]);
  await waitForTick(journey, page, tick);
}

// A peer keeps its public player identity across its ordinary production
// respawn.  Wait for that observable lifecycle rather than treating a boundary
// death between phases as fixture failure.
async function waitForPlayerPresence(page, player) {
  await page.waitForFunction((playerNetworkId) => {
    const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
    if (!text.startsWith('{')) return false;
    return JSON.parse(text).snakes.some((entry) => entry.playerNetworkId === playerNetworkId);
  }, player, { timeout: 10_000 });
}

async function driveToFood(journey, page, page0Player, before) {
  const player = page0Player ?? controlledPlayer(before);
  if (player === undefined || before.food === undefined) throw new Error('growth: public state has no controlled snake or food');
  let initial = byPlayer(before, player);
  for (let attempt = 0; attempt < 260; attempt += 1) {
    const state = await readState(page);
    const snake = byPlayer(state, player);
    if (snake === undefined) {
      await waitForPlayerPresence(page, player);
      initial = undefined;
      continue;
    }
    if (initial === undefined) {
      initial = snake;
      continue;
    }
    if (snake.score > initial.score && snake.bodyLength > initial.bodyLength) return state;
    await pressAndAwaitTick(journey, page, state, onlineStep(snake, state.food));
  }
  throw new Error('growth: keyboard-only route timed out');
}

async function driveToDeath(journey, page, page0Player, before) {
  const player = page0Player ?? controlledPlayer(before);
  const deathStart = before.tick;
  for (let attempt = 0; attempt < 260; attempt += 1) {
    const state = await readState(page);
    const snake = byPlayer(state, player);
    if (snake === undefined) return state;
    const goal = snake.x < 12 ? { x: 0, y: snake.y } : { x: 23, y: snake.y };
    await pressAndAwaitTick(journey, page, state, onlineStep(snake, goal));
  }
  throw new Error(`death: controlled snake survived beyond tick ${deathStart + 260}`);
}

async function runTickedPhase(journey, name, action) {
  const phasePage = journey.contexts[0].pages()[0];
  const before = await readState(phasePage);
  await action(before);
  await journey.contexts[0].pages()[0].waitForFunction((tick) => {
    const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
    return value.tick > tick;
  }, before.tick, { timeout: 5_000 });
  const after = await readState(journey.contexts[0].pages()[0]);
  if (after.tick <= before.tick) throw new Error(`${name}: authority tick did not advance`);
  journey.phases.push(name);
  console.log(JSON.stringify({ phase: name, before, after }));
}

async function startPrimaryClient(journey, page, clientUrl) {
  await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });
  await waitForBrowserReady(journey, page, 'primary');
  try {
    await page.waitForFunction(() => {
      const snapshot = globalThis.__forgeaxSnake?.snapshot();
      if (snapshot?.state.kind === 'failed') throw new Error(JSON.stringify(snapshot.state.error));
      const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      const state = JSON.parse(text);
      return state.snakes.length === 0 && state.session?.started === false;
    }, undefined, { timeout: BROWSER_STARTUP_TIMEOUT_MS });
  } catch (error) {
    const state = await stateNode(page).evaluate((node) => ({
      state: node.textContent,
      rendererReady: node.dataset.rendererReady,
      joinSent: node.dataset.joinSent,
      appErrorTail: node.dataset.appErrorTail,
    }));
    throw new Error(`waiting-state failed: ${JSON.stringify({ state, errors: journey.errors })}`, { cause: error });
  }
  return readState(page);
}

// Close the secondary client's first real socket before App assembly can
// consume it. Initial join must survive the same recovery path as rejoin.
async function startSecondaryClientThroughStartupDisconnect(journey, page, clientUrl, connectionUrl) {
  await page.addInitScript((targetUrl) => {
    const NativeWebSocket = globalThis.WebSocket;
    const evidence = { connections: 0, closed: false };
    globalThis.__snakeStartupDisconnect = evidence;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        if (String(args[0]) !== targetUrl) return;
        evidence.connections += 1;
        if (evidence.connections === 1) this.addEventListener('open', () => {
          evidence.closed = true;
          this.close(1000, 'startup recovery regression');
        }, { once: true });
      }
    };
  }, connectionUrl);
  await page.goto(clientUrl, { waitUntil: 'domcontentloaded' });
  await waitForBrowserReady(journey, page, 'secondary');
  const startupRecovery = await page.evaluate(() => globalThis.__snakeStartupDisconnect);
  if (!startupRecovery?.closed || startupRecovery.connections < 2)
    throw new Error(`startup recovery was not exercised: ${JSON.stringify(startupRecovery)}`);
}

async function waitForGameplayStart(journey, firstPage, initialPages) {
  try {
    await firstPage.waitForFunction(() => {
      const snapshot = globalThis.__forgeaxSnake?.snapshot();
      if (snapshot?.state.kind === 'failed') throw new Error(JSON.stringify(snapshot.state.error));
      const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      const state = JSON.parse(text);
      return state.session?.started === true && state.session?.startedAtGameplayTick === 0 && state.session?.gameplayTick >= 1;
    }, undefined, { timeout: BROWSER_STARTUP_TIMEOUT_MS });
  } catch (error) {
    const diagnostics = await Promise.all(initialPages.map(async (candidate) => stateNode(candidate).evaluate((node) => ({
      state: node.textContent,
      datasets: { ...node.dataset },
      probe: globalThis.__forgeaxSnake?.snapshot() ?? null,
    }))));
    throw new Error(`gameplay did not start: ${JSON.stringify({ diagnostics, authority: journey.authority.observations().slice(-12), errors: journey.errors })}`, { cause: error });
  }
  return readState(firstPage);
}

function assertSessionLifecycle(waitingState, firstGameplayState) {
  if (waitingState.snakes.length !== 0 || waitingState.session?.started !== false ||
    firstGameplayState.session?.started !== true || firstGameplayState.session?.startedAtGameplayTick !== 0 || firstGameplayState.session?.gameplayTick < 1)
    throw new Error('session-lifecycle: waiting, start-at-zero, and first-gameplay-tick evidence is incomplete');
}

async function assertJoinLifecycleMarkers(journey, lifecyclePage) {
  const lifecycleState = await stateNode(lifecyclePage).evaluate((node) => ({
    rendererReady: node.dataset.rendererReady === 'true',
    joinSent: node.dataset.joinSent === 'true',
  }));
  assertSemantic(journey, 'connect-as-join', lifecycleState.rendererReady && lifecycleState.joinSent,
    `renderer/join lifecycle markers missing: ${JSON.stringify(lifecycleState)}`);
}

async function waitForTwoPeerSnapshots(journey) {
  for (const context of journey.contexts) {
    const page = context.pages()[0];
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      const state = JSON.parse(text);
      return state.tick >= 1 && state.snakes.length >= 2;
    }, undefined, { timeout: 15_000 });
  }
}

async function readAcknowledgedSnake(page) {
  let observed = await readState(page);
  const playerNetworkId = observed.session?.lastDirectionCommandPlayerNetworkId;
  let snake = observed.snakes.find((entry) => entry.playerNetworkId === playerNetworkId);
  if (snake === undefined && playerNetworkId !== undefined) {
    await page.waitForFunction((player) => {
      const state = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      return state.snakes?.some((entry) => entry.playerNetworkId === player);
    }, playerNetworkId, { timeout: 1_000 }).catch(() => undefined);
    observed = await readState(page);
    snake = observed.snakes.find((entry) => entry.playerNetworkId === playerNetworkId);
  }
  return snake === undefined ? undefined : { snake, state: observed };
}

async function probePage0Direction(page, key) {
  const probeBefore = await readState(page);
  const sendCount = await readSendCount(page);
  await page.keyboard.press(key);
  const sent = await page.waitForFunction((previous) =>
    Number(document.querySelector('[data-testid="snake-state"]')?.getAttribute('data-direction-command-send-count') ?? 0) > previous,
  sendCount, { timeout: 1_000 }).then(() => true).catch(() => false);
  if (!sent) return undefined;
  const acknowledged = await page.waitForFunction((previousGameplayTick) => {
    const target = document.querySelector('[data-testid="snake-state"]');
    const value = JSON.parse(target?.textContent ?? '{}');
    const session = value.session;
    return session !== undefined && session.lastDirectionCommandGameplayTick > previousGameplayTick &&
      session.lastDirectionCommandPlayerNetworkId > 0;
  }, probeBefore.session?.lastDirectionCommandGameplayTick ?? 0, { timeout: 1_000 }).then(() => true).catch(() => false);
  if (!acknowledged) return undefined;
  return readAcknowledgedSnake(page);
}

async function discoverPage0Snake(page) {
  for (let round = 0; round < 8; round += 1) {
    for (const candidate of Object.keys(DIRECTION_KEYS)) {
      const discovered = await probePage0Direction(page, DIRECTION_KEYS[candidate]);
      if (discovered !== undefined) return discovered;
    }
  }
  throw new Error('valid-send: no same-incarnation authority acknowledgement for page0 keyboard command');
}

async function discoverInputFixture(page) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const discovered = await discoverPage0Snake(page);
    const opponent = discovered.state.snakes.find((snake) => snake.playerNetworkId !== discovered.snake.playerNetworkId);
    if (opponent === undefined) continue;
    const stable = await readState(page);
    const aSnake = stable.snakes.find((snake) => sameIncarnation(snake, discovered.snake));
    if (aSnake !== undefined) return { aSnake, opponentPlayer: opponent.playerNetworkId };
  }
  throw new Error('valid-send: causally discovered page0 fixture did not remain live');
}

function chooseInteriorTurn(aSnake) {
  const turn = Object.keys(MOVEMENT).find((candidate) => candidate !== aSnake.direction && candidate !== OPPOSITE_DIRECTION[aSnake.direction] &&
    aSnake.x + MOVEMENT[candidate].x > 0 && aSnake.x + MOVEMENT[candidate].x < 23 &&
    aSnake.y + MOVEMENT[candidate].y > 0 && aSnake.y + MOVEMENT[candidate].y < 15);
  return turn ?? onlineStep(aSnake, straightAhead(aSnake));
}

/** Proves page0 keyboard input reaches only its own snake; returns page0's player identity. */
async function proveInputIsolation(journey, page, initialPlayerIds) {
  const fixture = await discoverInputFixture(page);
  let { aSnake } = fixture;
  const { opponentPlayer } = fixture;
  const a = aSnake.playerNetworkId;
  const before = await readState(page);
  aSnake = before.snakes.find((snake) => sameIncarnation(snake, aSnake));
  if (aSnake === undefined) throw new Error('valid-send: fixture lost A before authority acknowledgement');
  // The initial snapshot is intentionally taken before the traffic-heavy
  // control proof.  Preserve the two identities discovered by that proof:
  // either may naturally respawn before C joins, but neither is a late peer.
  initialPlayerIds.add(a);
  initialPlayerIds.add(opponentPlayer);
  const beforeCount = await readSendCount(page);
  await page.keyboard.press('q');
  const invalidCount = await readSendCount(page);
  assertSemantic(journey, 'invalid-send', invalidCount === beforeCount, `attempted/successful send delta expected 0, observed ${invalidCount - beforeCount}`);
  const direction = chooseInteriorTurn(aSnake);
  await page.keyboard.press(DIRECTION_KEYS[direction]);
  const previousCommandTick = before.session?.lastDirectionCommandGameplayTick ?? 0;
  await page.waitForFunction(({ tick, playerNetworkId, previousCommandTick }) => {
    const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
    const session = value.session;
    return value.tick > tick && session?.lastDirectionCommandPlayerNetworkId === playerNetworkId &&
      session.lastDirectionCommandGameplayTick > previousCommandTick;
  }, { tick: before.tick, playerNetworkId: a, previousCommandTick }, { timeout: 5_000 });
  const validCount = await readSendCount(page);
  assertSemantic(journey, 'valid-send', validCount === beforeCount + 1, `successful send delta expected 1, observed ${validCount - beforeCount}`);
  const after = await readState(page);
  const afterA = after.snakes.find((snake) => sameIncarnation(snake, aSnake));
  const acknowledged = after.session?.lastDirectionCommandPlayerNetworkId === a &&
    (after.session?.lastDirectionCommandGameplayTick ?? 0) > previousCommandTick;
  assertSemantic(journey, 'a-direction-transition', acknowledged, `A direction did not acknowledge ${direction}`);
  assertSemantic(journey, 'transition-movement', acknowledged, `movement transition was not acknowledged for ${direction}`);
  assertSemantic(journey, 'b-controlled-invariance', acknowledged,
    `authority attributed the page0 command to ${after.session?.lastDirectionCommandPlayerNetworkId}, expected ${a}`);
  console.log(JSON.stringify({ assertion: 'A/B semantic authority ack', before: { a: tuple(aSnake), bPlayer: opponentPlayer }, after: { a: tuple(afterA), commandPlayer: after.session?.lastDirectionCommandPlayerNetworkId }, tick: after.tick }));
  return a;
}

async function runGrowthPhase(journey, page, page0Player) {
  const growthBefore = await readState(page);
  const growthAfter = await driveToFood(journey, page, page0Player, growthBefore);
  const growthBeforePlayer = byPlayer(growthBefore, page0Player);
  const growthAfterPlayer = byPlayer(growthAfter, page0Player);
  if (growthAfter.tick <= growthBefore.tick || growthAfterPlayer === undefined || growthBeforePlayer === undefined ||
    growthAfterPlayer.score <= growthBeforePlayer.score || growthAfterPlayer.bodyLength <= growthBeforePlayer.bodyLength)
    throw new Error('growth: score and body length did not both increase');
  journey.phases.push('growth');
  console.log(JSON.stringify({ phase: 'growth', before: growthBefore, after: growthAfter }));
}

async function runDeathPhase(journey, page, page0Player) {
  const deathBefore = await readState(page);
  const deathAfter = await driveToDeath(journey, page, page0Player, deathBefore);
  if (deathAfter.tick <= deathBefore.tick || deathAfter.snakes.some((snake) => snake.playerNetworkId === page0Player))
    throw new Error('death: controlled snake remained present after boundary collision');
  journey.phases.push('death');
  console.log(JSON.stringify({ phase: 'death', before: deathBefore, after: deathAfter }));
  return { deathBefore, deathAfter };
}

async function runRespawnPhase(journey, page, page0Player, { deathBefore, deathAfter }) {
  const respawnStart = deathAfter.tick;
  await page.waitForFunction(({ startTick, playerNetworkId }) => {
    const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
    // A respawn projects a fresh ECS entity, so its replica row id is not
    // stable across death.  Wait for this public player identity specifically;
    // an opponent respawning first is not evidence for page0's respawn.
    return value.tick >= startTick + 30 &&
      value.snakes.some((snake) => snake.playerNetworkId === playerNetworkId);
  }, { startTick: respawnStart, playerNetworkId: page0Player }, { timeout: 10_000 });
  const respawnAfter = await readState(page);
  if (respawnAfter.tick < respawnStart + 30) throw new Error(`respawn: returned too early at tick ${respawnAfter.tick}, death ${respawnStart}`);
  const respawned = byPlayer(respawnAfter, page0Player);
  assertSemantic(journey, 'respawn-player-continuity', respawned !== undefined && respawned.playerNetworkId === page0Player,
    'playerNetworkId did not persist across respawn');
  assertSemantic(journey, 'respawn-new-incarnation', respawned !== undefined && respawned.networkEntityId !== byPlayer(deathBefore, page0Player)?.networkEntityId,
    'networkEntityId was not replaced on respawn');
  console.log(JSON.stringify({ assertion: 'respawn identity', before: byPlayer(deathBefore, page0Player), after: respawned }));
  journey.phases.push('respawn');
  console.log(JSON.stringify({ phase: 'respawn', before: deathAfter, after: respawnAfter }));
}

/** Drops ACKs only on the blocked late connection; native server messages and close forwarding stay intact. */
async function routeLateGameTransport(latePage, connectionUrl, lateTransport) {
  await latePage.routeWebSocket(connectionUrl, route => {
    const connection = ++lateTransport.connections;
    const server = route.connectToServer();
    route.onMessage(message => {
      const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
      const packet = decodeReplicationPacket(bytes, DEFAULT_REPLICATION_LIMITS);
      if (connection === lateTransport.blockedConnection && packet.ok && packet.value.kind === 'ack') {
        lateTransport.ackDrops++;
        return;
      }
      server.send(message);
    });
  });
}

// Host activation can finish after the finite game-session ACK budget.
// Delay only its real response; the game transport and retry policy stay live.
async function holdLateHostActivation(latePage, hostConnectionUrl, lateTransport) {
  await latePage.routeWebSocket(hostConnectionUrl, route => {
    const server = route.connectToServer();
    let reportId;
    let timer;
    route.onMessage(message => {
      const packet = JSON.parse(String(message));
      if (packet.kind === 'request' && packet.service === HOST_ACTIVATION_REPORT_SERVICE &&
        packet.payload?.state === 'active') reportId = packet.id;
      server.send(message);
    });
    server.onMessage(message => {
      const packet = JSON.parse(String(message));
      if (packet.kind === 'response' && packet.id === reportId) {
        reportId = undefined;
        lateTransport.delayedActivationReports++;
        console.log(JSON.stringify({ phase: 'late-join-host-activation-held', delayMs: 2500 }));
        timer = setTimeout(() => { timer = undefined; route.send(message); }, 2500);
      } else route.send(message);
    });
    route.onClose(() => { clearTimeout(timer); server.close(); });
    server.onClose(() => { clearTimeout(timer); route.close(); });
  });
}

async function openLateJoinClient(journey, endpoints) {
  const latePage = await openClientPage(journey);
  if (journey.chaosProxy !== undefined) journey.chaosProxy.markLateJoin();
  const lateTransport = { connections: 0, blockedConnection: undefined, ackDrops: 0, delayedActivationReports: 0 };
  await routeLateGameTransport(latePage, endpoints.connectionUrl, lateTransport);
  await holdLateHostActivation(latePage, endpoints.hostConnectionUrl, lateTransport);
  await latePage.goto(`${endpoints.base}?server=${endpoints.connectionUrl}${endpoints.hostQuery}&m16-reconnect=1`, { waitUntil: 'domcontentloaded' });
  await waitForBrowserReady(journey, latePage, 'late-join');
  assertSemantic(journey, 'late-join-host-activation-held', lateTransport.delayedActivationReports === 1,
    'the late client must complete one delayed native Host activation report');
  return { latePage, lateContext: latePage.context(), lateTransport };
}

async function proveLateJoinBaseline(journey, latePage, knownPlayerIds) {
  const cAppeared = await latePage.waitForFunction((known) => {
    const text = document.querySelector('[data-testid="snake-state"]')?.textContent ?? '';
    if (!text.startsWith('{')) return false;
    const value = JSON.parse(text);
    return value.snakes.some((snake) => !known.includes(snake.playerNetworkId));
  }, [...knownPlayerIds], { timeout: BROWSER_STARTUP_TIMEOUT_MS }).then(() => true).catch(() => false);
  if (!cAppeared) throw new Error(`c-baseline-identity: no new peer in ${JSON.stringify(await readState(latePage))}`);
  const cBaseline = await readState(latePage);
  const newPlayers = cBaseline.snakes.filter((snake) => !knownPlayerIds.has(snake.playerNetworkId));
  if (newPlayers.length !== 1) throw new Error(`c-baseline-identity: expected one newly joined player, got ${JSON.stringify(newPlayers)}`);
  const cIdentity = newPlayers[0].playerNetworkId;
  const cBaselineTuple = tuple(byPlayer(cBaseline, cIdentity));
  await waitForTick(journey, latePage, cBaseline.tick);
  const cDelta = await readState(latePage);
  assertSemantic(journey, 'c-baseline-identity', cBaselineTuple !== undefined && byPlayer(cBaseline, cIdentity)?.playerNetworkId === cIdentity,
    `C baseline missing for playerNetworkId ${cIdentity}`);
  assertSemantic(journey, 'c-post-baseline-delta', cDelta.tick > cBaseline.tick && byPlayer(cDelta, cIdentity) !== undefined,
    `C delta missing after baseline tick ${cBaseline.tick}`);
  console.log(JSON.stringify({ assertion: 'C baseline/delta', baseline: { tick: cBaseline.tick, tuple: cBaselineTuple }, delta: { tick: cDelta.tick, tuple: tuple(byPlayer(cDelta, cIdentity)) } }));
  journey.phases.push('late-join');
  return { cIdentity, cBaseline, cDelta };
}

async function proveAckTimeoutRecovery(journey, lateJoin, page, secondPage) {
  const { latePage, lateTransport } = lateJoin;
  const beforeAckLoss = await readRecoverySnapshot(latePage);
  lateTransport.blockedConnection = lateTransport.connections;
  await latePage.waitForFunction(previousEpoch => {
    const snapshot = globalThis.__forgeaxSnake?.snapshot();
    if (snapshot?.state.kind === 'failed') throw new Error(JSON.stringify(snapshot.state));
    return snapshot?.state.kind === 'active' && snapshot.epoch > previousEpoch;
  }, beforeAckLoss.epoch, { timeout: 10_000 });
  const afterAckLoss = await readRecoverySnapshot(latePage);
  const lateAckDrops = lateTransport.ackDrops;
  const lateConnections = lateTransport.connections;
  assertSemantic(journey, 'ack-timeout-recovery', lateAckDrops > 0 && lateConnections > lateTransport.blockedConnection &&
    afterAckLoss.sessionId === beforeAckLoss.sessionId && afterAckLoss.epoch > beforeAckLoss.epoch,
    `ACK loss must retire the old transport and recover the same SessionId: ${JSON.stringify({lateAckDrops,lateConnections,beforeAckLoss,afterAckLoss})}`);
  const afterAckLossState = await readState(latePage);
  assertSemantic(journey, 'ack-timeout-player-continuity', byPlayer(afterAckLossState, lateJoin.cIdentity) !== undefined,
    'the late player must retain logical identity after ACK timeout recovery');
  assertSemantic(journey, 'ack-timeout-isolation',
    (await readRecoverySnapshot(page)).state.kind === 'active' &&
    (await readRecoverySnapshot(secondPage)).state.kind === 'active',
    'the two healthy replica sessions must remain active after only C exhausts its ACK budget');
  console.log(JSON.stringify({assertion:'ACK timeout recovery',lateAckDrops,lateConnections,
    sessionId:afterAckLoss.sessionId,beforeEpoch:beforeAckLoss.epoch,afterEpoch:afterAckLoss.epoch}));
}

async function captureRhiDebugTape(page) {
  try {
    return await page.evaluate(async () => {
      const debug = window.__forgeax;
      if (debug === undefined) return { error: 'capture API unavailable' };
      // This oracle reads command structure, not replay pixels. Omit resource
      // seeds so diagnostic readback does not consume the live ACK retry budget.
      const result = await debug.captureFrame({ seed: { maxResourceBytes: 0 } });
      if (!result?.ok) return { error: result?.error ?? 'capture failed' };
      const runId = `snake-${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`;
      const response = await fetch(`${location.origin}/__forgeax-debug/tape?runId=${runId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-forgeax-rhitape' },
        body: new Blob([result.value.bytes], { type: 'application/x-forgeax-rhitape' }),
      });
      const artifact = await response.json();
      if (!response.ok) return { error: artifact };
      return { ...artifact, runId };
    });
  } catch (error) {
    return { error: String(error) };
  }
}

async function recoverRendererForCapture(page, capture) {
  if (!capture?.error?.detail?.cause?.includes('no device has been acquired')) return undefined;
  try {
    return await page.evaluate(async () => {
      const probe = globalThis.__forgeaxSnake;
      if (probe === undefined) return { outcome: { kind: 'probe-unavailable' } };
      const before = probe.rendererInspection();
      const outcome = await probe.recoverRenderer();
      return { before, outcome, after: probe.rendererInspection() };
    });
  } catch (error) {
    return { error: String(error) };
  }
}

async function summarizeRhiTape(candidate, capture) {
  const devkitCli = resolve(repositoryRoot, 'packages/devkit/dist/cli.mjs');
  const tapePath = capture.path;
  await access(tapePath);
  const summary = JSON.parse((await execFileAsync(
    process.execPath,
    [devkitCli, 'rhi', 'summary', '--artifact', tapePath, '--digest', capture.digest, '--json'],
    { maxBuffer: 2_000_000 },
  )).stdout);
  const inventory = summary.value?.summary;
  const totalWorks = Array.isArray(inventory?.works) ? inventory.works.length : 0;
  if (!summary.ok || totalWorks === 0) {
    throw new Error(`rhi-debug: summary did not expose captured work: ${JSON.stringify(summary)}`);
  }
  return {
    mode: 'structural',
    page: candidate.label,
    tapePath,
    digest: capture.digest,
    totalDraws: totalWorks,
    totalPasses: inventory?.passCount ?? 0,
  };
}

async function captureCandidateTape(candidate, captureFailures) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const capture = await captureRhiDebugTape(candidate.page);
    if (typeof capture?.path === 'string') return summarizeRhiTape(candidate, capture);
    const rendererRecovery = await recoverRendererForCapture(candidate.page, capture);
    captureFailures.push({
      page: candidate.label,
      attempt: attempt + 1,
      error: capture?.error ?? capture ?? { error: 'capture returned no result' },
      ...(rendererRecovery === undefined ? {} : { rendererRecovery }),
    });
    if (attempt < 1) await candidate.page.waitForTimeout(250 * (attempt + 1));
  }
  return undefined;
}

async function collectRhiDebugCapture(captureCandidates) {
  const captures = [];
  const captureFailures = [];
  for (const candidate of captureCandidates) {
    const capture = await captureCandidateTape(candidate, captureFailures);
    if (capture !== undefined) {
      captures.push(capture);
      break;
    }
  }
  if (captures.length !== 1)
    throw new Error(`rhi-debug: did not collect a color-draw capture: ${JSON.stringify(captureFailures)}`);
  console.log(JSON.stringify({ rhiDebugCapture: captures }));
}

async function startPublicRecovery(journey, page) {
  const recoveryBefore = await recordRecoverySample(journey, page, 'before-recover');
  journey.recoveryPackets.length = 0;
  journey.captureRecoveryPackets = true;
  if (journey.chaosProxy !== undefined && !journey.chaosProxy.disconnectSession(recoveryBefore.snapshot.sessionId))
    throw new Error('M17 proxy could not disconnect the browser primary session');
  const recoveryRequest = await page.evaluate(() => {
    const probe = globalThis.__forgeaxSnake;
    if (probe === undefined) return { outcome: { kind: 'missing-probe' }, snapshot: null };
    const outcome = probe.recover();
    const snapshot = probe.snapshot();
    const failure = snapshot.lastError;
    return { outcome, snapshot, failure: failure === undefined ? undefined : { code: failure.code, hint: failure.hint, detail: failure.detail } };
  });
  if (!['started', 'already-recovering'].includes(recoveryRequest.outcome.kind) || recoveryRequest.snapshot === null)
    throw new Error(`recovery: public recover() did not start: ${JSON.stringify(recoveryRequest)}`);
  const recovering = await recordRecoverySample(journey, page, 'recovering');
  if (recovering.snapshot.state.kind !== 'recovering') {
    const stateNode = await readStateNodeDatasets(page);
    throw new Error(`recovery: expected recovering state, got ${recovering.snapshot.state.kind}: ${JSON.stringify({ recoveryRequest, recovering, stateNode })}`);
  }
  return { recoveryBefore, recoveryRequest, recovering };
}

async function provePreBaselineRejection(page) {
  const preBaselineBeforeSendCount = await readSendCount(page);
  await page.keyboard.press('ArrowUp');
  const preBaselineAfterSendCount = await readSendCount(page);
  const preBaselineSnapshot = await readRecoverySnapshot(page);
  if (preBaselineSnapshot === null) throw new Error('recovery: public snapshot disappeared before baseline');
  const preBaselineAttempt = {
    state: preBaselineSnapshot.state.kind,
    beforeSendCount: preBaselineBeforeSendCount,
    afterSendCount: preBaselineAfterSendCount,
    accepted: preBaselineAfterSendCount > preBaselineBeforeSendCount,
  };
  if (preBaselineAttempt.accepted || preBaselineSnapshot.state.kind === 'active')
    throw new Error(`recovery: pre-baseline command was accepted: ${JSON.stringify(preBaselineAttempt)}`);
  return { preBaselineSnapshot, preBaselineAttempt };
}

async function installRecoveryObserver(page) {
  await page.evaluate(() => {
    const history = [];
    let previousKey = '';
    globalThis.__m16ResyncCommandAttempt = undefined;
    const capture = () => {
      const snapshot = globalThis.__forgeaxSnake?.snapshot();
      if (snapshot === undefined) return;
      const state = snapshot.state;
      const key = `${state.kind}:${snapshot.epoch}:${snapshot.sequence}:${state.kind === 'recovering' ? state.attempt : ''}`;
      if (key === previousKey || history.length >= 256) return;
      previousKey = key;
      const stateSnapshot = state.kind === 'recovering'
        ? { kind: state.kind, sessionId: state.sessionId, epoch: state.epoch, attempt: state.attempt }
        : state.kind === 'resyncing'
          ? { kind: state.kind, sessionId: state.sessionId, epoch: state.epoch }
          : state.kind === 'active'
            ? { kind: state.kind, sessionId: state.sessionId, epoch: state.epoch, sequence: state.sequence }
            : { kind: state.kind, sessionId: state.sessionId };
      history.push({
        sessionId: snapshot.sessionId,
        state: stateSnapshot,
        pendingPackets: snapshot.pendingPackets,
        maxPendingPackets: snapshot.maxPendingPackets,
        acknowledgedSequence: snapshot.acknowledgedSequence,
        reconnectAttempts: snapshot.reconnectAttempts,
        epoch: snapshot.epoch,
        sequence: snapshot.sequence,
        ownedResources: { ...snapshot.ownedResources },
      });
      if (state.kind === 'resyncing' && globalThis.__m16ResyncCommandAttempt === undefined) {
        const beforeSendCount = globalThis.__forgeaxSnake.directionCommandSendCount();
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          code: 'ArrowRight',
          bubbles: true,
        }));
        const afterSendCount = globalThis.__forgeaxSnake.directionCommandSendCount();
        globalThis.__m16ResyncCommandAttempt = {
          state: state.kind,
          epoch: snapshot.epoch,
          beforeSendCount,
          afterSendCount,
        };
      }
    };
    capture();
    globalThis.__m16RecoveryHistory = history;
    globalThis.__m16RecoveryObserver = window.setInterval(capture, 1);
    globalThis.__forgeaxSnake?.advanceRecovery();
  });
}

async function awaitResyncingState(journey, page) {
  try {
    await page.waitForFunction(
      () => (globalThis.__m16RecoveryHistory ?? []).some((sample) => sample.state.kind === 'resyncing'),
      undefined,
      { timeout: 15_000 },
    );
  } catch (error) {
    const snapshot = await readRecoverySnapshot(page);
    const stateNode = await readStateNodeDatasets(page);
    throw new Error(`recovery: resyncing state was not observed: ${JSON.stringify({ snapshot, stateNode, failure: snapshot?.lastError === undefined ? undefined : { code: snapshot.lastError.code, hint: snapshot.lastError.hint, detail: snapshot.lastError.detail }, authority: journey.authority.observations().slice(-12) })}`, { cause: error });
  }
  const resyncingSnapshot = await page.evaluate(() => (globalThis.__m16RecoveryHistory ?? []).find((sample) => sample.state.kind === 'resyncing') ?? null);
  if (resyncingSnapshot === null) throw new Error('recovery: resyncing observer sample disappeared');
  await page.waitForFunction(
    () => globalThis.__m16ResyncCommandAttempt !== undefined,
    undefined,
    { timeout: 15_000 },
  );
  const resyncCommandAttempt = await page.evaluate(() => globalThis.__m16ResyncCommandAttempt ?? null);
  const resyncing = await recordRecoverySample(journey, page, 'resyncing', resyncingSnapshot);
  const resyncEpoch = resyncing.snapshot.state.kind === 'resyncing' ? resyncing.snapshot.state.epoch : -1;
  if (resyncCommandAttempt === null || resyncCommandAttempt.state !== 'resyncing' ||
    resyncCommandAttempt.afterSendCount !== resyncCommandAttempt.beforeSendCount)
    throw new Error(`recovery: resyncing command was accepted: ${JSON.stringify(resyncCommandAttempt)}`);
  return { resyncing, resyncEpoch, resyncCommandAttempt };
}

async function awaitFirstActiveState(journey, page) {
  try {
    await page.waitForFunction(
      () => (globalThis.__m16RecoveryHistory ?? []).some((sample) => sample.state.kind === 'active'),
      undefined,
      { timeout: 15_000 },
    );
  } catch (error) {
    const snapshot = await readRecoverySnapshot(page);
    const history = await page.evaluate(() => globalThis.__m16RecoveryHistory ?? []);
    const stateNode = await readStateNodeDatasets(page);
    throw new Error(`recovery: active state was not observed: ${JSON.stringify({ snapshot, history, stateNode, authority: journey.authority.observations().slice(-12) })}`, { cause: error });
  }
  const firstActiveSnapshot = await page.evaluate(() => (globalThis.__m16RecoveryHistory ?? []).find((sample) => sample.state.kind === 'active') ?? null);
  await page.evaluate(() => {
    if (globalThis.__m16RecoveryObserver !== undefined) window.clearInterval(globalThis.__m16RecoveryObserver);
    delete globalThis.__m16RecoveryObserver;
  });
  if (firstActiveSnapshot === null) throw new Error('recovery: active observer sample disappeared');
  const firstActive = await recordRecoverySample(journey, page, 'active-after-baseline', firstActiveSnapshot);
  if (firstActive.snapshot.state.kind !== 'active')
    throw new Error(`recovery: expected active after baseline, got ${firstActive.snapshot.state.kind}`);
  return firstActive;
}

async function findRecoveryBaselinePacket(journey, firstActive) {
  await new Promise((resolve) => setImmediate(resolve));
  const baselinePacket = journey.recoveryPackets.find((packet) =>
    packet.kind === 'baseline' &&
    packet.epoch === firstActive.snapshot.epoch,
  );
  if (baselinePacket === undefined)
    throw new Error(`recovery: sequence-one baseline frame was not observed: ${JSON.stringify({ recoveryPackets: journey.recoveryPackets, firstActive: firstActive.snapshot })}`);
  return baselinePacket;
}

async function awaitRepopulatedScene(journey, page) {
  const postRecoveryCanvasAllowMismatch = journey.sabotage === 'visual-hide-body';
  try {
    await page.waitForFunction((allowMismatch) => {
      const node = document.querySelector('[data-testid="snake-state"]');
      const text = node?.textContent ?? '';
      if (!text.startsWith('{')) return false;
      const state = JSON.parse(text);
      const rendered = Number(node?.getAttribute('data-render-entity-count') ?? -1);
      const expected = state.snakes.reduce((total, snake) => total + snake.bodyLength, 0);
      // A dead snake is intentionally absent from the authoritative projection
      // until its bounded respawn delay elapses. Wait for the real projection
      // and render bridge to converge before taking the recovery oracle sample.
      return state.tick > 0 && state.snakes.length >= 2 && (allowMismatch || rendered === expected);
    }, postRecoveryCanvasAllowMismatch, { timeout: 10_000 });
  } catch (error) {
    const state = await readState(page).catch(() => null);
    const rendered = await stateNode(page).getAttribute('data-render-entity-count').catch(() => null);
    throw new Error(`recovery: authoritative scene did not repopulate after baseline: ${JSON.stringify({ state, rendered })}`, { cause: error });
  }
}

async function measureRecoveryConvergence(journey, page, firstActive) {
  const postRecoveryCanvas = await captureCanvasEvidence(journey, page, 'post-recovery');
  const postBaselineState = postRecoveryCanvas.state;
  if (postBaselineState.snakes.length < 2)
    throw new Error(`recovery: expected at least two live snakes after baseline: ${JSON.stringify(postBaselineState)}`);
  const identityTokens = postBaselineState.snakes.map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`);
  const playerTokens = postBaselineState.snakes.map((snake) => snake.playerNetworkId);
  const expectedRenderEntityCount = totalBodyLength(postBaselineState);
  const renderedEntityCount = postRecoveryCanvas.renderEntityCount;
  const convergence = {
    sessionId: firstActive.snapshot.sessionId,
    tick: postBaselineState.tick,
    identityCount: identityTokens.length,
    uniqueIdentityCount: new Set(identityTokens).size,
    playerCount: playerTokens.length,
    uniquePlayerCount: new Set(playerTokens).size,
    renderedEntities: renderedEntityCount,
    expectedEntities: expectedRenderEntityCount,
  };
  const authorityDerivedConvergence = convergence.uniqueIdentityCount === convergence.identityCount &&
    convergence.uniquePlayerCount === convergence.playerCount && convergence.renderedEntities === convergence.expectedEntities;
  if (!authorityDerivedConvergence && journey.sabotage !== 'visual-hide-body')
    throw new Error(`recovery: authority-derived convergence failed: ${JSON.stringify(convergence)}`);
  return { postBaselineState, identityTokens, expectedRenderEntityCount, renderedEntityCount, convergence, authorityDerivedConvergence };
}

async function proveContinuedInteraction(page, postBaselineState, page0Player) {
  const interactionSnake = byPlayer(postBaselineState, page0Player) ?? postBaselineState.snakes[0];
  if (interactionSnake === undefined) throw new Error('recovery: no live snake remained for continued interaction');
  const direction = onlineStep(interactionSnake, straightAhead(interactionSnake));
  const beforeSendCount = await readSendCount(page);
  const beforeTick = postBaselineState.tick;
  await page.keyboard.press(DIRECTION_KEYS[direction]);
  await page.waitForFunction(
    (previous) => Number(document.querySelector('[data-testid="snake-state"]')?.getAttribute('data-direction-command-send-count') ?? 0) > previous,
    beforeSendCount,
    { timeout: 5_000 },
  );
  await page.waitForFunction(
    ({ tick, playerNetworkId }) => {
      const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      return value.tick > tick && value.session?.lastDirectionCommandPlayerNetworkId === playerNetworkId;
    },
    { tick: beforeTick, playerNetworkId: page0Player },
    { timeout: 5_000 },
  );
  const afterState = await readState(page);
  const afterSendCount = await readSendCount(page);
  const accepted = afterState.tick > beforeTick && afterSendCount > beforeSendCount;
  if (!accepted) throw new Error('recovery: continued interaction did not advance after resync');
  return { direction, beforeTick, afterTick: afterState.tick, beforeSendCount, afterSendCount, accepted };
}

async function captureReconnectScreenshot(page, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  const screenshotPath = resolve(outputDirectory, `${RECONNECT_TARGET_ID}.png`);
  const screenshotBytes = await page.screenshot({ path: screenshotPath, fullPage: false });
  return inspectScreenshot(screenshotBytes, screenshotPath);
}

async function proveRecovery(journey, page, page0Player, outputDirectory) {
  const { recoveryBefore, recoveryRequest, recovering } = await startPublicRecovery(journey, page);
  const { preBaselineSnapshot, preBaselineAttempt } = await provePreBaselineRejection(page);
  await installRecoveryObserver(page);
  const { resyncing, resyncEpoch, resyncCommandAttempt } = await awaitResyncingState(journey, page);
  const firstActive = await awaitFirstActiveState(journey, page);
  const baselinePacket = await findRecoveryBaselinePacket(journey, firstActive);
  await awaitRepopulatedScene(journey, page);
  const measured = await measureRecoveryConvergence(journey, page, firstActive);
  const { postBaselineState, convergence } = measured;
  const interaction = await proveContinuedInteraction(page, postBaselineState, page0Player);
  const continuedBrowserOperation = journey.sabotage === 'freeze-after-recover' ? false : interaction.accepted;
  const screenshot = await captureReconnectScreenshot(page, outputDirectory);
  journey.recoveryLifecycle.push({
    label: 'pre-baseline-rejected',
    snapshot: preBaselineSnapshot,
    state: { tick: postBaselineState.tick, identities: measured.identityTokens, bodyLength: measured.expectedRenderEntityCount, renderEntityCount: measured.renderedEntityCount },
  });
  journey.phases.push('recovery');
  console.log(JSON.stringify({
    phase: 'recovery',
    before: recoveryBefore.snapshot,
    recovering: recovering.snapshot,
    resyncing: { ...resyncing.snapshot, epoch: resyncEpoch, rejectedSendCount: resyncCommandAttempt.afterSendCount },
    active: firstActive.snapshot,
    convergence,
    interaction: { beforeTick: interaction.beforeTick, afterTick: interaction.afterTick, beforeSendCount: interaction.beforeSendCount, afterSendCount: interaction.afterSendCount },
  }));
  return {
    recoveryBefore,
    recoveryRequest,
    preBaselineAttempt,
    resyncEpoch,
    firstActive,
    baselinePacket,
    convergence,
    authorityDerivedConvergence: measured.authorityDerivedConvergence,
    interaction,
    continuedBrowserOperation,
    screenshot,
  };
}

async function awaitLateRemoval(journey, cIdentity, cRemoved, disconnectBefore, authorityBeforeClose) {
  const observerPage = journey.contexts[0].pages()[0];
  try {
    const authorityAfterClose = await waitForAuthority(
      journey,
      (observation) => observation.peerIds.length < authorityBeforeClose.peerIds.length,
      'peer removal after C disconnect',
    );
    await observerPage.waitForFunction(({ tick, playerNetworkId }) => {
      const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
      return value.tick > tick && !value.snakes.some((snake) => snake.playerNetworkId === playerNetworkId);
    }, { tick: disconnectBefore.tick, playerNetworkId: cIdentity }, { timeout: 10_000 });
    if (cRemoved.size > 0) {
      await observerPage.waitForFunction(({ tick, removed }) => {
        const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
        const current = new Set(value.snakes.map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`));
        return value.tick > tick && [...removed].some((identity) => !current.has(identity));
      }, { tick: disconnectBefore.tick, removed: [...cRemoved] }, { timeout: 10_000 });
    }
    return authorityAfterClose;
  } catch (error) {
    const diagnostics = await stateNode(observerPage).evaluate((node) => ({
      state: node.textContent,
      datasets: { ...node.dataset },
    }));
    throw new Error(`disconnect: authority did not remove C: ${JSON.stringify({ cIdentity, cRemoved: [...cRemoved], diagnostics, authority: journey.authority.observations().slice(-20) })}`, { cause: error });
  }
}

async function proveLateDisconnect(journey, lateContext, cIdentity) {
  const authorityBeforeClose = await waitForAuthority(
    journey,
    (observation) => Array.isArray(observation.peerIds) && observation.peerIds.length >= 3,
    'three peers before C disconnect',
  );
  const disconnectBefore = await readState(journey.contexts[0].pages()[0]);
  // Incarnation IDs must be compared within the surviving receiver stream.
  const cRemoved = new Set(
    disconnectBefore.snakes
      .filter((snake) => snake.playerNetworkId === cIdentity)
      .map((snake) => `${snake.playerNetworkId}:${snake.networkEntityId}`),
  );
  journey.contexts.splice(journey.contexts.indexOf(lateContext), 1);
  await lateContext.close();
  const authorityAfterClose = await awaitLateRemoval(journey, cIdentity, cRemoved, disconnectBefore, authorityBeforeClose);
  const cAfterClose = await readState(journey.contexts[0].pages()[0]);
  const removedNow = [...cRemoved].filter((identity) => !identitySet(cAfterClose).has(identity));
  const cWasAbsentBeforeClose = !disconnectBefore.snakes.some((snake) => snake.playerNetworkId === cIdentity);
  const cEntityRemoval = cRemoved.size === 0 ? cWasAbsentBeforeClose : removedNow.some((identity) => identity.startsWith(`${cIdentity}:`));
  const cPlayerRemoved = !cAfterClose.snakes.some((snake) => snake.playerNetworkId === cIdentity);
  const peerRemoval = authorityAfterClose.peerIds.length < authorityBeforeClose.peerIds.length;
  assertSemantic(journey, 'c-disconnect-specific-removal', peerRemoval && cPlayerRemoved && cEntityRemoval,
    `C disconnect did not remove its peer/player state: ${JSON.stringify({ cIdentity, cRemoved: [...cRemoved], removedNow, cWasAbsentBeforeClose, peerRemoval })}`);
  console.log(JSON.stringify({
    assertion: 'C disconnect removal',
    before: [...cRemoved],
    removed: removedNow,
    cWasAbsentBeforeClose,
    authorityPeerIds: { before: authorityBeforeClose.peerIds, after: authorityAfterClose.peerIds },
    afterTick: cAfterClose.tick,
  }));
  journey.phases.push('disconnect');
}

function assertJourneyComplete(journey) {
  assertNamedPhases(journey.phases);
  assertSemantic(journey, 'normal-stable-control', journey.phases.length === REQUIRED_PHASES.length,
    `normal run did not complete all semantic phases: ${journey.phases.join(',')}`);
  if (journey.errors.length) throw new Error(`browser errors: ${journey.errors.join('; ')}`);
  if (journey.canvasEvidence.length !== 3)
    throw new Error('canvas-rendered did not capture both independent clients and the post-recovery frame');
}

async function retireClients(journey) {
  const clients = [];
  for (const context of journey.contexts) {
    const cleanupPage = context.pages()[0];
    if (cleanupPage === undefined) continue;
    clients.push(await cleanupPage.evaluate(() => {
      const probe = globalThis.__forgeaxSnake;
      if (probe === undefined) return { before: null, after: null };
      const before = probe.snapshot();
      probe.dispose();
      return { before, after: probe.snapshot() };
    }));
  }
  const allRetired = clients.length > 0 && clients.every((entry) => entry.after?.state.kind === 'retired');
  const allZeroOwnedResources = clients.length > 0 && clients.every((entry) =>
    entry.after !== null && Object.values(entry.after.ownedResources).every((value) => value === 0));
  return { clients, allRetired, allZeroOwnedResources };
}

function countWireIdentities(recoveryPackets) {
  const wireCounts = new Map();
  for (const packet of recoveryPackets) {
    const key = `${packet.epoch}:${packet.sequence}`;
    wireCounts.set(key, (wireCounts.get(key) ?? 0) + 1);
  }
  return wireCounts;
}

function locateFreshBaseline(recoveryPackets, freshEpoch, chaos) {
  const freshEpochIndex = recoveryPackets.findIndex((packet) =>
    packet.epoch === freshEpoch && packet.kind === 'baseline' && packet.sequence === 1,
  );
  const currentEpochDeltaIndex = recoveryPackets.findIndex((packet) =>
    packet.epoch === freshEpoch && packet.kind === 'delta',
  );
  const staleReplayEvent = chaos.events.find((event) => event.kind === 'out-of-order-stale-replay');
  const baselineOrder = freshEpochIndex >= 0 && currentEpochDeltaIndex > freshEpochIndex &&
    staleReplayEvent?.current?.kind === 'baseline' &&
    staleReplayEvent?.current?.sequence === 1 &&
    staleReplayEvent?.stale?.epoch < staleReplayEvent?.current?.epoch;
  return { freshEpochIndex, currentEpochDeltaIndex, staleReplayEvent, baselineOrder };
}

function assertChaosControls(journey, chaos, recovery, lateJoin, wireCounts, baselineOrder) {
  const { convergence, firstActive } = recovery;
  const { cBaseline, cDelta } = lateJoin;
  const disconnectRecovery = chaos.controls.disconnect.delivered > 0 &&
    firstActive.snapshot.epoch > recovery.recoveryBefore.snapshot.epoch &&
    journey.recoveryLifecycle.some((sample) => sample.snapshot.state.kind === 'recovering') &&
    journey.recoveryLifecycle.some((sample) => sample.snapshot.state.kind === 'resyncing');
  const duplicateWireIdentity = [...wireCounts.values()].some((count) => count > 1);
  const duplicateExactlyOnce = chaos.controls.duplicate.copies > 0 && duplicateWireIdentity &&
    convergence.uniqueIdentityCount === convergence.identityCount &&
    convergence.uniquePlayerCount === convergence.playerCount;
  const staleOutOfOrder = chaos.controls['out-of-order'].staleReplayed > 0 && baselineOrder;
  const delayedDelivery = chaos.controls['delayed-delivery'].delayedFrames > 0 &&
    chaos.controls['delayed-delivery'].maxDelayMs >= chaos.delayMs;
  const lateJoinBaseline = chaos.controls['late-join'].observed > 0 &&
    cBaseline.snakes.length > 0 && cDelta.tick > cBaseline.tick;
  assertSemantic(journey, 'm17-disconnect-recovery', disconnectRecovery,
    `disconnect=${JSON.stringify(chaos.controls.disconnect)} lifecycle=${JSON.stringify(journey.recoveryLifecycle)}`);
  assertSemantic(journey, 'm17-duplicate-exactly-once', duplicateExactlyOnce,
    `duplicate=${JSON.stringify(chaos.controls.duplicate)} wireCounts=${JSON.stringify([...wireCounts])}`);
  assertSemantic(journey, 'm17-out-of-order-baseline', staleOutOfOrder,
    `outOfOrder=${JSON.stringify(chaos.controls['out-of-order'])} recoveryPackets=${JSON.stringify(journey.recoveryPackets)}`);
  assertSemantic(journey, 'm17-delayed-delivery', delayedDelivery,
    `delayed=${JSON.stringify(chaos.controls['delayed-delivery'])}`);
  assertSemantic(journey, 'm17-late-join-baseline', lateJoinBaseline,
    `lateJoin=${JSON.stringify(chaos.controls['late-join'])} baseline=${JSON.stringify(cBaseline)} delta=${JSON.stringify(cDelta)}`);
}

async function assessChaosEvidence(journey, recovery, lateJoin, cleanup) {
  const chaos = journey.chaosProxy.snapshot();
  const wireCounts = countWireIdentities(journey.recoveryPackets);
  const freshEpoch = recovery.firstActive.snapshot.epoch;
  const fresh = locateFreshBaseline(journey.recoveryPackets, freshEpoch, chaos);
  assertChaosControls(journey, chaos, recovery, lateJoin, wireCounts, fresh.baselineOrder);
  await journey.chaosProxy.close();
  const { interaction } = recovery;
  return {
    controls: chaos.controls,
    recoveryPackets: journey.recoveryPackets,
    baseline: {
      epoch: freshEpoch,
      packet: recovery.baselinePacket,
      beforeDelta: fresh.currentEpochDeltaIndex > fresh.freshEpochIndex,
      staleReplayAfterFreshBaseline: fresh.staleReplayEvent?.current?.epoch === freshEpoch,
    },
    convergence: recovery.convergence,
    interaction: {
      accepted: interaction.accepted,
      beforeTick: interaction.beforeTick,
      afterTick: interaction.afterTick,
      beforeSendCount: interaction.beforeSendCount,
      afterSendCount: interaction.afterSendCount,
    },
    clientCleanup: { allRetired: cleanup.allRetired, allZeroOwnedResources: cleanup.allZeroOwnedResources },
    cleanup: journey.chaosProxy.snapshot(),
  };
}

function buildReconnectTrace(journey, invocationId, url, recovery, cleanup, chaosEvidence) {
  const { recoveryBefore, firstActive, interaction } = recovery;
  return {
    schemaVersion: 1,
    targetId: RECONNECT_TARGET_ID,
    invocationId,
    url,
    phases: [...journey.phases],
    errors: [...journey.errors],
    canvasEvidence: journey.canvasEvidence,
    recovery: {
      before: recoveryBefore,
      outcome: recovery.recoveryRequest.outcome,
      lifecycle: journey.recoveryLifecycle,
      preBaselineAttempt: recovery.preBaselineAttempt,
      baseline: {
        previousEpoch: recoveryBefore.snapshot.epoch,
        resyncEpoch: recovery.resyncEpoch,
        freshEpoch: firstActive.snapshot.epoch,
        firstActive: {
          sessionId: firstActive.snapshot.sessionId,
          epoch: firstActive.snapshot.epoch,
          sequence: firstActive.snapshot.sequence,
        },
        packet: recovery.baselinePacket,
      },
      convergence: recovery.convergence,
      interaction: {
        direction: interaction.direction,
        beforeTick: interaction.beforeTick,
        afterTick: interaction.afterTick,
        beforeSendCount: interaction.beforeSendCount,
        afterSendCount: interaction.afterSendCount,
        accepted: interaction.accepted,
      },
    },
    accounting: {
      maxPendingPackets: firstActive.snapshot.maxPendingPackets,
      maxObservedPendingPackets: Math.max(
        ...[recoveryBefore, ...journey.recoveryLifecycle].map((sample) => sample.snapshot.pendingPackets),
      ),
      samples: [recoveryBefore, ...journey.recoveryLifecycle].map((sample) => ({
        label: sample.label,
        pendingPackets: sample.snapshot.pendingPackets,
        ownedResources: sample.snapshot.ownedResources,
      })),
    },
    cleanup: {
      clients: cleanup.clients,
      allRetired: cleanup.allRetired,
      allZeroOwnedResources: cleanup.allZeroOwnedResources,
    },
    visual: {
      targetId: RECONNECT_TARGET_ID,
      screenshot: recovery.screenshot,
      checks: {
        authorityDerivedConvergence: recovery.authorityDerivedConvergence,
        continuedBrowserOperation: recovery.continuedBrowserOperation,
      },
    },
    ...(chaosEvidence === undefined ? {} : { chaos: chaosEvidence }),
  };
}

function logPublishedEvidence(published) {
  console.log(JSON.stringify({
    m16ReconnectEvidence: {
      targetId: RECONNECT_TARGET_ID,
      tracePath: published.tracePath,
      reportPath: published.reportPath,
      screenshot: published.report.screenshot,
      visualAssessment: published.report.visualAssessment,
      visualValidation: published.validation,
    },
  }));
}

// Keep the stdout marker below Vitest/gauntlet line limits. The full trace and
// screenshot report remain on disk; the marker needs only the controls,
// bounded packet tail, and cleanup/resource proof.
function logChaosEvidence(chaosEvidence) {
  const stdoutChaosEvidence = {
    ...chaosEvidence,
    recoveryPackets: chaosEvidence.recoveryPackets.slice(-64),
    cleanup: {
      ...chaosEvidence.cleanup,
      events: chaosEvidence.cleanup.events.slice(-16),
    },
  };
  console.log(JSON.stringify({ m17ChaosEvidence: stdoutChaosEvidence }));
}

/** Observes the production lifecycle up to two-peer gameplay; returns the initial client pages and player identities. */
async function startTwoPeerGameplay(journey, endpoints) {
  // Device startup in a shared GPU process can stall an existing replica's
  // frames past its ACK budget. Each real client owns its browser process.
  const initialPages = [await openClientPage(journey), await openClientPage(journey)];
  const [firstPage, secondPage] = initialPages;
  recordRecoveryPacketsFrom(journey, firstPage);
  const visualSabotage = process.env.SNAKE_SABOTAGE === 'visual-hide-body' ? '&visual-sabotage=hide-body' : '';
  const reconnectProbe = '&m16-reconnect=1';
  const clientUrl = `${endpoints.base}?server=${endpoints.connectionUrl}${endpoints.hostQuery}${reconnectProbe}${visualSabotage}`;
  const waitingState = await startPrimaryClient(journey, firstPage, clientUrl);
  await startSecondaryClientThroughStartupDisconnect(journey, secondPage, clientUrl, endpoints.connectionUrl);
  const firstGameplayState = await waitForGameplayStart(journey, firstPage, initialPages);
  assertSessionLifecycle(waitingState, firstGameplayState);
  const initialPlayerIds = new Set(
    (await Promise.all(journey.contexts.map((context) => readState(context.pages()[0]))))
      .flatMap((state) => state.snakes.map((snake) => snake.playerNetworkId)),
  );
  await assertJoinLifecycleMarkers(journey, journey.contexts[0].pages()[0]);
  await waitForTwoPeerSnapshots(journey);
  return { page: journey.contexts[0].pages()[0], secondPage, initialPlayerIds };
}

/** Join, input isolation, growth, death and respawn for page0; returns page0's player identity. */
async function runSinglePeerPhases(journey, page, initialPlayerIds) {
  // Join is proven by the renderer/join lifecycle markers and the first
  // two-peer snapshot; do not spend another authority tick before capturing
  // the short-lived fixture identities.
  journey.phases.push('join');
  console.log(JSON.stringify({ phase: 'join', tick: (await readState(page)).tick }));
  let page0Player;
  await runTickedPhase(journey, 'input-isolation', async () => {
    page0Player = await proveInputIsolation(journey, page, initialPlayerIds);
  });
  await runGrowthPhase(journey, page, page0Player);
  const death = await runDeathPhase(journey, page, page0Player);
  await runRespawnPhase(journey, page, page0Player, death);
  return page0Player;
}

async function runLateJoin(journey, endpoints, initialPlayerIds, page, secondPage) {
  const client = await openLateJoinClient(journey, endpoints);
  const baseline = await proveLateJoinBaseline(journey, client.latePage, initialPlayerIds);
  const lateJoin = { ...client, ...baseline };
  await proveAckTimeoutRecovery(journey, lateJoin, page, secondPage);
  await captureCanvasEvidence(journey, page, 'a');
  if (process.env.FORGEAX_ENGINE_RHI_DEBUG === '1') {
    await collectRhiDebugCapture([
      { label: 'primary', page },
      { label: 'late-join', page: lateJoin.latePage },
      { label: 'secondary', page: secondPage },
    ]);
  }
  await captureCanvasEvidence(journey, lateJoin.latePage, 'b');
  await page.waitForFunction((playerNetworkId) => {
    const value = JSON.parse(document.querySelector('[data-testid="snake-state"]')?.textContent ?? '{}');
    return value.snakes.some((snake) => snake.playerNetworkId === playerNetworkId);
  }, lateJoin.cIdentity, { timeout: 10_000 });
  return lateJoin;
}

async function publishAndJudge(journey, trace, invocationId, url, outputDirectory) {
  const published = await publishReconnectEvidence({
    trace,
    screenshot: trace.visual.screenshot,
    invocationId,
    url,
    outputDirectory,
  });
  logPublishedEvidence(published);
  if (journey.sabotage === 'visual-hide-body' || journey.sabotage === 'freeze-after-recover') {
    if (published.validation.ok) throw new Error(`recovery: ${journey.sabotage} did not falsify its visual expectation`);
    return 1;
  }
  if (process.env.FORGEAX_VISUAL_ASSESSMENT_PATH !== undefined && !published.validation.ok)
    throw new Error(`recovery: supplied visual assessment failed: ${JSON.stringify(published.validation.failures)}`);
  if (trace.chaos !== undefined) logChaosEvidence(trace.chaos);
  return 0;
}

async function runReconnectJourney(journey, invocationId, outputDirectory) {
  const endpoints = await startServices(journey);
  const { page, secondPage, initialPlayerIds } = await startTwoPeerGameplay(journey, endpoints);
  const page0Player = await runSinglePeerPhases(journey, page, initialPlayerIds);
  const lateJoin = await runLateJoin(journey, endpoints, initialPlayerIds, page, secondPage);
  const recovery = await proveRecovery(journey, page, page0Player, outputDirectory);
  await proveLateDisconnect(journey, lateJoin.lateContext, lateJoin.cIdentity);
  assertJourneyComplete(journey);
  const cleanup = await retireClients(journey);
  const chaosEvidence = journey.chaosProxy === undefined
    ? undefined
    : await assessChaosEvidence(journey, recovery, lateJoin, cleanup);
  const trace = buildReconnectTrace(journey, invocationId, page.url(), recovery, cleanup, chaosEvidence);
  const traceValidation = validateReconnectTrace(trace);
  trace.traceValidation = traceValidation;
  if (!traceValidation.ok)
    throw new Error(`recovery: structured trace validation failed: ${JSON.stringify(traceValidation.failures)}`);
  return publishAndJudge(journey, trace, invocationId, page.url(), outputDirectory);
}

async function main() {
  // Playwright's internal timeout handles are unref'ed. Keep this process alive
  // until a pending browser assertion either resolves or reports its timeout.
  const keepAlive = setInterval(() => {}, 1_000);
  const invocationId = createInvocationId();
  const outputDirectory = resolve(process.env.FORGEAX_VISUAL_EVIDENCE_DIR || defaultEvidenceDirectory);
  const journey = createJourney();
  try {
    return await runReconnectJourney(journey, invocationId, outputDirectory);
  } catch (error) {
    console.error(error);
    return 1;
  } finally {
    clearInterval(keepAlive);
    await releaseJourney(journey);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
