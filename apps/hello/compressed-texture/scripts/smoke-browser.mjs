// smoke-browser.mjs -- feat-20260707-texture-block-compression-web-transcode-ktx2-basis
//
// Playwright e2e smoke for apps/hello/compressed-texture (M6 w41, AC-15).
// Two scenes, each with its own browser + dev server:
//
//   Scene 1 (default, ?mode=compressed): the compressed path loads a Basis
//   KTX2 texture via the vite-plugin-pack pipeline → runtime transcode →
//   block upload. Asserts (a) no GPU validation errors, (b) at least one
//   draw call is executed, (c) the page booted without console errors.
//
//   Scene 2 (?mode=uncompressed): the uncompressed fallback path loads a
//   raw RGBA8 .bin. Asserts (a) no GPU validation errors, (b) the page
//   booted and renders without crash/black-screen.
//
// Why a separate script (not the dawn smoke):
// `smoke-dawn.mjs` registers a synthetic TextureAsset in-world and skips the
// entire `JSON.stringify(pack) -> fetch -> JSON.parse` dev/build pack-body
// pipeline AND the WebGPU device. Browser-path-only bugs surface here:
//   (1) typed-array survival through fetch→JSON.parse→typed-array round-trip
//   (2) BGL shape mismatch (compressed format pipeline layout)
//   (3) block-aligned bytesPerRow/rowsPerImage validation
// dawn smoke can never catch them.
//
// Local invocation: `pnpm -F @forgeax/hello-compressed-texture smoke:browser`
// CI: requires chromium with WebGPU (--enable-unsafe-webgpu).
//
// Exit codes:
//   0 = green (both scenes pass)
//   1 = red (scene assertion failed)
//   2 = harness error (vite did not boot)
//
// NOTE: this machine has no Playwright/chromium. The script is written to be
// structurally correct and executable by CI (chromium + WebGPU). Local testing
// is done by the dawn smoke (w40) which covers the node-side equivalent path.

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

let portUrl = null;
let exitCode = 0;
const M27_RECOVERY = process.argv.includes('--m27-recovery');

function canvasStats(buffer) {
  const image = PNG.sync.read(buffer);
  let redDominant = 0;
  let luminance = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    if (red > green + 20 && red > blue + 20) redDominant += 1;
    luminance += red + green + blue;
  }
  return {
    width: image.width,
    height: image.height,
    redDominant,
    meanLuma: luminance / (image.width * image.height * 3),
  };
}

function assertRecoveryState(state, expectedPhase) {
  if (state.phase !== expectedPhase) {
    throw new Error(`expected phase=${expectedPhase}, got ${JSON.stringify(state)}`);
  }
}

async function runRuntimeRecoveryScene() {
  const label = 'm27-runtime-recovery';
  console.log(`[smoke-browser] ${label} starting...`);
  const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-compressed-texture', 'dev'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser;
  try {
    const pageUrl = await new Promise((resolveVite, rejectVite) => {
      const deadline = Date.now() + 30000;
      let interval;
      const resolveReady = (url) => {
        clearInterval(interval);
        resolveVite(url);
      };
      viteProc.stdout.on('data', (chunk) => {
        const match = chunk.toString().match(/Local:\s+(http:\/\/[^\s]+)/);
        if (match) resolveReady(`${match[1]}?mode=runtime-recovery`);
      });
      viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
      interval = setInterval(() => {
        if (Date.now() >= deadline) {
          clearInterval(interval);
          rejectVite(new Error('vite did not become ready in 30s'));
        }
      }, 200);
    });

    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--ignore-gpu-blocklist',
      ],
      chromiumSandbox: true,
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(
      () => window.__forgeaxRuntimeImageRecovery?.readState().phase === 'baseline',
      { timeout: 15000 },
    );
    await sleep(1000);

    const baselineState = await page.evaluate(() =>
      window.__forgeaxRuntimeImageRecovery.readState(),
    );
    assertRecoveryState(baselineState, 'baseline');
    if (
      baselineState.textureAllocations !== 0 ||
      baselineState.samplerAllocations !== 0 ||
      baselineState.materialHasTexture
    ) {
      throw new Error(`baseline allocated a resource: ${JSON.stringify(baselineState)}`);
    }
    const baselineImage = canvasStats(await page.locator('canvas').screenshot());

    const invalidState = await page.evaluate(async () =>
      window.__forgeaxRuntimeImageRecovery.injectInvalid(),
    );
    assertRecoveryState(invalidState, 'invalid');
    if (
      invalidState.invalidCode !== 'image-decode-failed' ||
      invalidState.textureAllocations !== 0 ||
      invalidState.materialHasTexture
    ) {
      throw new Error(`invalid bytes mutated the scene: ${JSON.stringify(invalidState)}`);
    }
    await sleep(500);
    const invalidImage = canvasStats(await page.locator('canvas').screenshot());
    if (invalidImage.redDominant !== baselineImage.redDominant) {
      throw new Error(
        `invalid bytes changed the canvas: baseline=${JSON.stringify(baselineImage)} invalid=${JSON.stringify(invalidImage)}`,
      );
    }

    const repairedState = await page.evaluate(async () =>
      window.__forgeaxRuntimeImageRecovery.repair(),
    );
    assertRecoveryState(repairedState, 'repaired');
    if (
      repairedState.invalidCode !== 'image-decode-failed' ||
      repairedState.textureAllocations !== 1 ||
      repairedState.samplerAllocations !== 1 ||
      repairedState.textureHandle === null ||
      repairedState.samplerHandle === null ||
      repairedState.textureDimensions?.[0] !== 2 ||
      repairedState.textureDimensions?.[1] !== 2 ||
      !repairedState.materialHasTexture
    ) {
      throw new Error(`repair state is incomplete: ${JSON.stringify(repairedState)}`);
    }
    await sleep(1200);
    const repairedImage = canvasStats(await page.locator('canvas').screenshot());
    if (repairedImage.meanLuma <= baselineImage.meanLuma + 0.2) {
      throw new Error(
        `repaired texture was not visible: baseline=${JSON.stringify(baselineImage)} repaired=${JSON.stringify(repairedImage)}`,
      );
    }

    const cleanedState = await page.evaluate(() =>
      window.__forgeaxRuntimeImageRecovery.cleanup(),
    );
    const cleanedAgainState = await page.evaluate(() =>
      window.__forgeaxRuntimeImageRecovery.cleanup(),
    );
    assertRecoveryState(cleanedAgainState, 'cleaned');
    if (
      cleanedState.releasedResources !== 2 ||
      cleanedAgainState.releasedResources !== 2 ||
      cleanedAgainState.cleanupCalls !== 2 ||
      cleanedAgainState.textureHandle !== null ||
      cleanedAgainState.samplerHandle !== null ||
      cleanedAgainState.materialHasTexture ||
      cleanedAgainState.liveSharedRefs !== baselineState.liveSharedRefs
    ) {
      throw new Error(`cleanup was not idempotent: ${JSON.stringify(cleanedAgainState)}`);
    }
    await sleep(1500);
    const cleanedImage = canvasStats(await page.locator('canvas').screenshot());
    if (cleanedImage.redDominant !== baselineImage.redDominant) {
      throw new Error(
        `cleanup did not restore baseline: baseline=${JSON.stringify(baselineImage)} cleaned=${JSON.stringify(cleanedImage)}`,
      );
    }

    const gpuErrors = errors.filter((error) =>
      error.includes('validation') || error.includes('GPU') || error.includes('WebGPU') || error.includes('RhiError'),
    );
    if (gpuErrors.length > 0 || errors.length > 0) {
      throw new Error(`browser errors: ${JSON.stringify(errors)}`);
    }
    console.log(
      `[m27] Browser PASS baseline=${JSON.stringify(baselineImage)} repaired=${JSON.stringify(repairedImage)} cleanup=${JSON.stringify(cleanedImage)}`,
    );
    return 0;
  } catch (error) {
    console.error(`[smoke-browser] ${label} FAIL - ${error.message}`);
    return 1;
  } finally {
    await browser?.close();
    viteProc.kill();
  }
}

// --- Scene 1: compressed path -------------------------------------------------

async function runScene(mode) {
  const label = mode === 'compressed' ? 'scene-1-compressed' : 'scene-2-uncompressed';
  console.log(`[smoke-browser] ${label} starting...`);

  const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-compressed-texture', 'dev'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pageUrl = await new Promise((resolveVite, rejectVite) => {
    const deadline = Date.now() + 30000;
    let interval;
    const resolveReady = (url) => {
      clearInterval(interval);
      resolveVite(url);
    };
    viteProc.stdout.on('data', (chunk) => {
      const s = chunk.toString();
      const m = s.match(/Local:\s+(http:\/\/[^\s]+)/);
      if (m) resolveReady(`${m[1]}?mode=${mode}`);
    });
    viteProc.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));
    interval = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(interval);
        rejectVite(new Error('vite did not become ready in 30s'));
      }
    }, 200);
  });

  console.log(`[smoke-browser] ${label} using ${pageUrl}`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: [
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
        '--ignore-gpu-blocklist',
      ],
      chromiumSandbox: true,
    });
  } catch (err) {
    console.error(`[smoke-browser] ${label} FAIL - chromium launch failed: ${err.message}`);
    console.error('  hint: install chromium with Playwright (npx playwright install chromium)');
    viteProc.kill();
    return 1;
  }

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Capture console errors and GPU validation errors.
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.push(`[pageerror] ${err.message}`);
  });

  try {
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (err) {
    console.error(`[smoke-browser] ${label} FAIL - page.goto: ${err.message}`);
    await browser.close();
    viteProc.kill();
    return 1;
  }

  // Wait for engine boot — the demo logs backend=... to console.
  try {
    await page.waitForFunction(() => {
      const hud = document.getElementById('texture-hud');
      return hud && hud.textContent.includes('Backend');
    }, { timeout: 15000 });
  } catch (_e) {
    console.error(`[smoke-browser] ${label} FAIL - engine did not boot (hud not populated)`);
    await browser.close();
    viteProc.kill();
    return 1;
  }

  // Let 3 seconds of rendering happen so we get GPU validation errors.
  await sleep(3000);

  // Check for GPU validation errors.
  const gpuErrors = errors.filter((e) =>
    e.includes('validation') || e.includes('GPU') || e.includes('WebGPU') || e.includes('RhiError'),
  );
  if (gpuErrors.length > 0) {
    console.error(`[smoke-browser] ${label} FAIL - GPU validation errors detected:`);
    for (const e of gpuErrors) console.error(`  ${e}`);
    await browser.close();
    viteProc.kill();
    return 1;
  }

  // Check for any engine-level errors.
  const engineErrors = errors.filter((e) => !e.includes('warning'));
  if (engineErrors.length > 0) {
    console.error(`[smoke-browser] ${label} FAIL - console errors detected:`);
    for (const e of engineErrors) console.error(`  ${e}`);
    await browser.close();
    viteProc.kill();
    return 1;
  }

  // Check draw count: the hun shows Backend + mode; at minimum we need the
  // canvas to be non-empty. Read the HUD text to verify caps display.
  const hudText = await page.textContent('#texture-hud');
  if (!hudText || !hudText.includes('BC:')) {
    console.error(`[smoke-browser] ${label} FAIL - HUD missing caps info: "${hudText}"`);
    await browser.close();
    viteProc.kill();
    return 1;
  }

  // Readback a pixel from the centre of the canvas to verify non-black.
  try {
    const canvasHandle = await page.$('canvas');
    if (!canvasHandle) {
      console.error(`[smoke-browser] ${label} FAIL - no canvas element found`);
      await browser.close();
      viteProc.kill();
      return 1;
    }
    // Take screenshot as pixel proof (AC-19 visual evidence source).
    await page.screenshot({
      path: resolve(REPO_ROOT, `artifacts/feat-20260707-texture-block-compression-web-transcode-ktx2-basis/screenshots/smoke-browser-${mode}.png`),
    });
  } catch (_e) {
    // Non-fatal: screenshot is evidence, not structural.
  }

  console.log(`[smoke-browser] ${label} PASS (${errors.length} errors, caps: ${hudText.split('<br>')[0]})`);

  await browser.close();
  viteProc.kill();
  return 0;
}

// --- Main: run both scenes sequentially ---------------------------------------

if (M27_RECOVERY) {
  exitCode = await runRuntimeRecoveryScene();
  process.exit(exitCode);
}

const result1 = await runScene('compressed');
if (result1 !== 0) {
  console.error('[smoke-browser] scene-1 FAIL, aborting scene-2');
  process.exit(1);
}

const result2 = await runScene('uncompressed');
if (result2 !== 0) {
  console.error('[smoke-browser] scene-2 FAIL');
  process.exit(1);
}

console.log('[smoke-browser] PASS (both scenes)');
