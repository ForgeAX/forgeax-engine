#!/usr/bin/env node
// smoke-browser.mjs — apps/hello/video-texture browser e2e smoke
// (feat-20260623-world-space-video-asset M5 / w21).
//
// Playwright e2e: spawns a local vite dev server, drives Chrome with WebGPU
// enabled, and runs two CENTER-REGION pixel-readback probes on the rendered
// video quad:
//   (a) video-content — the center region of the canvas (where the quad is) is
//       neither pure black (quad not drawn / dead canvas) nor a near-uniform
//       default-texture fill (video upload never happened). The HUD text is in
//       the top-left corner and is EXCLUDED from this region, so it cannot
//       false-green the probe (the prior 5 KB whole-PNG size gate was satisfied
//       by HUD text alone — see the falsification pass below).
//   (b) frame-advancing — the center region measurably changes between two
//       time-separated captures, proving video frames advance over time.
//
// Falsification pass (EXECUTABLE, not just documented): the same probes are run
// against `?falsify=1`, which makes the demo SKIP the VideoSourceProvider
// registration. With no host element the engine binds the default view, the quad
// shows no live video, and at least one probe MUST go RED. If the falsify pass were
// to PASS, the probes would be vacuous (e.g. tripping on the HUD) — so a GREEN
// falsify pass fails the smoke. This calibrates the probe against a known-bad
// scene.
//
// Center region is sampled from the raw PNG via pngjs so the gate reasons about
// actual pixels, not PNG byte size.
//
// Invocation: `pnpm -F @forgeax/video-texture smoke:browser`
//
// Exit codes:
//   0 = green (normal/recovery pass GREEN + falsify pass correctly RED)
//   1 = red (normal probe failure, or falsify pass unexpectedly GREEN)
//   2 = harness error (vite did not boot)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { observeViteHttpReadiness } from '../../../../scripts/lib/vite-http-readiness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

// pngjs is hoisted into the workspace .pnpm store (not symlinked at every app
// node_modules); resolve it from the repo root.
const require = createRequire(resolve(REPO_ROOT, 'package.json'));
let PNG;
try {
  ({ PNG } = require('pngjs'));
} catch {
  // Fallback: explicit store path (pnpm hoist layout).
  ({ PNG } = require(
    resolve(REPO_ROOT, 'node_modules/.pnpm/pngjs@7.0.0/node_modules/pngjs/lib/png.js'),
  ));
}

const RESULT_DIR = resolve(
  REPO_ROOT,
  'artifacts',
  'forgeax-loop',
  'feat-20260623-world-space-video-asset',
  'screenshots',
);
mkdirSync(RESULT_DIR, { recursive: true });

// --- 1. Start vite dev server -------------------------------------------------

const viteProc = spawn('pnpm', ['-F', '@forgeax/video-texture', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const viteReadiness = observeViteHttpReadiness(viteProc, {
  timeoutEnvName: 'FORGEAX_VIDEO_TEXTURE_SERVER_READINESS_TIMEOUT_MS',
});
let portUrl;
let serverReadyElapsedMs;
try {
  ({ origin: portUrl, elapsedMs: serverReadyElapsedMs } = await viteReadiness.wait());
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-browser] using ${portUrl}`);

// --- 2. Launch Chrome with WebGPU + autoplay ---------------------------------

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
    // Headless Chrome blocks <video>.play() without a user gesture by default,
    // which would stall frame decode; the host provider calls .play() eagerly.
    // (sibling apps/hello/video-cutscene/scripts/smoke-browser.mjs precedent.)
    '--autoplay-policy=no-user-gesture-required',
  ],
  chromiumSandbox: true,
});

// --- pixel helpers -----------------------------------------------------------

// Average RGB over a centered square region of `frac` of min(width,height).
// The HUD text lives in the top-left corner; the centered region excludes it.
function centerRegionStats(png, frac = 0.25) {
  const img = PNG.sync.read(png);
  const half = Math.floor((Math.min(img.width, img.height) * frac) / 2);
  const cx = Math.floor(img.width / 2);
  const cy = Math.floor(img.height / 2);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const samples = [];
  for (let y = cy - half; y < cy + half; y++) {
    for (let x = cx - half; x < cx + half; x++) {
      const i = (img.width * y + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
      samples.push(img.data[i], img.data[i + 1], img.data[i + 2]);
    }
  }
  const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  // variance proxy: max abs deviation of any channel sample from the mean.
  let maxDev = 0;
  const meanAll = (avg[0] + avg[1] + avg[2]) / 3;
  for (const s of samples) maxDev = Math.max(maxDev, Math.abs(s - meanAll));
  return { avg, maxDev, width: img.width, height: img.height };
}

// The recovery demo keeps a static green sibling to the left of the video
// quad. Sampling that fixed region proves provider loss does not disturb an
// unrelated draw in the same World/Renderer/device.
function staticSiblingStats(png) {
  const img = PNG.sync.read(png);
  const x0 = Math.floor(img.width * 0.22);
  const x1 = Math.floor(img.width * 0.38);
  const y0 = Math.floor(img.height * 0.35);
  const y1 = Math.floor(img.height * 0.65);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (img.width * y + x) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  return {
    avg: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
    width: img.width,
    height: img.height,
  };
}

function l1(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function unsupportedCount(state) {
  return state.errorCodes.filter((code) => code === 'video-upload-unsupported').length;
}

const RECOVERY_IDENTITY_KEYS = [
  'sameWorld',
  'sameRenderer',
  'sameDevice',
  'sameVideoEntity',
  'sameStaticEntity',
  'sameVideoClip',
  'sameVideoMaterial',
  'sameStaticMaterial',
];

function recoveryIdentityFailures(state) {
  return RECOVERY_IDENTITY_KEYS.filter((key) => state[key] !== true).map(
    (key) => `${key}=${String(state[key])}`,
  );
}

async function capturePage(page, filename) {
  const png = await page.screenshot({ type: 'png' });
  const path = resolve(RESULT_DIR, filename);
  writeFileSync(path, png);
  return {
    stats: centerRegionStats(png),
    sibling: staticSiblingStats(png),
    path,
  };
}

// One run = navigate, screenshot twice over time, return both center stats + raw.
async function runOnce(query, label) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE-ERR: ${msg.text()}`);
  });
  await page.goto(`${portUrl}/${query}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForFunction(
    () => Number(document.querySelector('#app')?.dataset.forgeaxCompletedFrames ?? 0) >= 2,
    undefined,
    { timeout: 30000 },
  );
  await page.waitForTimeout(5000);
  const png1 = await page.screenshot({ type: 'png' });
  await page.waitForTimeout(3000);
  const png2 = await page.screenshot({ type: 'png' });
  const p1 = `${label}-frame1.png`;
  const p2 = `${label}-frame2.png`;
  writeFileSync(resolve(RESULT_DIR, p1), png1);
  writeFileSync(resolve(RESULT_DIR, p2), png2);
  await ctx.close();
  return {
    s1: centerRegionStats(png1),
    s2: centerRegionStats(png2),
    errors,
    paths: [resolve(RESULT_DIR, p1), resolve(RESULT_DIR, p2)],
  };
}

// One same-page recovery journey. The page owns one World, Renderer, device,
// video entity, static sibling, material pair, and provider object throughout;
// only the World resource is removed/reinserted.
async function runRecoveryJourney() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  let controlsReady = false;
  const failures = [];
  try {
    await page.goto(`${portUrl}/?recovery=1&pack-retry=1`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await page.waitForFunction(
      () => typeof globalThis.__forgeaxVideoTextureRecovery === 'object',
      undefined,
      { timeout: 30000 },
    );
    controlsReady = true;
    await page.waitForFunction(
      () => Number(document.querySelector('#app')?.dataset.forgeaxCompletedFrames ?? 0) >= 2,
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(5000);

    // Drain submitted work and hold new frames while taking the reference.
    // Otherwise the screenshot can precede several already-queued video uploads.
    await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.pauseFrames());
    const healthy = await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.inspect());
    const before = await capturePage(page, 'video-texture-recovery-before.png');
    const beforeMean = healthy ? (before.stats.avg[0] + before.stats.avg[1] + before.stats.avg[2]) / 3 : 0;
    if (beforeMean <= BLACK_FLOOR || before.stats.maxDev <= UNIFORM_DEV) {
      failures.push(
        `healthy recovery frame is not live video (avg=${before.stats.avg}, maxDev=${before.stats.maxDev})`,
      );
    }
    if (healthy.packFirstErrorCode !== 'asset-parse-failed') {
      failures.push(`Pack first load code=${String(healthy.packFirstErrorCode)}`);
    }
    if (healthy.packRetrySucceeded !== true) failures.push('Pack retry did not succeed');
    if (healthy.packCurrentErrorCode !== undefined) {
      failures.push(`stale Pack diagnostic=${healthy.packCurrentErrorCode}`);
    }
    if (healthy.videoUrl !== '/cutscene.webm') {
      failures.push(`published video URL=${String(healthy.videoUrl)}`);
    }
    if (healthy.videoElementCount !== 1) {
      failures.push(`host video element count=${String(healthy.videoElementCount)}`);
    }
    if (healthy.videoElementSrc !== '/cutscene.webm') {
      failures.push(`host video element src=${String(healthy.videoElementSrc)}`);
    }
    failures.push(...recoveryIdentityFailures(healthy).map((item) => `healthy identity ${item}`));
    if (!healthy.providerPresent) failures.push('healthy recovery state has no provider');
    const healthyUnsupported = unsupportedCount(healthy);

    await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.removeProvider());
    await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.resumeFrames());
    await page.waitForTimeout(1200);
    const lost = await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.inspect());
    const duringLoss = await capturePage(page, 'video-texture-recovery-during-loss.png');
    await page.waitForTimeout(1200);
    const settledLoss = await capturePage(page, 'video-texture-recovery-during-loss-settled.png');
    if (l1(duringLoss.stats.avg, settledLoss.stats.avg) > ADVANCE_DELTA) {
      failures.push(
        `LKG kept changing during provider loss (avg-loss=${duringLoss.stats.avg}, avg-settled=${settledLoss.stats.avg})`,
      );
    }
    if (l1(before.stats.avg, settledLoss.stats.avg) > LKG_SETTLE_DELTA) {
      failures.push(
        `provider loss did not preserve the last uploaded view (avg-before=${before.stats.avg}, avg-settled=${settledLoss.stats.avg})`,
      );
    }
    if (l1(before.sibling.avg, settledLoss.sibling.avg) > ADVANCE_DELTA) {
      failures.push(
        `static sibling changed during provider loss (avg-before=${before.sibling.avg}, avg-settled=${settledLoss.sibling.avg})`,
      );
    }
    failures.push(...recoveryIdentityFailures(lost).map((item) => `loss identity ${item}`));
    if (lost.providerPresent) failures.push('provider remained present after removal');
    if (unsupportedCount(lost) !== healthyUnsupported + 1) {
      failures.push(
        `first loss emitted ${unsupportedCount(lost) - healthyUnsupported} unsupported diagnostics; expected 1`,
      );
    }

    await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.restoreProvider());
    await page.waitForTimeout(3000);
    const restored1 = await capturePage(page, 'video-texture-recovery-restored-1.png');
    await page.waitForTimeout(3000);
    const restored2 = await capturePage(page, 'video-texture-recovery-restored-2.png');
    const restored = await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.inspect());
    if (l1(restored1.stats.avg, restored2.stats.avg) < ADVANCE_DELTA) {
      failures.push(
        `video did not advance after provider restore (L1=${l1(restored1.stats.avg, restored2.stats.avg)})`,
      );
    }
    if (l1(before.sibling.avg, restored2.sibling.avg) > ADVANCE_DELTA) {
      failures.push(
        `static sibling changed after provider restore (avg-before=${before.sibling.avg}, avg-restored=${restored2.sibling.avg})`,
      );
    }
    failures.push(...recoveryIdentityFailures(restored).map((item) => `restore identity ${item}`));
    if (!restored.providerPresent) failures.push('provider did not return after restore');
    if (unsupportedCount(restored) !== unsupportedCount(lost)) {
      failures.push('restore emitted a stale or repeated unsupported diagnostic');
    }

    await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.removeProvider());
    await page.waitForTimeout(1200);
    const secondLoss = await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.inspect());
    await capturePage(page, 'video-texture-recovery-second-loss.png');
    if (unsupportedCount(secondLoss) !== unsupportedCount(restored) + 1) {
      failures.push(
        `second loss emitted ${unsupportedCount(secondLoss) - unsupportedCount(restored)} unsupported diagnostics; expected 1`,
      );
    }
    failures.push(...recoveryIdentityFailures(secondLoss).map((item) => `second-loss identity ${item}`));

    await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.restoreProvider());
    await page.waitForTimeout(1000);
    const finalState = await page.evaluate(() => globalThis.__forgeaxVideoTextureRecovery.inspect());
    failures.push(...recoveryIdentityFailures(finalState).map((item) => `final identity ${item}`));
    if (!finalState.providerPresent) failures.push('provider did not return after second restore');
    if (unsupportedCount(finalState) !== unsupportedCount(secondLoss)) {
      failures.push('second restore emitted a stale or repeated unsupported diagnostic');
    }
  } catch (error) {
    failures.push(`recovery journey harness error: ${error.message}`);
  } finally {
    if (controlsReady) {
      try {
        // Renderer.dispose is intentionally idempotent; exercise cleanup twice
        // on the same page so recovery does not leave a live render loop.
        await page.evaluate(() => {
          globalThis.__forgeaxVideoTextureRecovery.cleanup();
          globalThis.__forgeaxVideoTextureRecovery.cleanup();
        });
      } catch (error) {
        failures.push(`recovery cleanup failed: ${error.message}`);
      }
    }
    if (pageErrors.length > 0) failures.push(`pageerror: ${pageErrors.join(' | ')}`);
    await ctx.close();
  }
  return failures;
}

// Probe evaluation for one run. Returns the list of probe failures.
const BLACK_FLOOR = 18; // mean channel <= this => effectively black (quad not drawn)
const UNIFORM_DEV = 12; // maxDev <= this => near-uniform fill (default texture, no video)
const ADVANCE_DELTA = 6; // center avg must move at least this much L1 between frames
// Preserve the original boundary-sampling tolerance. The healthy reference now
// drains queued uploads; repeated samples must remain stable while absent.
const LKG_SETTLE_DELTA = 48;
function evaluate(run) {
  const failures = [];
  const meanA = (run.s1.avg[0] + run.s1.avg[1] + run.s1.avg[2]) / 3;
  // (a) video-content: center is not black AND not a near-uniform fill.
  if (meanA <= BLACK_FLOOR) {
    failures.push(
      `(a) video-content: center region is effectively black (avg=${run.s1.avg}) — quad not drawn or no video.`,
    );
  } else if (run.s1.maxDev <= UNIFORM_DEV) {
    failures.push(
      `(a) video-content: center region is near-uniform (avg=${run.s1.avg}, maxDev=${run.s1.maxDev}) — default texture, video upload did not happen.`,
    );
  }
  // (b) frame-advancing: center avg changed between the two captures.
  const l1 =
    Math.abs(run.s1.avg[0] - run.s2.avg[0]) +
    Math.abs(run.s1.avg[1] - run.s2.avg[1]) +
    Math.abs(run.s1.avg[2] - run.s2.avg[2]);
  if (l1 < ADVANCE_DELTA) {
    failures.push(
      `(b) frame-advancing: center region static (L1=${l1} < ${ADVANCE_DELTA}; avg1=${run.s1.avg} avg2=${run.s2.avg}) — frames not advancing.`,
    );
  }
  return failures;
}

// --- 3. Normal pass ----------------------------------------------------------

const normal = await runOnce('', 'video-texture');
const normalFailures = evaluate(normal);
console.log(
  `[smoke-browser] NORMAL center avg1=${normal.s1.avg} maxDev=${normal.s1.maxDev} avg2=${normal.s2.avg}`,
);
if (normal.errors.length > 0) {
  console.error('[smoke-browser] NORMAL page errors:');
  normal.errors.forEach((e) => console.error(`  ${e}`));
}

// --- 4. Falsification pass (provider skipped -> must go RED) ------------------

const falsify = await runOnce('?falsify=1', 'video-texture-falsify');
const falsifyFailures = evaluate(falsify);
console.log(
  `[smoke-browser] FALSIFY center avg1=${falsify.s1.avg} maxDev=${falsify.s1.maxDev} avg2=${falsify.s2.avg}`,
);

// --- 5. Verdict assembly ------------------------------------------------------

const verdictFailures = [];
for (const f of normalFailures) verdictFailures.push(`NORMAL ${f}`);
// The falsify pass MUST fail at least one probe; if it passes, the probes are
// vacuous (would green on a scene with no live video — e.g. HUD-only).
if (falsifyFailures.length === 0) {
  verdictFailures.push(
    'FALSIFY pass unexpectedly GREEN: probes did not detect the missing video ' +
      '(provider skipped). The probes are not actually gating on video content.',
  );
} else {
  console.log(
    `[smoke-browser] FALSIFY correctly RED (${falsifyFailures.length} probe(s) failed as expected): ` +
      falsifyFailures.map((f) => f.split(':')[0]).join(', '),
  );
}

// --- 5. Same-page provider loss/recovery journey ----------------------------

const recoveryFailures = await runRecoveryJourney();
if (recoveryFailures.length > 0) {
  for (const failure of recoveryFailures) verdictFailures.push(`RECOVERY ${failure}`);
} else {
  console.log(
    '[smoke-browser] RECOVERY GREEN — one same-page World/Renderer/device kept the LKG and static sibling stable, ' +
      'resumed advancing uploads after restore, bounded both loss episodes, and disposed idempotently.',
  );
}

// --- 6. Cleanup --------------------------------------------------------------

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);

if (verdictFailures.length > 0) {
  console.error(`\n[smoke-browser] RED — ${verdictFailures.length} failure(s):`);
  for (const f of verdictFailures) console.error(`  ${f}`);
  console.error(
    `Diagnose: inspect ${RESULT_DIR}/video-texture-frame{1,2}.png (normal) and ` +
      'video-texture-falsify-frame{1,2}.png (provider-skipped control).',
  );
  process.exit(1);
}

console.log(
  `\n[smoke-browser] GREEN — normal pass shows live advancing video at canvas center ` +
    `(avg1=${normal.s1.avg} -> avg2=${normal.s2.avg}), and the falsify control correctly went RED. ` +
    `Video upload -> GPU texture -> shader -> swapchain chain is live and probe-calibrated; serverReadyElapsedMs=${serverReadyElapsedMs}.`,
);
process.exit(0);
