#!/usr/bin/env node
// Real Chrome/WebGPU/Web Audio smoke for hello-audio.
// The probe exercises the consumer path: an actual key gesture resumes the
// AudioContext, spacebar reaches declarative AudioSource playback, a falling
// physics actor triggers a second spatial source on collision, and despawn
// returns the backend to zero active sources.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { AUDIO_GESTURE_READY_STATES } from './browser-readiness.mjs';
import { extractViteLocalUrl } from './vite-local-url.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(REPO_ROOT, 'apps', 'hello', 'audio', '.forgeax-audio', 'browser');
const M20_MODE = process.env.FORGEAX_AUDIO_M20 === '1';
const M54_MODE = process.env.FORGEAX_AUDIO_M54 === '1';
mkdirSync(ARTIFACT_DIR, { recursive: true });
const READINESS_TIMEOUT_MS = Number.parseInt(
  process.env.FORGEAX_AUDIO_READINESS_TIMEOUT_MS ?? '90000',
  10,
);

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-audio', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  // pnpm owns a Vite child. Put the whole dev-server tree in its own POSIX
  // process group so a successful browser probe cannot leave the grandchild
  // holding the smoke command open after the direct pnpm process is signalled.
  detached: process.platform !== 'win32',
});
const WATCHDOG_MS = 180_000;
const watchdog = setTimeout(() => {
  console.error(`[smoke-browser] FAIL - watchdog exceeded ${WATCHDOG_MS / 1000}s`);
  viteProc.kill('SIGKILL');
  process.exit(124);
}, WATCHDOG_MS);
let portUrl;
let viteOutput = '';
let viteSpawnError;
viteProc.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  viteOutput += text;
  process.stdout.write(`[vite] ${text}`);
  portUrl ??= extractViteLocalUrl(viteOutput);
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
viteProc.once('error', (error) => {
  viteSpawnError = error;
});

function countChangedPixels(beforePath, afterPath) {
  const before = PNG.sync.read(readFileSync(beforePath));
  const after = PNG.sync.read(readFileSync(afterPath));
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`screenshots have different sizes: ${before.width}x${before.height} vs ${after.width}x${after.height}`);
  }
  let changed = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta = Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0))
      + Math.abs((before.data[i + 1] ?? 0) - (after.data[i + 1] ?? 0))
      + Math.abs((before.data[i + 2] ?? 0) - (after.data[i + 2] ?? 0));
    if (delta > 12) changed++;
  }
  return changed;
}

async function closeWithTimeout(label, close, timeoutMs = 5_000) {
  let timedOut = false;
  try {
    await Promise.race([
      close(),
      sleep(timeoutMs).then(() => {
        timedOut = true;
      }),
    ]);
  } catch (error) {
    console.error(`[smoke-browser] ${label} close failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (timedOut) {
    console.error(`[smoke-browser] ${label} close exceeded ${timeoutMs}ms`);
    return false;
  }
  return true;
}

function viteExited() {
  return viteProc.exitCode !== null || viteProc.signalCode !== null;
}

function signalVite(signal) {
  if (viteProc.pid === undefined) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-viteProc.pid, signal);
    } else {
      viteProc.kill(signal);
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function stopVite() {
  if (viteExited()) return;
  signalVite('SIGTERM');
  await Promise.race([
    new Promise((resolve) => viteProc.once('exit', resolve)),
    sleep(2_000),
  ]);
  if (viteExited()) return;
  console.error('[smoke-browser] vite did not exit after SIGTERM; forcing SIGKILL');
  signalVite('SIGKILL');
  await sleep(300);
}

async function readPageDiagnostics(page) {
  try {
    return await Promise.race([
      page.evaluate(() => ({
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        bodyText: document.body?.innerText?.slice(0, 2_000) ?? '',
        overlay: document.querySelector('#overlay')?.textContent ?? null,
        physics: document.querySelector('#physics-status')?.textContent ?? null,
        audio: document.querySelector('#audio-status')?.textContent ?? null,
        canvas: (() => {
          const canvas = document.querySelector('#app');
          return canvas instanceof HTMLCanvasElement
            ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight }
            : null;
        })(),
        capabilities: {
          webgpu: 'gpu' in navigator,
          audioContext: 'AudioContext' in window || 'webkitAudioContext' in window,
        },
        m54: window.__forgeaxM54Audio?.snapshot() ?? null,
      })),
      sleep(2_000).then(() => ({ evaluate: 'timed out after 2000ms' })),
    ]);
  } catch (error) {
    return { evaluate: error instanceof Error ? error.message : String(error) };
  }
}

let failed = false;
try {
  const readinessStartedAt = Date.now();
  while (!portUrl && viteSpawnError === undefined && !viteExited() && Date.now() - readinessStartedAt < READINESS_TIMEOUT_MS) {
    await sleep(200);
  }
  const readinessDiagnostics = JSON.stringify({
    elapsedMs: Date.now() - readinessStartedAt,
    pid: viteProc.pid ?? null,
    exitCode: viteProc.exitCode,
    signalCode: viteProc.signalCode,
    spawnError: viteSpawnError === undefined ? null : String(viteSpawnError),
    output: viteOutput.trim() || 'none',
  });
  if (viteSpawnError !== undefined) throw new Error(`vite failed to start; diagnostics=${readinessDiagnostics}`);
  if (!portUrl) throw new Error(`vite did not become ready within ${READINESS_TIMEOUT_MS}ms; diagnostics=${readinessDiagnostics}`);
  portUrl = portUrl.replace(/\/$/, '');

  const browser = await chromium.launch({
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    timeout: 30_000,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
      '--autoplay-policy=user-gesture-required',
    ],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    if (M54_MODE) {
      await page.addInitScript(() => {
        const audioContext = window.AudioContext;
        if (audioContext === undefined) return;
        const originalResume = audioContext.prototype.resume;
        const state = {
          resumeAttempts: 0,
          firstRefusal: false,
          contextIds: [],
          context: undefined,
        };
        const contextIds = new WeakMap();
        let nextContextId = 1;
        const originalCreateGain = audioContext.prototype.createGain;
        Object.defineProperty(audioContext.prototype, 'createGain', {
          configurable: true,
          value: function instrumentedCreateGain(...args) {
            state.context = this;
            return originalCreateGain.apply(this, args);
          },
        });
        Object.defineProperty(audioContext.prototype, 'resume', {
          configurable: true,
          value: function instrumentedResume(...args) {
            state.resumeAttempts += 1;
            let contextId = contextIds.get(this);
            if (contextId === undefined) {
              contextId = nextContextId++;
              contextIds.set(this, contextId);
            }
            state.contextIds.push(contextId);
            if (state.resumeAttempts === 1) {
              state.firstRefusal = true;
              return Promise.reject(new DOMException('deterministic M54 refusal', 'NotAllowedError'));
            }
            return originalResume.apply(this, args);
          },
        });
        window.__forgeaxM54Audio = {
          async suspend() {
            if (state.context === undefined) return null;
            await state.context.suspend();
            return state.context.state;
          },
          snapshot() {
            return {
              resumeAttempts: state.resumeAttempts,
              firstRefusal: state.firstRefusal,
              contextIds: [...state.contextIds],
              contextState: state.context?.state ?? null,
            };
          },
        };
      });
    }
    if (M20_MODE) {
      await page.addInitScript(() => {
        const audioContext = window.AudioContext;
        if (audioContext === undefined) return;
        const prototype = audioContext.prototype;
        const originalDecode = prototype.decodeAudioData;
        const state = {
          armed: false,
          started: 0,
          released: 0,
          resolved: 0,
          sourceStarts: 0,
          pending: false,
          releaseRequested: false,
        };
        let releaseHeld;

        const originalCreateBufferSource = prototype.createBufferSource;
        Object.defineProperty(prototype, 'createBufferSource', {
          configurable: true,
          value: function instrumentedCreateBufferSource(...args) {
            const node = originalCreateBufferSource.apply(this, args);
            const originalStart = node.start.bind(node);
            Object.defineProperty(node, 'start', {
              configurable: true,
              value: function instrumentedStart(...startArgs) {
                state.sourceStarts += 1;
                return originalStart(...startArgs);
              },
            });
            return node;
          },
        });

        Object.defineProperty(prototype, 'decodeAudioData', {
          configurable: true,
          value: function delayedDecode(arrayBuffer, ...callbacks) {
            const decoded = originalDecode.call(this, arrayBuffer, ...callbacks);
            if (!state.armed) return decoded;
            state.armed = false;
            state.started += 1;
            state.pending = true;
            return new Promise((resolve, reject) => {
              decoded.then(
                (buffer) => {
                  const complete = () => {
                    state.pending = false;
                    state.resolved += 1;
                    resolve(buffer);
                  };
                  if (state.releaseRequested) complete();
                  else releaseHeld = complete;
                },
                (error) => {
                  state.pending = false;
                  reject(error);
                },
              );
            });
          },
        });

        window.__forgeaxM20DecodeGate = {
          arm() {
            state.armed = true;
            state.releaseRequested = false;
          },
          release() {
            state.released += 1;
            state.releaseRequested = true;
            releaseHeld?.();
            releaseHeld = undefined;
          },
          snapshot() {
            return { ...state };
          },
        };
      });
    }
    const pageErrors = [];
    const consoleErrors = [];
    const consoleMessages = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
      console.error(`[smoke-browser] pageerror: ${error.message}`);
    });
    page.on('console', (message) => {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
      if (message.type() === 'error' && !message.text().includes('404')) {
        consoleErrors.push(message.text());
        console.error(`[smoke-browser] console-error: ${message.text()}`);
      }
    });

    try {
      // Vite/live traffic can remain active after the application is ready.
      // The following overlay and audio-state gates own runtime readiness.
      await page.goto(`${portUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForFunction(
        () => document.querySelector('#overlay')?.textContent?.includes('distance ='),
        undefined,
        { timeout: READINESS_TIMEOUT_MS, polling: 100 },
      );
      await page.waitForFunction(
        (readyStates) => {
          const text = document.querySelector('#audio-status')?.textContent ?? '';
          return readyStates.some((state) => text.includes(state));
        },
        AUDIO_GESTURE_READY_STATES,
        { timeout: READINESS_TIMEOUT_MS, polling: 100 },
      );
    } catch (error) {
      const diagnostics = await readPageDiagnostics(page);
      const recentConsole = consoleMessages.slice(-20);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(diagnostics)}; pageErrors=${JSON.stringify(pageErrors)}; console=${JSON.stringify(recentConsole)}`);
    }

    const initialStatus = await page.locator('#audio-status').textContent();
    const initialOverlay = await page.locator('#overlay').textContent();
    const beforePath = resolve(ARTIFACT_DIR, 'before-gesture.png');
    await page.screenshot({ path: beforePath });

    if (M20_MODE) {
      const m20BeforePath = resolve(ARTIFACT_DIR, 'm20-before-gate.png');
      const m20StalePath = resolve(ARTIFACT_DIR, 'm20-stale-stopped.png');
      const m20RecoveredPath = resolve(ARTIFACT_DIR, 'm20-recovered.png');
      await page.screenshot({ path: m20BeforePath });

      const baseline = await page.evaluate(() => window.__forgeaxAudioM20?.snapshot());
      await page.evaluate(() => window.__forgeaxM20DecodeGate?.arm());
      await page.evaluate(() => window.__forgeaxAudioM20?.begin());
      await page.waitForFunction(
        () => {
          const gate = window.__forgeaxM20DecodeGate?.snapshot();
          const probe = window.__forgeaxAudioM20?.snapshot();
          return gate?.started === 1
            && gate.pending
            && probe?.phase === 'pending-decode';
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const pendingDecode = await page.evaluate(() => ({
        gate: window.__forgeaxM20DecodeGate?.snapshot(),
        probe: window.__forgeaxAudioM20?.snapshot(),
      }));

      await page.evaluate(() => window.__forgeaxAudioM20?.stopStale());
      await page.waitForFunction(
        () => {
          const probe = window.__forgeaxAudioM20?.snapshot();
          const entityId = probe?.entityId;
          return probe?.phase === 'stale-stopped'
            && probe.audio.activeSourceCount === 0
            && probe.entityId === entityId;
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const staleStopped = await page.evaluate(() => ({
        gate: window.__forgeaxM20DecodeGate?.snapshot(),
        probe: window.__forgeaxAudioM20?.snapshot(),
      }));
      await page.screenshot({ path: m20StalePath });

      await page.evaluate(() => window.__forgeaxAudioM20?.replaceCurrentEpoch());
      await page.waitForFunction(
        () => {
          const probe = window.__forgeaxAudioM20?.snapshot();
          return probe?.phase === 'replacement-requested'
            && probe.entityId !== null
            && probe.currentSourceKey !== probe.staleSourceKey;
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const replacementRequested = await page.evaluate(() => ({
        gate: window.__forgeaxM20DecodeGate?.snapshot(),
        probe: window.__forgeaxAudioM20?.snapshot(),
      }));

      await page.waitForFunction(
        () => {
          const gate = window.__forgeaxM20DecodeGate?.snapshot();
          const probe = window.__forgeaxAudioM20?.snapshot();
          return gate?.pending
            && gate.sourceStarts === 1
            && probe?.audio.activeSourceCount === 1;
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const replacementPlaying = await page.evaluate(() => ({
        gate: window.__forgeaxM20DecodeGate?.snapshot(),
        probe: window.__forgeaxAudioM20?.snapshot(),
      }));

      // This keydown is a real user gesture for the same AudioContext. Enter
      // is not the demo's spacebar path and does not trigger canvas pointer
      // lock, so only the probe can become active.
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => document.querySelector('#audio-status')?.textContent?.includes('audio=running'),
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      await page.evaluate(() => window.__forgeaxM20DecodeGate?.release());
      await page.waitForFunction(
        () => {
          const gate = window.__forgeaxM20DecodeGate?.snapshot();
          const probe = window.__forgeaxAudioM20?.snapshot();
          return gate?.resolved === 1
            && gate.sourceStarts === 1
            && probe?.audio.activeSourceCount === 1;
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const recovered = await page.evaluate(() => window.__forgeaxAudioM20?.markRecovered());
      await page.screenshot({ path: m20RecoveredPath });

      await page.evaluate(() => window.__forgeaxAudioM20?.cleanup());
      await page.waitForFunction(
        () => {
          const probe = window.__forgeaxAudioM20?.snapshot();
          return probe?.phase === 'cleanup-requested'
            && !probe.entityAlive
            && probe.audio.activeSourceCount === 0
            && probe.entityId !== null;
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const cleanup = await page.evaluate(() => window.__forgeaxAudioM20?.snapshot());
      const cleanupAgain = await page.evaluate(() => window.__forgeaxAudioM20?.cleanup());

      const evidence = {
        baseline,
        pendingDecode,
        staleStopped,
        replacementRequested,
        replacementPlaying,
        recovered,
        cleanup,
        cleanupAgain,
        gate: await page.evaluate(() => window.__forgeaxM20DecodeGate?.snapshot()),
        screenshots: {
          baseline: m20BeforePath,
          stale: m20StalePath,
          recovered: m20RecoveredPath,
        },
        pageErrors,
        consoleErrors,
      };
      const evidencePath = resolve(ARTIFACT_DIR, 'm20-browser-evidence.json');
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

      await closeWithTimeout('page', () => page.close());
      if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
      if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
      if (cleanupAgain?.cleanupCalls !== 2 || cleanupAgain.phase !== 'cleanup-idempotent') {
        throw new Error(`cleanup was not idempotent: ${JSON.stringify(cleanupAgain)}`);
      }
      console.log(`[m20] Browser phases: baseline -> pending-decode -> stale-stop -> replacement -> recovery -> cleanup`);
      console.log(`[m20] Browser evidence: ${evidencePath}`);
      console.log('[m20] Browser stale-decode epoch recovery: PASS');
    } else if (M54_MODE) {
      const forcedState = await page.evaluate(() => window.__forgeaxM54Audio?.suspend() ?? null);
      await page.waitForFunction(
        () => document.querySelector('#audio-status')?.textContent?.includes('audio=suspended'),
        undefined,
        { timeout: 5_000, polling: 100 },
      );
      if (forcedState !== 'suspended') {
        throw new Error(`M54 could not establish a real suspended AudioContext: ${String(forcedState)}`);
      }
      const refusalGesture = 'Enter';
      await page.keyboard.press(refusalGesture);
      try {
        await page.waitForFunction(
          () => window.__forgeaxM54Audio?.snapshot().resumeAttempts === 1,
          undefined,
          { timeout: 30_000, polling: 100 },
        );
      } catch (error) {
        const diagnostics = await page.evaluate(() => ({
          audio: document.querySelector('#audio-status')?.textContent ?? null,
          probe: window.__forgeaxM54Audio?.snapshot() ?? null,
        }));
        throw new Error(`${error instanceof Error ? error.message : String(error)}; M54 first gesture=${JSON.stringify(diagnostics)}`);
      }
      await page.waitForTimeout(100);
      const refused = await page.evaluate(() => ({
        audio: document.querySelector('#audio-status')?.textContent ?? null,
        probe: window.__forgeaxM54Audio?.snapshot() ?? null,
      }));
      if (refused.probe?.resumeAttempts !== 1 || !refused.probe.firstRefusal) {
        throw new Error(`M54 first gesture did not record one deterministic refusal: ${JSON.stringify(refused)}`);
      }
      if (!refused.audio?.includes('audio=suspended')) {
        throw new Error(`M54 refusal changed the real context state: ${JSON.stringify(refused)}`);
      }

      const recoveryGesture = 'Enter';
      await page.keyboard.press(recoveryGesture);
      await page.waitForFunction(
        () => {
          const audio = document.querySelector('#audio-status')?.textContent ?? '';
          const probe = window.__forgeaxM54Audio?.snapshot();
          return audio.includes('audio=running') && probe?.resumeAttempts === 2;
        },
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const recovered = await page.evaluate(() => ({
        audio: document.querySelector('#audio-status')?.textContent ?? null,
        probe: window.__forgeaxM54Audio?.snapshot() ?? null,
      }));
      if (recovered.probe?.contextIds.length !== 2
        || recovered.probe.contextIds[0] !== recovered.probe.contextIds[1]) {
        throw new Error(`M54 recovery reconstructed the context: ${JSON.stringify(recovered)}`);
      }

      await page.keyboard.press('Space');
      await page.waitForFunction(
        () => /starts=[1-9]/.test(document.querySelector('#audio-status')?.textContent ?? ''),
        undefined,
        { timeout: 30_000, polling: 100 },
      );
      const afterPlayback = await page.locator('#audio-status').textContent();
      const evidence = {
        forcedState,
        refusalGesture,
        recoveryGesture,
        refused,
        recovered,
        afterPlayback,
        pageErrors,
        consoleErrors,
      };
      const evidencePath = resolve(ARTIFACT_DIR, 'm54-browser-evidence.json');
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

      await closeWithTimeout('page', () => page.close());
      if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
      if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
      console.log(`[m54] Browser evidence: ${evidencePath}`);
      console.log('[m54] Browser refusal -> next-gesture recovery on the same AudioContext: PASS');
    } else {

    // A real keydown is the browser gesture consumed by WebAudioEngine's
    // one-shot resume listener; the keyup is also the demo's play trigger.
    await page.keyboard.down('Space');
    await page.waitForTimeout(100);
    await page.keyboard.up('Space');
    await page.waitForFunction(
      () => {
        const text = document.querySelector('#audio-status')?.textContent ?? '';
        return text.includes('audio=running') && /starts=[1-9]/.test(text);
      },
      undefined,
      { timeout: 30_000, polling: 100 },
    );
    const afterGestureStatus = await page.locator('#audio-status').textContent();

    await page.waitForFunction(
      () => {
        const physics = document.querySelector('#physics-status')?.textContent ?? '';
        const audio = document.querySelector('#audio-status')?.textContent ?? '';
        return physics.includes('collision=1') && physics.includes('cleanup=1')
          && audio.includes('active=0') && /starts=[2-9]/.test(audio);
      },
      undefined,
      { timeout: 30_000, polling: 100 },
    );
    const collisionStatus = await page.locator('#physics-status').textContent();
    const cleanupAudioStatus = await page.locator('#audio-status').textContent();

    // Move left of the emitter. The emitter is at x=0, so it must pan right.
    await page.keyboard.down('a');
    await page.waitForTimeout(350);
    await page.keyboard.up('a');
    await page.waitForFunction(
      () => document.querySelector('#overlay')?.textContent?.includes('pan = R'),
      undefined,
      { timeout: 30_000, polling: 100 },
    );
    const movedOverlay = await page.locator('#overlay').textContent();
    const afterPath = resolve(ARTIFACT_DIR, 'after-gesture-and-pan.png');
    await page.screenshot({ path: afterPath });
    const pixels = countChangedPixels(beforePath, afterPath);

    await closeWithTimeout('page', () => page.close());
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    if (pixels < 100) throw new Error(`gesture/pan produced too few changed pixels: ${pixels}`);

    console.log(`[smoke-browser] initial=${initialStatus} overlay=${initialOverlay}`);
    console.log(`[smoke-browser] afterGesture=${afterGestureStatus} moved=${movedOverlay}`);
    console.log(`[smoke-browser] collision=${collisionStatus} cleanupAudio=${cleanupAudioStatus}`);
    console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
    console.log(`[smoke-browser] PASS - real Chrome gesture resumed AudioContext, collision triggered spatial SFX, despawn cleaned audio, and listener pan moved; changedPixels=${pixels}.`);
    }
  } finally {
    await closeWithTimeout('browser', () => browser.close());
  }
} catch (error) {
  failed = true;
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await stopVite();
  process.exit(process.exitCode ?? (failed ? 1 : 0));
}
