#!/usr/bin/env node
// smoke-browser.mjs -- feat-20260616 M7 / m7w5 (verify round 1 rewrite)
//
// Playwright e2e smoke for apps/hello/level-switch. Spawns a local vite dev
// server, drives headless Chrome with WebGPU, switches level via keys, and
// asserts the WebGPU CANVAS actually rendered -- not just that the DOM HUD
// text updated. This is the gate that catches the verify round-1 black-screen
// regression (B1): the demo previously threw before app.start() yet the HUD
// div still showed state names, so a HUD-text-only gate passed while the
// canvas stayed black.
//
// Pixel readback uses page.screenshot() (compositor-level, correctly captures
// the WebGPU canvas) decoded with a self-contained zlib PNG reader. A 2d
// drawImage(webgpuCanvas) readback does NOT work (returns black) and must not
// be reintroduced.
//
// Load-bearing visual assertions (each gates exit 1):
//   GATE B: tutorial frame is NOT a near-uniform dark frame -> something rendered
//   GATE C: street-a frame is NOT a near-uniform dark frame
//   GATE D: tutorial and street-a frames DIFFER in mean color (orange unlit
//           floor vs blue standard-PBR floor) -> the switch changed the scene,
//           not just the HUD div
//
// ** visualSSOT ** -- the PNGs written to ../screenshots are the human-review
// visual SSOT (charter F2); the decoded stats below are the machine gate.
//
// Exit codes:
//   0 = green (all gates passed)
//   1 = red (regression)
//   2 = harness error (vite did not boot)

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SCREENSHOT_DIR = resolve(HERE, '..', 'screenshots');

mkdirSync(SCREENSHOT_DIR, { recursive: true });

// --- Minimal PNG decoder (truecolor/truecolor-alpha, 8-bit, no interlace) ---
// Sufficient for playwright screenshots. Returns { width, height, channels,
// stats: { meanR, meanG, meanB, stddevLuma } } over a strided sample.
function decodePngStats(buf) {
  // PNG signature + chunk walk to collect IHDR + IDAT.
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
    pos = dataStart + len + 4; // skip data + CRC
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // Undo PNG row filters (each row prefixed by 1 filter-type byte).
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
  // Strided color + luma stats.
  let n = 0, rAcc = 0, gAcc = 0, bAcc = 0, sum = 0, sumSq = 0;
  const sampleStep = channels * 53; // prime-ish stride
  for (let i = 0; i + channels <= out.length; i += sampleStep) {
    const rr = out[i], gg = out[i + 1], bb = out[i + 2];
    const luma = 0.299 * rr + 0.587 * gg + 0.114 * bb;
    rAcc += rr; gAcc += gg; bAcc += bb; sum += luma; sumSq += luma * luma; n++;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return {
    width, height, channels,
    stats: {
      meanR: rAcc / n, meanG: gAcc / n, meanB: bAcc / n,
      meanLuma: mean, stddevLuma: Math.sqrt(Math.max(0, variance)),
    },
  };
}

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-level-switch', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let portUrl = null;
viteProc.stdout.on('data', (chunk) => {
  const s = chunk.toString();
  process.stdout.write(`[vite] ${s}`);
  const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
  if (m) portUrl = m[1];
});
viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

const deadline = Date.now() + 30000;
while (!portUrl && Date.now() < deadline) await sleep(200);
if (!portUrl) {
  console.error('FAIL: vite did not become ready in 30s');
  viteProc.kill();
  process.exit(2);
}
console.log(`[smoke-browser] using ${portUrl}`);

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
    '--ignore-gpu-blocklist',
  ],
  chromiumSandbox: true,
});
const ctx = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
// Fatal page errors (uncaught throws) fail the gate; benign sub-resource 404s
// (e.g. favicon) do NOT -- they also appear on known-good demos like hello/cube.
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`PAGEERROR: ${e.message}`));

function fail(msg) {
  console.error(`[smoke-browser] RED - ${msg}`);
  try { viteProc.kill('SIGTERM'); } catch { /* best-effort */ }
  Promise.resolve(browser.close()).finally(() => process.exit(1));
  throw new Error(`SMOKE_FAIL: ${msg}`);
}

async function shootAndDecode(name) {
  const path = resolve(SCREENSHOT_DIR, `${name}.png`);
  const png = await page.screenshot({ path });
  const decoded = decodePngStats(png);
  console.log(`[smoke-browser] ${name}: ${decoded.width}x${decoded.height} ` +
    `meanRGB=(${decoded.stats.meanR.toFixed(1)},${decoded.stats.meanG.toFixed(1)},${decoded.stats.meanB.toFixed(1)}) ` +
    `luma=${decoded.stats.meanLuma.toFixed(1)} stddev=${decoded.stats.stddevLuma.toFixed(1)}`);
  return decoded.stats;
}

await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('#level-switch-hud', { timeout: 10000 });
await page.waitForTimeout(3000);

// --- tutorial ---
await page.keyboard.press('1');
await page.waitForTimeout(2500);
let hud = await page.evaluate(() => document.getElementById('level-switch-hud')?.innerText ?? '');
console.log(`[smoke-browser] after key '1': ${hud}`);
if (!hud.includes('tutorial')) fail(`HUD expected 'tutorial', got: ${hud}`);
const tutorialStats = await shootAndDecode('tutorial');

// --- street-a ---
await page.keyboard.press('2');
await page.waitForTimeout(2500);
hud = await page.evaluate(() => document.getElementById('level-switch-hud')?.innerText ?? '');
console.log(`[smoke-browser] after key '2': ${hud}`);
if (!hud.includes('street-a')) fail(`HUD expected 'street-a', got: ${hud}`);
const streetStats = await shootAndDecode('street-a');

// --- main-menu ---
await page.keyboard.press('3');
await page.waitForTimeout(1500);
hud = await page.evaluate(() => document.getElementById('level-switch-hud')?.innerText ?? '');
console.log(`[smoke-browser] after key '3': ${hud}`);
if (!hud.includes('main-menu')) fail(`HUD expected 'main-menu', got: ${hud}`);

const MIN_STDDEV = 6.0;
const MIN_LUMA = 8.0;

// --- M41: invalid variants must be refused atomically in the same App/World/page ---

const m41BeforeStats = await shootAndDecode('m41-before-invalid');
const m41Invalid = await page.evaluate(() => globalThis.__forgeax_level_switch__.m41.runInvalid());
const invalidDetail = {
  code: 'invalid-variant',
  name: 'LevelId',
  got: 'm41-runtime-invalid',
  valid: ['main-menu', 'tutorial', 'street-a'],
};
const m41StableFields = [
  'worldIdentity',
  'level',
  'previousLevel',
  'session',
  'previousSession',
  'pendingNextState',
  'mainMenuExitAlive',
  'tutorialEnterAlive',
  'repairedScopeAlive',
  'callbackRuns',
  'entityCount',
  'meshEntityCount',
  'activeComponents',
  'execution',
  'appErrorCount',
];
function m41SnapshotsEqual(left, right) {
  return m41StableFields.every((field) => JSON.stringify(left[field]) === JSON.stringify(right[field]));
}
if (
  m41Invalid.ok !== true ||
  m41Invalid.request?.ok !== false ||
  m41Invalid.request?.code !== 'invalid-variant' ||
  JSON.stringify(m41Invalid.request?.detail) !== JSON.stringify(invalidDetail) ||
  m41Invalid.forceRequest?.ok !== false ||
  m41Invalid.forceRequest?.code !== 'invalid-variant' ||
  JSON.stringify(m41Invalid.forceRequest?.detail) !== JSON.stringify(invalidDetail) ||
  m41Invalid.frameCode !== null ||
  !m41SnapshotsEqual(m41Invalid.before, m41Invalid.afterRequest) ||
  !m41SnapshotsEqual(m41Invalid.before, m41Invalid.afterFrame)
) {
  fail(`M41 invalid variant was not an atomic structured refusal: ${JSON.stringify(m41Invalid)}`);
}
const m41AfterInvalidStats = await shootAndDecode('m41-after-invalid');
const invalidPixelDelta =
  Math.abs(m41BeforeStats.meanR - m41AfterInvalidStats.meanR) +
  Math.abs(m41BeforeStats.meanG - m41AfterInvalidStats.meanG) +
  Math.abs(m41BeforeStats.meanB - m41AfterInvalidStats.meanB);
if (invalidPixelDelta > 5.0) {
  fail(`M41 invalid request changed the rendered frame: pixelDelta=${invalidPixelDelta.toFixed(2)}`);
}
console.log(`[smoke-browser] M41 invalid refusal PASS: ${JSON.stringify({ invalid: m41Invalid, pixelDelta: invalidPixelDelta })}`);

const m41Repaired = await page.evaluate(() => globalThis.__forgeax_level_switch__.m41.repair());
const repaired = m41Repaired.snapshot;
if (
  m41Repaired.ok !== true ||
  m41Repaired.request?.ok !== true ||
  m41Repaired.frameCode !== null ||
  repaired.worldIdentity !== m41Invalid.before.worldIdentity ||
  repaired.level !== 'tutorial' ||
  repaired.previousLevel !== 'main-menu' ||
  repaired.session !== m41Invalid.before.session ||
  repaired.previousSession !== m41Invalid.before.previousSession ||
  repaired.pendingNextState !== null ||
  repaired.mainMenuExitAlive !== false ||
  repaired.tutorialEnterAlive !== false ||
  repaired.repairedScopeAlive !== true ||
  repaired.callbackRuns !== 1 ||
  repaired.appErrorCount !== m41Invalid.before.appErrorCount
) {
  fail(`M41 valid same-page repair did not transition exactly once: ${JSON.stringify(m41Repaired)}`);
}
const m41RepairedStats = await shootAndDecode('m41-repaired');
if (m41RepairedStats.stddevLuma < MIN_STDDEV && m41RepairedStats.meanLuma < MIN_LUMA) {
  fail(`M41 repaired frame is near-uniform dark: ${JSON.stringify(m41RepairedStats)}`);
}

const m41Cleaned = await page.evaluate(() => globalThis.__forgeax_level_switch__.m41.cleanup());
const cleaned = m41Cleaned.snapshot;
if (
  m41Cleaned.ok !== true ||
  m41Cleaned.cleanupRequest?.ok !== true ||
  m41Cleaned.cleanupFrameCode !== null ||
  m41Cleaned.forceCleanupRequest?.ok !== true ||
  m41Cleaned.forceCleanupFrameCode !== null ||
  m41Cleaned.resumeCode !== null ||
  cleaned.worldIdentity !== m41Invalid.before.worldIdentity ||
  cleaned.level !== 'main-menu' ||
  cleaned.previousLevel !== 'main-menu' ||
  cleaned.pendingNextState !== null ||
  cleaned.repairedScopeAlive !== false ||
  cleaned.callbackRuns !== 1 ||
  cleaned.appErrorCount !== m41Invalid.before.appErrorCount
) {
  fail(`M41 cleanup was not idempotent and stale-request free: ${JSON.stringify(m41Cleaned)}`);
}
const m41CleanedAgain = await page.evaluate(() => globalThis.__forgeax_level_switch__.m41.cleanup());
if (
  m41CleanedAgain.ok !== true ||
  m41CleanedAgain.reason !== 'already-clean' ||
  JSON.stringify(m41CleanedAgain.snapshot) !== JSON.stringify(cleaned)
) {
  fail(`M41 second cleanup changed the same World: ${JSON.stringify(m41CleanedAgain)}`);
}
console.log(`[smoke-browser] M41 PASS: ${JSON.stringify({ invalid: m41Invalid, repaired: m41Repaired, cleaned: m41Cleaned })}`);

// --- M29: poisoned World requires a fresh execution rebuild ---

await page.waitForFunction(() => globalThis.__forgeax_level_switch__?.m29 !== undefined, null, { timeout: 10000 });
const m29Failed = await page.evaluate(() => globalThis.__forgeax_level_switch__.m29.runFault());
const failed = m29Failed.snapshot;
if (
  m29Failed.ok !== true ||
  m29Failed.frameCode !== 'app-system-update-failed' ||
  failed.level !== 'tutorial' ||
  failed.previousLevel !== 'main-menu' ||
  failed.session !== 'boot' ||
  failed.mainMenuExitAlive !== false ||
  failed.tutorialEnterAlive !== false ||
  failed.meshEntityCount !== 2 ||
  failed.worldHealth !== 'poisoned' ||
  failed.appErrorCount !== 1 ||
  failed.lastAppErrorCode !== 'app-system-update-failed' ||
  failed.lastCauseMatches !== true
) {
  fail(`M29 failure snapshot did not preserve the partial commit and poison boundary: ${JSON.stringify(m29Failed)}`);
}
console.log(`[smoke-browser] M29 fault: ${JSON.stringify(failed)}`);

const m29Recovery = await page.evaluate(() => globalThis.__forgeax_level_switch__.m29.recoveryRequired());
const recovery = m29Recovery.snapshot;
if (
  m29Recovery.ok !== true ||
  m29Recovery.recovery !== 'fresh-world-required' ||
  recovery.worldIdentity !== failed.worldIdentity ||
  recovery.worldHealth !== 'poisoned' ||
  recovery.appErrorCount !== 1 ||
  recovery.lastCauseMatches !== true
) {
  fail(`M29 poison recovery boundary was not explicit: ${JSON.stringify(m29Recovery)}`);
}
console.log(`[smoke-browser] M29 PASS: ${JSON.stringify({ failed, recovery })}`);

// Fatal page errors only.
if (pageErrors.length > 0) {
  pageErrors.forEach((e) => console.error(`  ${e}`));
  fail(`${pageErrors.length} uncaught page error(s)`);
}

// GATE B/C: each level frame must have rendered geometry (the floor plane fills
// roughly the top half of the frame). A black/empty frame is near-uniform with
// near-zero luma. The orange/blue floor gives clear luma + spatial variance.
for (const [name, st] of [['tutorial', tutorialStats], ['street-a', streetStats]]) {
  if (st.stddevLuma < MIN_STDDEV && st.meanLuma < MIN_LUMA) {
    fail(
      `${name} frame is near-uniform dark (stddev=${st.stddevLuma.toFixed(2)}, ` +
        `luma=${st.meanLuma.toFixed(2)}) -- nothing rendered (B1 black-screen regression).`,
    );
  }
}

// GATE D: tutorial vs street-a frames must differ (orange unlit vs blue PBR
// floor). Identical mean color means the scene swap changed nothing on screen.
const dR = Math.abs(tutorialStats.meanR - streetStats.meanR);
const dG = Math.abs(tutorialStats.meanG - streetStats.meanG);
const dB = Math.abs(tutorialStats.meanB - streetStats.meanB);
const colorDelta = dR + dG + dB;
console.log(`[smoke-browser] tutorial-vs-street-a mean color delta = ${colorDelta.toFixed(2)} (R${dR.toFixed(1)} G${dG.toFixed(1)} B${dB.toFixed(1)})`);
const MIN_COLOR_DELTA = 20.0;
if (colorDelta < MIN_COLOR_DELTA) {
  fail(
    `tutorial and street-a frames are too similar (colorDelta=${colorDelta.toFixed(2)} < ${MIN_COLOR_DELTA}) -- ` +
      `the state switch did not change the rendered scene (only the HUD).`,
  );
}

// Record machine-readable stats next to the PNGs for the verify visual gate.
writeFileSync(
  resolve(SCREENSHOT_DIR, 'stats.json'),
  JSON.stringify(
    {
      tutorial: tutorialStats,
      streetA: streetStats,
      colorDelta,
      m41BeforeInvalid: m41BeforeStats,
      m41AfterInvalid: m41AfterInvalidStats,
      m41Repaired: m41RepairedStats,
      m41InvalidPixelDelta: invalidPixelDelta,
    },
    null,
    2,
  ),
);

console.log('\n[smoke-browser] GREEN - canvas rendered per level + frames differ across switch.');
console.log(`  GATE B/C: tutorial luma=${tutorialStats.meanLuma.toFixed(1)} stddev=${tutorialStats.stddevLuma.toFixed(1)}; street-a luma=${streetStats.meanLuma.toFixed(1)} stddev=${streetStats.stddevLuma.toFixed(1)}`);
console.log(`  GATE D: cross-switch color delta=${colorDelta.toFixed(2)}`);
console.log(`  visualSSOT: ${SCREENSHOT_DIR}/tutorial.png, ${SCREENSHOT_DIR}/street-a.png`);

await browser.close();
viteProc.kill('SIGTERM');
await sleep(500);
process.exit(0);
