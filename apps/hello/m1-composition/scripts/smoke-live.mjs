#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const remoteLive = resolve(root, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
const devLive = resolve(root, 'scripts/dev-live.mjs');
const appPackage = '@forgeax/hello-m1-composition';
const bridgePort = process.env.FORGEAX_ENGINE_BRIDGE_PORT ?? '5733';
const artifactPath = process.env.FORGEAX_M19_ARTIFACT_DIR ?? process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
const artifactDir = artifactPath ? resolve(artifactPath) : undefined;
if (artifactDir) mkdirSync(artifactDir, { recursive: true });

const evidence = {
  browser: undefined,
  url: undefined,
  focusLoss: undefined,
  baseline: undefined,
  mutation: undefined,
  recovery: undefined,
  m19: {},
  screenshots: {},
  pageErrors: [],
  failure: undefined,
};

function writeEvidence() {
  if (!artifactDir) return;
  writeFileSync(resolve(artifactDir, 'm19-browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

function log(message) {
  console.log(`[m1-live] ${message}`);
}

function logM19(message) {
  console.log(`[m19-input] ${message}`);
}

async function runRemote(args) {
  const result = await execFileAsync(process.execPath, [remoteLive, ...args], {
    cwd: root,
    env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: bridgePort },
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = result.stdout.trim();
  log(`remote ${args[0] === '--health' ? 'health' : 'eval'}: ${output.replaceAll('\n', ' ')}`);
  return JSON.parse(output);
}

async function runHeadlessSemanticGate() {
  const result = await execFileAsync('pnpm', ['--filter', appPackage, 'smoke'], {
    cwd: root,
    maxBuffer: 2 * 1024 * 1024,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function startDevLive() {
  const child = spawn(process.execPath, [devLive, appPackage], {
    cwd: root,
    env: { ...process.env, FORGEAX_ENGINE_BRIDGE_PORT: bridgePort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(`[dev-live] ${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stderr.write(`[dev-live:err] ${text}`);
  });
  return { child, output: () => output };
}

async function waitForUrl(stack) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const match = stack.output().match(/Local:\s+(http:\/\/[^\s]+)/);
    if (match) return match[1];
    if (stack.child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`dev-live did not publish a Vite URL: ${stack.output()}`);
}

function assertEnvelope(envelope, label) {
  if (!envelope?.ok) throw new Error(`${label} failed: ${envelope?.error?.code ?? 'unknown'}`);
  return envelope.value;
}

async function readM19(label) {
  return assertEnvelope(
    await runRemote([
      "const input=world.getResource('m19LiveInput'); return {keyboardDown:input.keyboardDown,keyboardJustPressed:input.keyboardJustPressed,keyboardJustReleased:input.keyboardJustReleased,mouseHeld:input.mouseHeld,mouseJustPressed:input.mouseJustPressed,mouseJustReleased:input.mouseJustReleased,pointerLocked:input.pointerLocked,pointerActiveCount:input.pointerActiveCount,pointerEvents:[...input.pointerEvents],pointerPhaseLog:[...input.pointerPhaseLog],gesture:{...input.gesture},gestureEvents:[...input.gestureEvents],gestureLog:[...input.gestureLog],gamepad:{...input.gamepad},edgeLog:[...input.edgeLog]};",
    ]),
    label,
  );
}

async function waitForM19(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await readM19(label);
    if (predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

async function waitForPageState(page, predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await page.evaluate(() => ({
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      pointerLocked: document.pointerLockElement !== null,
      focusTransitions: globalThis.__m19InputProbe?.focusTransitions() ?? [],
      pointerLockTransitions: globalThis.__m19InputProbe?.pointerLockTransitions() ?? [],
    }));
    if (predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

function requireEvidence(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

async function capture(page, name) {
  if (!artifactDir) return;
  const path = resolve(artifactDir, `${name}.png`);
  await page.screenshot({ path });
  evidence.screenshots[name] = path;
}

const stack = startDevLive();
let browser;
let context;
let page;
let cdp;
let browserProfile;
try {
  await runHeadlessSemanticGate();
  const url = await waitForUrl(stack);
  evidence.url = url;
  log(`browser URL: ${url}`);
  browserProfile = await mkdtemp(resolve(tmpdir(), 'forgeax-m19-chrome-'));
  context = await chromium.launchPersistentContext(browserProfile, {
    headless: false,
    channel: 'chrome',
    ignoreDefaultArgs: ['--no-startup-window'],
    viewport: { width: 800, height: 600 },
    args: ['--enable-unsafe-webgpu', '--enable-pointer-lock', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  browser = context.browser();
  page = context.pages()[0] ?? (await context.newPage());
  cdp = await context.newCDPSession(page);
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, (_, index) => ({ value: 0, pressed: false }));
    const gamepad = {
      id: 'ForgeaX M19 browser probe',
      index: 0,
      connected: true,
      mapping: 'standard',
      buttons,
      axes: [0, 0, 0, 0],
      timestamp: 0,
    };
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => [gamepad],
    });
    const originalRequestPointerLock = HTMLCanvasElement.prototype.requestPointerLock;
    let requestPointerLockCalls = 0;
    const pointerLockErrors = [];
    if (originalRequestPointerLock) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'requestPointerLock', {
        configurable: true,
        value: function (...args) {
          requestPointerLockCalls += 1;
          const result = originalRequestPointerLock.apply(this, args);
          result?.catch?.((error) => pointerLockErrors.push(String(error)));
          return result;
        },
      });
    }
    document.addEventListener('pointerlockerror', () => pointerLockErrors.push('pointerlockerror'));
    const focusTransitions = [];
    window.addEventListener('blur', () => focusTransitions.push({ kind: 'blur', visibilityState: document.visibilityState }));
    window.addEventListener('focus', () => focusTransitions.push({ kind: 'focus', visibilityState: document.visibilityState }));
    document.addEventListener('visibilitychange', () => focusTransitions.push({ kind: document.visibilityState, visibilityState: document.visibilityState }));
    const pointerLockTransitions = [];
    document.addEventListener('pointerlockchange', () =>
      pointerLockTransitions.push({ locked: document.pointerLockElement !== null }),
    );
    const originalExitPointerLock = document.exitPointerLock?.bind(document);
    let exitPointerLockCalls = 0;
    Object.defineProperty(document, 'exitPointerLock', {
      configurable: true,
      value: () => {
        exitPointerLockCalls += 1;
        return originalExitPointerLock?.();
      },
    });
    globalThis.__m19InputProbe = {
      setGamepadPressed(pressed) {
        gamepad.buttons[0] = { value: pressed ? 1 : 0, pressed };
      },
      exitPointerLockCalls() {
        return exitPointerLockCalls;
      },
      requestPointerLockCalls() {
        return requestPointerLockCalls;
      },
      pointerLockErrors() {
        return [...pointerLockErrors];
      },
      focusTransitions() {
        return [...focusTransitions];
      },
      pointerLockTransitions() {
        return [...pointerLockTransitions];
      },
    };
  });
  evidence.browser = {
    version: await browser.version(),
    userAgent: await page.evaluate(() => navigator.userAgent),
    headed: true,
    gamepadProbe: 'navigator.getGamepads override at the public browser boundary; no InputSnapshot injection',
  };
  const pageErrors = evidence.pageErrors;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.startsWith('phase=play'), null, { timeout: 30000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    document.title = 'forgeax-m19-focus-probe';
  });
  evidence.browser.windowDriver = 'native Chrome window minimization via CDP';

  assertEnvelope(await runRemote(['--health']), 'remote health');
  const baseline = assertEnvelope(
    await runRemote([
      "const phase=world.getResource('m1LivePhase'); const frames=world.getResource('m1LiveFrames'); const fixed=world.getResource('m1LiveFixedTicks'); const input=world.getResource('m1LiveInput'); const m19=world.getResource('m19LiveInput'); const plugin=world.getResource('m1LivePluginBuilt'); const root=world.getResource('m1LiveRoot'); return {phase:phase.value,frames:frames.value,fixed:fixed.value,input:{...input},m19:{...m19,edgeLog:[...m19.edgeLog]},plugin:plugin.value,entities:world.inspect().entityCount,children:Array.from(world.iterDescendants(root)).length};",
    ]),
    'live baseline',
  );
  evidence.baseline = baseline;
  requireEvidence(baseline.phase === 'play' && baseline.entities >= 4 && baseline.children === 1 && baseline.plugin === true, 'unexpected live baseline', baseline);

  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  const mutation = assertEnvelope(
    await runRemote([
      "const ecs=await _import('@forgeax/engine-ecs'); const position=world.getResource('m1LivePosition'); const before=position.x; world.insertResource('m1LivePosition',{...position,x:before+0.5}); const after=world.getResource('m1LivePosition'); return {setOk:true,before,after:after.x,input:{...world.getResource('m1LiveInput')},fixed:world.getResource('m1LiveFixedTicks').value,hasEntity:ecs.Entity !== undefined};",
    ]),
    'live mutation',
  );
  evidence.mutation = mutation;
  requireEvidence(mutation.setOk && mutation.after === mutation.before + 0.5 && mutation.hasEntity === true, 'live mutation did not read back', mutation);

  const recovery = assertEnvelope(
    await runRemote([
      "const invalid=world.update(-1); const phase=world.getResource('m1LivePhase'); const frames=world.getResource('m1LiveFrames'); return {error:invalid.ok?null:invalid.error.code,phase:phase.value,frames:frames.value,entities:world.inspect().entityCount};",
    ]),
    'live recovery',
  );
  evidence.recovery = recovery;
  requireEvidence(recovery.error && recovery.phase === 'play' && recovery.entities === baseline.entities, 'live recovery invariant failed', recovery);

  await page.evaluate(() => globalThis.__m19InputProbe.setGamepadPressed(true));
  await waitForM19((input) => input.gamepad.held, 'gamepad held');
  await page.bringToFront();
  await page.locator('#app').click({ position: { x: 400, y: 300 } });
  try {
    await waitForPageState(page, (state) => state.pointerLocked, 'pointer lock acquisition');
  } catch (error) {
    evidence.m19.lockDiagnostic = await page.evaluate(() => {
      const canvas = document.querySelector('#app');
      const rect = canvas?.getBoundingClientRect();
      return {
        canvas: canvas
          ? {
              tag: canvas.tagName,
              rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
              requestPointerLock: typeof canvas.requestPointerLock,
            }
          : null,
        document: {
          hasFocus: document.hasFocus(),
          visibilityState: document.visibilityState,
          pointerLockElement: document.pointerLockElement?.tagName ?? null,
        },
        probe: {
          requestPointerLockCalls: globalThis.__m19InputProbe.requestPointerLockCalls(),
          pointerLockErrors: globalThis.__m19InputProbe.pointerLockErrors(),
          exitPointerLockCalls: globalThis.__m19InputProbe.exitPointerLockCalls(),
        },
      };
    });
    await capture(page, 'm19-lock-failure');
    logM19(`lock diagnostic: ${JSON.stringify(evidence.m19.lockDiagnostic)}`);
    throw error;
  }
  await page.keyboard.down('w');
  await page.mouse.down();
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { id: 101, x: 250, y: 240, radiusX: 1, radiusY: 1, force: 1 },
      { id: 102, x: 350, y: 240, radiusX: 1, radiusY: 1, force: 1 },
    ],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { id: 101, x: 220, y: 240, radiusX: 1, radiusY: 1, force: 1 },
      { id: 102, x: 380, y: 240, radiusX: 1, radiusY: 1, force: 1 },
    ],
  });
  const beforeLoss = await waitForM19(
    (input) =>
      input.keyboardDown &&
      input.mouseHeld &&
      input.pointerLocked &&
      input.pointerActiveCount >= 3 &&
      input.gamepad.held &&
      input.pointerPhaseLog.some((event) => event.endsWith(':down')) &&
      input.pointerPhaseLog.some((event) => event.endsWith(':move')) &&
      input.gestureLog.includes('pinch-begin') &&
      input.gesture.pinchScale !== 1 &&
      input.edgeLog.includes('keyboard:justPressed') &&
      input.edgeLog.includes('mouse:justPressed') &&
      input.edgeLog.includes('gamepad:justPressed'),
    'all held input acquired',
  );
  evidence.m19.beforeLoss = beforeLoss;
  await capture(page, 'm19-before-loss');

  const focusedBefore = await page.evaluate(() => ({
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    pointerLocked: document.pointerLockElement !== null,
    focusTransitions: globalThis.__m19InputProbe.focusTransitions(),
    pointerLockTransitions: globalThis.__m19InputProbe.pointerLockTransitions(),
  }));
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await sleep(300);
  const focusLoss = await waitForPageState(
    page,
    (state) =>
      state.visibilityState === 'hidden' ||
      state.hasFocus === false ||
      state.focusTransitions.length > focusedBefore.focusTransitions.length ||
      state.pointerLockTransitions.length > focusedBefore.pointerLockTransitions.length,
    'real blur, hidden, or pointer-lock exit transition',
  );
  evidence.focusLoss = {
    focusedBefore,
    focusLoss,
    transition: focusLoss.focusTransitions.some((event) => event.kind === 'hidden')
      ? 'hidden'
      : focusLoss.focusTransitions.some((event) => event.kind === 'blur')
        ? 'blur'
        : 'pointer-lock-exit',
    driver: 'native Chrome window minimization; browser pointer-lock exit is observed at the M1 document boundary',
  };
  requireEvidence(focusLoss.pointerLocked === false, 'pointer lock survived the real focus boundary', focusLoss);

  // The backend has already discarded the physical frame. Do not inject
  // cleanup key-up/pointer-up events while Chrome is minimized: automation
  // reports document.hasFocus() as true for those synthetic releases.
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  await page.bringToFront();
  await sleep(300);
  await page.bringToFront();
  await waitForPageState(page, (state) => state.visibilityState === 'visible' && state.hasFocus, 'focus reacquisition');
  await page.waitForTimeout(200);

  const afterLoss = await waitForM19(
    (input) =>
      !input.keyboardDown &&
      !input.mouseHeld &&
      !input.pointerLocked &&
      input.pointerActiveCount === 0 &&
      input.gesture.pinchScale === 1 &&
      input.gamepad.held &&
      input.pointerPhaseLog.filter((event) => event.endsWith(':cancel')).length >= 3 &&
      input.gestureLog.includes('pinch-cancel') &&
      input.edgeLog.length === beforeLoss.edgeLog.length,
    'focus-loss cancellation and clean baseline',
  );
  evidence.m19.afterLoss = afterLoss;
  const exitCalls = await page.evaluate(() => globalThis.__m19InputProbe.exitPointerLockCalls());
  evidence.m19.exitPointerLockCalls = exitCalls;
  evidence.m19.focusReset = 'public InputSnapshot state was observed after real page focus transition';
  await capture(page, 'm19-after-loss');

  const idleAfterLoss = await readM19('post-focus idle');
  requireEvidence(idleAfterLoss.edgeLog.length === afterLoss.edgeLog.length, 'reacquisition emitted a stale edge without new input', idleAfterLoss);
  requireEvidence(idleAfterLoss.gamepad.held && !idleAfterLoss.gamepad.justPressed && !idleAfterLoss.gamepad.justReleased, 'held gamepad emitted a stale post-focus edge', idleAfterLoss);

  const edgeBase = afterLoss.edgeLog.length;
  await page.evaluate(() => globalThis.__m19InputProbe.setGamepadPressed(false));
  const released = await waitForM19(
    (input) => input.edgeLog.slice(edgeBase).includes('gamepad:justReleased'),
    'new gamepad release edge',
  );
  await page.evaluate(() => globalThis.__m19InputProbe.setGamepadPressed(true));
  const pressedAgain = await waitForM19(
    (input) => input.edgeLog.slice(edgeBase).includes('gamepad:justPressed'),
    'new gamepad press edge',
  );
  await page.bringToFront();
  await page.locator('#app').click({ position: { x: 400, y: 300 } });
  await waitForPageState(page, (state) => state.pointerLocked, 'pointer lock reacquisition');
  await page.keyboard.down('w');
  await page.mouse.down();
  const newInput = await waitForM19(
    (input) =>
      input.keyboardDown &&
      input.mouseHeld &&
      input.pointerLocked &&
      input.edgeLog.slice(edgeBase).includes('keyboard:justPressed') &&
      input.edgeLog.slice(edgeBase).includes('mouse:justPressed'),
    'new keyboard and pointer edges after reacquisition',
  );
  evidence.m19.reacquire = { idleAfterLoss, released, pressedAgain, newInput };
  await capture(page, 'm19-reacquired');
  requireEvidence(newInput.edgeLog.length > edgeBase, 'new input produced no new edge', newInput);
  logM19(`PASS - focus loss cancelled held input, gestures, and pointer lock; reacquisition required new edges: ${JSON.stringify({ beforeLoss: beforeLoss.edgeLog, afterLoss: afterLoss.edgeLog, reacquire: newInput.edgeLog.slice(edgeBase) })}`);

  if (pageErrors.length > 0) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`);
  log(`PASS - live baseline=${JSON.stringify(baseline)} mutation=${JSON.stringify(mutation)} recovery=${JSON.stringify(recovery)}`);
} catch (error) {
  evidence.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
} finally {
  writeEvidence();
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (browserProfile) await rm(browserProfile, { recursive: true, force: true }).catch(() => {});
  if (stack.child.exitCode === null) stack.child.kill('SIGTERM');
}
