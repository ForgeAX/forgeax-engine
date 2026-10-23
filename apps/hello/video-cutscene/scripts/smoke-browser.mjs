#!/usr/bin/env node
// smoke-browser.mjs -- feat-20260617-host-engine-contract-and-video-cutscene
// M4 / w16. Playwright e2e DOUBLE gate for apps/hello/video-cutscene.
//
// Spawns a local vite dev server, drives headless Chrome with WebGPU, triggers
// the cutscene, and asserts BOTH gates the contract's video cutscene worked
// example must satisfy (docs/how-to/2026-06-18-host-engine-contract.md 4.2):
//
//   VISUAL GATE  -- page.screenshot() during the overlay period captures the
//                   playing <video> frame composited over the canvas. The PNG
//                   per-channel stats must differ from the pre-cutscene
//                   canvas-only frame (the overlay is actually on screen, not a
//                   no-op). page.screenshot (compositor-level) is used, NOT a
//                   2d drawImage(webgpuCanvas) readback (returns black).
//
//   STRUCTURAL GATE -- #video-overlay transitions visible -> hidden in the
//                      correct order: hidden at boot, visible after the trigger,
//                      hidden again after video.onended (which also resumes the
//                      app). This is the overlay appear -> remove timing (AC-11).
//
// FALSIFICATION (manual, NOT in CI): a no-overlay variant (comment out
// video.style.display = 'block' in src/main.ts) must make the VISUAL GATE fail
// because the overlay frame would equal the canvas-only frame.
//
// ** visualSSOT ** -- the PNGs written to ../screenshots are the human-review
// visual SSOT (charter F2); the decoded stats below are the machine gate.
//
// Exit codes: 0 = green, 1 = red (regression), 2 = harness error (vite/chrome).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { observeViteHttpReadiness } from '../../../../scripts/lib/vite-http-readiness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCREENSHOT_DIR = resolve(HERE, '..', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

// --- Minimal PNG decoder (truecolor / truecolor-alpha, 8-bit, no interlace) ---
function decodePngStats(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (type === 'IHDR') {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataStart + len));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const r = raw[rawPos++];
      const a = x >= channels ? out[rowStart + x - channels] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? out[prevStart + x - channels] : 0;
      let v;
      switch (filter) {
        case 0: v = r; break;
        case 1: v = r + a; break;
        case 2: v = r + b; break;
        case 3: v = r + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = r + pred;
          break;
        }
        default: throw new Error(`bad PNG filter ${filter}`);
      }
      out[rowStart + x] = v & 0xff;
    }
  }
  let n = 0;
  let rAcc = 0;
  let gAcc = 0;
  let bAcc = 0;
  let sum = 0;
  let sumSq = 0;
  const sampleStep = channels * 53;
  for (let i = 0; i + channels <= out.length; i += sampleStep) {
    const rr = out[i];
    const gg = out[i + 1];
    const bb = out[i + 2];
    const luma = 0.299 * rr + 0.587 * gg + 0.114 * bb;
    rAcc += rr;
    gAcc += gg;
    bAcc += bb;
    sum += luma;
    sumSq += luma * luma;
    n++;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return {
    width,
    height,
    channels,
    stats: {
      meanR: rAcc / n,
      meanG: gAcc / n,
      meanB: bAcc / n,
      meanLuma: mean,
      stddevLuma: Math.sqrt(Math.max(0, variance)),
    },
  };
}

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-video-cutscene', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const viteReadiness = observeViteHttpReadiness(viteProc, {
  timeoutEnvName: 'FORGEAX_VIDEO_CUTSCENE_SERVER_READINESS_TIMEOUT_MS',
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

const browser = await chromium.launch({
  ...browserLaunch,
  headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0',
  chromiumSandbox: true,
});
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${e.message}`));

function fail(msg) {
  console.error(`[smoke-browser] RED - ${msg}`);
  try {
    viteProc.kill('SIGTERM');
  } catch {
    /* best-effort */
  }
  Promise.resolve(browser.close()).finally(() => process.exit(1));
  throw new Error(`SMOKE_FAIL: ${msg}`);
}

async function shootAndDecode(name) {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`);
  const png = await page.screenshot({ path });
  const decoded = decodePngStats(png);
  console.log(
    `[smoke-browser] ${name}: ${decoded.width}x${decoded.height} ` +
      `meanRGB=(${decoded.stats.meanR.toFixed(1)},${decoded.stats.meanG.toFixed(1)},${decoded.stats.meanB.toFixed(1)}) ` +
      `luma=${decoded.stats.meanLuma.toFixed(1)} stddev=${decoded.stats.stddevLuma.toFixed(1)}`,
  );
  return decoded.stats;
}

async function overlayState() {
  return await page.evaluate(() => {
    const el = document.getElementById('video-overlay');
    if (!el) return 'missing';
    return getComputedStyle(el).display === 'none' ? 'hidden' : 'visible';
  });
}

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('#canvas', { timeout: 10000 });
// Shader/device initialization can outlive networkidle. Wait for the App's
// completed-frame projection before sending input or sampling the canvas.
await page.waitForFunction(
  () => typeof globalThis.__forgeax_video_cutscene__?.playCutscene === 'function' &&
    (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) > 0,
  undefined,
  { timeout: 30000 },
);

// STRUCTURAL GATE part 1: overlay hidden at boot.
if ((await overlayState()) !== 'hidden') {
  fail('overlay is not hidden at boot (expected display:none before the cutscene).');
}
const canvasOnlyStats = await shootAndDecode('before-cutscene');

// Trigger the cutscene via the device-level key the demo listens for.
await page.keyboard.press('c');

// STRUCTURAL GATE part 2: overlay becomes visible.
try {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('video-overlay');
      return !!el && getComputedStyle(el).display !== 'none';
    },
    undefined,
    { timeout: 5000 },
  );
} catch {
  fail('overlay never became visible after pressing C (pause -> overlay path broken).');
}
console.log('[smoke-browser] STRUCTURAL: overlay visible after trigger');

// Let the video paint a frame, then capture during the overlay period.
await page.waitForTimeout(400);
const overlayStats = await shootAndDecode('during-cutscene');
const pausedFrame = await page.evaluate(
  () => document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0,
);

// VISUAL GATE: the overlay frame must differ from the canvas-only frame.
// The cutscene video is full-screen and animated, so its mean color differs
// clearly from the dark-background rotating-cube frame.
const dR = Math.abs(canvasOnlyStats.meanR - overlayStats.meanR);
const dG = Math.abs(canvasOnlyStats.meanG - overlayStats.meanG);
const dB = Math.abs(canvasOnlyStats.meanB - overlayStats.meanB);
const colorDelta = dR + dG + dB;
console.log(
  `[smoke-browser] canvas-only vs overlay mean color delta = ${colorDelta.toFixed(2)} (R${dR.toFixed(1)} G${dG.toFixed(1)} B${dB.toFixed(1)})`,
);
const MIN_COLOR_DELTA = 20.0;
if (colorDelta < MIN_COLOR_DELTA) {
  fail(
    `overlay frame too similar to canvas-only frame (colorDelta=${colorDelta.toFixed(2)} < ${MIN_COLOR_DELTA}) -- ` +
      `the video overlay did not visibly composite over the canvas (FALSIFICATION: a no-overlay variant fails here).`,
  );
}

// STRUCTURAL GATE part 3: overlay hides again after the video ends, which also
// resumes the app. Poll for the visible -> hidden transition (the demo sets
// display:none in video.onended -> app.resume()).
try {
  await page.waitForFunction(
    () => {
      const el = document.getElementById('video-overlay');
      return !!el && getComputedStyle(el).display === 'none';
    },
    undefined,
    { timeout: 15000 },
  );
} catch {
  fail('overlay never hid again (video.onended -> resume timing broken; AC-11 remove timing).');
}
console.log('[smoke-browser] STRUCTURAL: overlay hidden again after video ended (resume)');
await page.waitForFunction(
  (previousFrameId) =>
    (document.querySelector('canvas')?.forgeaxFrameProgress?.completed?.frameId ?? 0) > previousFrameId,
  pausedFrame,
  { timeout: 10_000 },
);
const afterStats = await shootAndDecode('after-cutscene');

if (pageErrors.length > 0) {
  pageErrors.forEach((e) => console.error(`  ${e}`));
  fail(`${pageErrors.length} uncaught page error(s)`);
}

// After resume, the canvas is live again -- it must have rendered something
// (not a black frame).
const MIN_STDDEV = 4.0;
const MIN_LUMA = 4.0;
if (afterStats.stddevLuma < MIN_STDDEV && afterStats.meanLuma < MIN_LUMA) {
  fail(
    `after-cutscene frame is near-uniform dark (stddev=${afterStats.stddevLuma.toFixed(2)}, luma=${afterStats.meanLuma.toFixed(2)}) -- ` +
      `the world did not resume rendering.`,
  );
}

writeFileSync(
  resolve(SCREENSHOT_DIR, 'stats.json'),
  JSON.stringify({ beforeCutscene: canvasOnlyStats, duringCutscene: overlayStats, afterCutscene: afterStats, colorDelta }, null, 2),
);

console.log('\n[smoke-browser] GREEN - cutscene double gate passed.');
console.log(`  SERVER: HTTP ready after ${serverReadyElapsedMs}ms`);
console.log(`  VISUAL: overlay vs canvas-only color delta=${colorDelta.toFixed(2)}`);
console.log('  STRUCTURAL: overlay hidden -> visible -> hidden in order');
console.log(`  visualSSOT: ${SCREENSHOT_DIR}/before-cutscene.png, during-cutscene.png, after-cutscene.png`);

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);
process.exit(0);
