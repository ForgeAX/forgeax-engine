#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { evaluateFogCase } from '../src/oracle.mjs';
import { sampleFogRois } from '../src/roi.mjs';
import { runFogLifecycle } from '../src/runner.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptsDir, '..');
const repoRoot = resolve(scriptsDir, '..', '..', '..', '..');
const frameCount = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '60', 10);
const viewportWidth = Number.parseInt(process.env.FORGEAX_FOG_VIEWPORT_WIDTH ?? '320', 10);
const viewportHeight = Number.parseInt(process.env.FORGEAX_FOG_VIEWPORT_HEIGHT ?? '180', 10);
const evidenceDir = resolve(
  repoRoot,
  process.env.FORGEAX_FOG_EVIDENCE_DIR ?? resolve(appDir, 'artifacts'),
);
const evidencePath = resolve(evidenceDir, 'browser-fog-trace.json');
const screenshotPath = resolve(evidenceDir, 'browser-fog.png');
const pairEvidenceDir = resolve(evidenceDir, 'browser-fog-pairs');
const errors = [];
const recoveryErrors = [];
const requestFailures = [];
let recoveryExpected = false;
const vite = spawn('pnpm', ['--filter', '@forgeax/bevy-fog', 'dev'], {
  cwd: repoRoot,
  env: { ...process.env, FORGEAX_ENGINE_RHI_DEBUG: '0' },
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let appUrl;
let serverOutput = '';
function observeServerOutput(chunk) {
  const text = String(chunk);
  serverOutput += text;
  const plainOutput = serverOutput.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  appUrl ??= plainOutput
    .match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]
    ?.replace(/\/$/, '');
}
vite.stdout.on('data', (chunk) => {
  observeServerOutput(chunk);
});
vite.stderr.on('data', (chunk) => {
  observeServerOutput(chunk);
});

let browser;
let cdp;
let trace;
let screenshot;
let pairScreenshots = new Map();
let failure;
try {
  const deadline = Date.now() + 30_000;
  while (appUrl === undefined && Date.now() < deadline) await delay(100);
  if (appUrl === undefined) throw new Error(`Vite did not publish a URL:\n${serverOutput}`);

  const browserLaunchOptions = {
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',
    args: [
      '--disable-features=MacAppCodeSignClone',
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
      '--disable-dawn-features=disallow_unsafe_apis,tiered_adapter_limits',
    ],
  };
  browser = await chromium.launch({ ...(browserLaunchOptions), chromiumSandbox: true });
  const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight } });
  cdp = await page.context().newCDPSession(page);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('favicon.ico')) {
      const text = message.text();
      if (text.includes('device-lost') || (recoveryExpected && text.includes('device-operation-failed'))) {
        recoveryErrors.push(text);
      }
      else errors.push(`console: ${text}`);
    }
  });
  page.on('requestfailed', (request) => {
    requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
  });
  await page.goto(`${appUrl}/?fog-smoke=1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(
      () => globalThis.__bevyFogBrowser?.ready === true,
      undefined,
      { timeout: 30_000 },
    );
  } catch (waitError) {
    const state = await page
      .evaluate(() => ({
        url: location.href,
        title: document.title,
        ready: globalThis.__bevyFogBrowser?.ready ?? false,
        gpu: typeof navigator.gpu,
        body: document.body?.innerText?.slice(0, 2000) ?? '',
        canvas: (() => {
          const canvas = document.querySelector('#app');
          return canvas === null
            ? undefined
            : { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight };
        })(),
      }))
      .catch((error) => ({ evaluateError: error instanceof Error ? error.message : String(error) }));
    throw new Error(
      `${waitError instanceof Error ? waitError.message : String(waitError)}; readiness=${JSON.stringify({ state, errors, requestFailures })}`,
    );
  }

  const phaseReferences = new Map();
  let disabledReference;
  let lastPhase;
  pairScreenshots = new Map();
  mkdirSync(dirname(screenshotPath), { recursive: true });
  async function captureActiveScreenshot(phase, fallbackCenter) {
    const pngBytes = await page.locator('#app').screenshot({ path: screenshotPath, type: 'png' });
    const screenshotRead = await page.evaluate(async (encoded) => {
      const response = await fetch(`data:image/png;base64,${encoded}`);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('Browser screenshot 2D readback unavailable');
      context.drawImage(bitmap, 0, 0);
      const x = Math.floor(bitmap.width / 2);
      const y = Math.floor(bitmap.height / 2);
      const data = context.getImageData(x, y, 1, 1).data;
      bitmap.close();
      return {
        width: canvas.width,
        height: canvas.height,
        center: [
          (data[0] ?? 0) / 255,
          (data[1] ?? 0) / 255,
          (data[2] ?? 0) / 255,
          (data[3] ?? 0) / 255,
        ],
      };
    }, pngBytes.toString('base64'));
    screenshot = {
      path: screenshotPath,
      bytes: pngBytes.byteLength,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
      read: { ...screenshotRead, phase, fallbackCenter },
    };
  }
  async function capturePairScreenshot(phase, state, observed, roi) {
    if (!['disabled', 'uniform', 'height'].includes(phase) || pairScreenshots.has(phase)) return;
    mkdirSync(pairEvidenceDir, { recursive: true });
    await page.evaluate(() => {
      const panel = document.querySelector('.fog-panel');
      if (panel instanceof HTMLElement) panel.style.visibility = 'hidden';
    });
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
    const path = resolve(pairEvidenceDir, `browser-fog-${phase}.png`);
    const pngBytes = await page.screenshot({ path, type: 'png' });
    pairScreenshots.set(phase, {
      phase,
      path,
      bytes: pngBytes.byteLength,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
      state,
      observed: observed.slice(0, 4),
      roi,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    });
  }
  function renderedCenterOracle(phase, observed) {
    if (phase !== lastPhase) {
      phaseReferences.delete(phase);
      if (phase === 'disabled') disabledReference = undefined;
      lastPhase = phase;
    }
    const primed = !phaseReferences.has(phase);
    const expected = phaseReferences.get(phase) ?? observed;
    phaseReferences.set(phase, expected);
    if (phase === 'disabled' && disabledReference === undefined) disabledReference = observed;
    const caseResult = evaluateFogCase({
      caseId: phase,
      expected,
      observed,
      active: phase !== 'disabled',
    });
    const activeDelta =
      phase === 'disabled' || disabledReference === undefined
        ? undefined
        : Math.max(...observed.slice(0, 3).map((value, index) => Math.abs(value - disabledReference[index])));
    if (phase !== 'disabled' && activeDelta !== undefined && activeDelta <= 0.01) {
      return {
        ...caseResult,
        verdict: 'fail',
        confidence: 'low',
        reason: 'active Fog center fragment did not differ from the captured disabled fragment',
      };
    }
    if (primed) {
      return {
        ...caseResult,
        confidence: 'medium',
        reason: 'oracle primed from the actual rendered center fragment',
      };
    }
    return caseResult;
  }
  trace = await runFogLifecycle({
    backend: 'browser',
    frameCount,
    advanceFrame: async ({ phase, phaseChanged, sampleRequired }) => {
      const sample = await page.evaluate(async ({ requestedPhase, changed, capture }) => {
        const carrier = globalThis.__bevyFogBrowser;
        if (carrier === undefined) throw new Error('Fog Browser carrier disappeared');
        const state = carrier.applyPhase(requestedPhase);
        if (requestedPhase === 'resize' && changed) carrier.resize(256, 144);
        await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
        let readback;
        if (capture && !(requestedPhase === 'recovery' && changed)) {
          await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
          readback = await carrier.readback();
        }
        return { state, health: carrier.health(), readback };
      }, { requestedPhase: phase, changed: phaseChanged, capture: sampleRequired });
      let recovery;
      let readback = sample.readback;
      if (phase === 'recovery' && phaseChanged) {
        recoveryExpected = true;
        await cdp.send('Browser.crashGpuProcess');
        await page.waitForFunction(
          () => globalThis.__bevyFogBrowser?.health().reason === 'device-lost',
          undefined,
          { timeout: 30_000 },
        );
        let recovered;
        let attempts = 0;
        let adapterProbeAttempts = 0;
        await delay(250);
        while (attempts < 120) {
          attempts += 1;
          const adapterReady = await page.evaluate(async () => {
            const gpu = globalThis.navigator?.gpu;
            if (gpu === undefined)
              return { ready: false, carrier: globalThis.__bevyFogBrowser !== undefined };
            try {
              return {
                ready: (await gpu.requestAdapter()) !== null,
                carrier: globalThis.__bevyFogBrowser !== undefined,
              };
            } catch {
              return { ready: false, carrier: globalThis.__bevyFogBrowser !== undefined };
            }
          });
          adapterProbeAttempts += 1;
          if (!adapterReady.carrier)
            throw new Error(`Fog Browser carrier disappeared during recovery probe ${adapterProbeAttempts}`);
          if (!adapterReady.ready) {
            await delay(250);
            continue;
          }
          recovered = await page.evaluate(async () => {
            const carrier = globalThis.__bevyFogBrowser;
            if (carrier === undefined) return { ok: false, error: { code: 'carrier-missing' } };
            const result = await carrier.recover();
            return result ?? { ok: false, error: { code: 'recover-returned-undefined' } };
          });
          if (recovered?.ok) break;
          if (recovered?.error?.code !== 'recover-adapter-unavailable') {
            throw new Error(`Browser recovery failed: ${JSON.stringify(recovered)}`);
          }
          await delay(250);
        }
        if (recovered === undefined || !recovered.ok) {
          throw new Error(
            `Browser recovery failed after ${attempts} attempts (adapter probes=${adapterProbeAttempts}): ${JSON.stringify(recovered)}`,
          );
        }
        await page.waitForFunction(
          () => globalThis.__bevyFogBrowser?.health().reason === 'alive',
          undefined,
          { timeout: 30_000 },
        );
        readback = await page.evaluate(async () => {
          await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
          await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
          return globalThis.__bevyFogBrowser?.readback();
        });
        recovery = {
          action: 'Browser.crashGpuProcess -> renderer.recover',
          result: 'recovered',
          health: 'alive',
          attempts,
          adapterProbeAttempts,
        };
      }
      return { state: sample.state, recovery, readback };
    },
    captureFrame: async ({ frame, phase, advanced }) => {
      const { readback } = advanced;
      if (readback === undefined || !readback.ok) {
        throw new Error(`Browser readback failed: ${readback?.error?.code ?? 'missing'}`);
      }
      const observed = readCenter(readback.pixels, readback.width, readback.height);
      const roi = sampleFogRois(readback.pixels, readback.width, readback.height);
      const caseResult = renderedCenterOracle(phase, observed);
      if (screenshot === undefined && phase !== 'disabled') {
        await captureActiveScreenshot(phase, observed);
      }
      await capturePairScreenshot(phase, advanced.state, observed, roi);
      return {
        cases: [caseResult],
        resource: {
          owner: advanced.state.resourceOwner,
          revision: advanced.state.revision,
          reactive: advanced.state.changedFrom !== undefined,
          accumulation: advanced.state.changedFrom === undefined && frame > 0,
          ownerChanged: advanced.state.ownerChanged,
          target: { width: readback.width, height: readback.height },
          ...(advanced.recovery === undefined ? {} : { recovery: advanced.recovery }),
        },
        visual: {
          observed: observed.slice(0, 3),
          verdict: caseResult.verdict,
          confidence: caseResult.confidence,
          backend: 'browser',
          roi,
        },
      };
    },
  });

  if (screenshot === undefined) await captureActiveScreenshot('disabled', undefined);
} catch (caught) {
  failure = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (browser !== undefined) {
    await Promise.race([browser.close(), delay(5_000)]).catch(() => undefined);
  }
  if (vite.pid !== undefined) {
    if (process.platform !== 'win32') {
      try {
        process.kill(-vite.pid, 'SIGTERM');
      } catch {
        // The process group may have exited with the browser already.
      }
    }
    vite.kill('SIGTERM');
  }
}

mkdirSync(dirname(evidencePath), { recursive: true });
const evidence = {
  ...(trace ?? { frames: 0, verdict: 'fail', cases: [], resources: [], visuals: [] }),
  schemaVersion: 'bevy-fog-evidence/1',
  featureId: 'feat-20260827-render-temporal-environment-bloom-syntax-corrected',
  source: { path: 'apps/bevy/fog/src/main.ts', sha256: createHash('sha256').update(readFileSync(resolve(appDir, 'src/main.ts'))).digest('hex') },
  build: { command: 'pnpm --filter @forgeax/bevy-fog build', sha256: createHash('sha256').update(readFileSync(resolve(appDir, 'package.json'))).digest('hex') },
  backend: 'browser-webgpu',
  runner: { kind: 'playwright', id: process.env.CI ? 'ci-browser' : 'local-browser' },
  status: failure === undefined && trace?.verdict === 'pass' ? 'pass' : failure === undefined ? 'fail' : 'unavailable',
  frameIdentity: { first: 0, last: Math.max(0, (trace?.frames ?? 1) - 1), sequenceSha256: createHash('sha256').update((trace?.phaseTrace ?? []).join('|')).digest('hex') },
  visualEvidence: (trace?.visualEvidence ?? []).map((entry, index) => ({ id: `fog-${entry.phase ?? index}`, png: pairScreenshots.get(entry.phase)?.path ?? screenshotPath, observed: JSON.stringify(entry.observed ?? []), verdict: entry.verdict ?? 'fail', confidence: entry.confidence ?? 'low' })),
  falsify: ['uniform', 'height', 'owner-switch', 'recovery'].map((id) => ({ id, result: trace?.cases?.some((entry) => entry.caseId === id && entry.verdict === 'pass') ? 'pass' : 'fail' })),
  screenshot,
  pairScreenshots: Array.from(pairScreenshots.values()),
  errors,
  requestFailures,
  recoveryErrors,
  failure,
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
  `[smoke-browser] backend=browser frames=${evidence.frames} verdict=${evidence.verdict} evidence=${evidencePath}`,
);
if (failure !== undefined || errors.length > 0 || evidence.verdict !== 'pass') {
  const failedCases = (evidence.cases ?? [])
    .filter((entry) => entry.verdict !== 'pass')
    .map((entry) => ({
      caseId: entry.caseId,
      reason: entry.reason,
      expected: entry.expected,
      observed: entry.observed,
      delta: entry.delta,
    }));
  if (failedCases.length > 0) {
    console.error(`[smoke-browser] failed cases=${JSON.stringify(failedCases)}`);
  }
  console.error(`[smoke-browser] FAIL - errors=${errors.length} failure=${failure ?? 'none'}`);
  process.exit(1);
}
console.log('[smoke-browser] PASS - real Browser WebGPU readback and recovery trace completed');

function readCenter(bytes, width, height) {
  if (!Array.isArray(bytes) || bytes.length !== width * height * 4) {
    throw new Error(`Browser readback shape mismatch: ${bytes?.length ?? 'missing'} for ${width}x${height}`);
  }
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  const rgba = [0, 0, 0, 0];
  let count = 0;
  for (let y = Math.max(0, centerY - 1); y <= Math.min(height - 1, centerY + 1); y += 1) {
    for (let x = Math.max(0, centerX - 1); x <= Math.min(width - 1, centerX + 1); x += 1) {
      const offset = (y * width + x) * 4;
      rgba[0] += (bytes[offset] ?? 0) / 255;
      rgba[1] += (bytes[offset + 1] ?? 0) / 255;
      rgba[2] += (bytes[offset + 2] ?? 0) / 255;
      rgba[3] += (bytes[offset + 3] ?? 0) / 255;
      count += 1;
    }
  }
  return rgba.map((value) => value / count);
}
