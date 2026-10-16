#!/usr/bin/env node
// M26 and M32 real Chrome journeys. M26 proves mesh-owned material defaults;
// M32 proves same-page shared-handle generation fencing and repair.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..', '..');
const M32_RECOVERY = process.argv.includes('--m32-recovery');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ??
    resolve(APP_ROOT, '.forgeax-debug', M32_RECOVERY ? 'm32-browser' : 'm26-browser'),
);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const vite = spawn('pnpm', ['-F', '@forgeax/hello-multi-material', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let url;
vite.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  process.stdout.write(`[vite] ${text}`);
  url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1]?.replace(/\/$/, '');
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function colors(bytes) {
  const image = PNG.sync.read(bytes);
  let red = 0;
  let cyan = 0;
  let blue = 0;
  for (let index = 0; index < image.width * image.height; index++) {
    const x = index % image.width;
    const y = Math.floor(index / image.width);
    // Playwright's canvas element screenshot includes the overlapping HUD
    // compositor layer in Chromium. Exclude that fixed UI rectangle so the
    // pixel oracle measures only the render target, not state-panel coverage.
    if (x >= 450 && y < 330) continue;
    const offset = index * 4;
    const r = image.data[offset] ?? 0;
    const g = image.data[offset + 1] ?? 0;
    const b = image.data[offset + 2] ?? 0;
    if (r > 128 && r - Math.max(g, b) >= 32) red++;
    if (g > 96 && b > 96 && r < 96) cyan++;
    if (b > 128 && b - Math.max(r, g) >= 32) blue++;
  }
  return { red, cyan, blue, width: image.width, height: image.height };
}

try {
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await sleep(200);
  if (!url) throw new Error('Vite did not publish a URL in 30s');

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
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`${url}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () => typeof globalThis.__forgeaxMultiMaterial?.readState === 'function',
      undefined,
      { timeout: 30_000 },
    );
    await page.waitForFunction(
      () => {
        const state = globalThis.__forgeaxMultiMaterial.readState();
        return state.bindings.length === 2 && state.diagnostics.length === 0;
      },
      undefined,
      { timeout: 30_000 },
    );
    await page.evaluate(() => {
      document.querySelector('#mm-hud')?.setAttribute('hidden', '');
      document.querySelector('#mm-controls')?.setAttribute('hidden', '');
    });
    const waitForRenderFrame = async () => {
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
    };

    if (M32_RECOVERY) {
      const baselinePath = resolve(ARTIFACT_DIR, 'm32-baseline.png');
      const preRepairPath = resolve(ARTIFACT_DIR, 'm32-pre-repair.png');
      const repairedPath = resolve(ARTIFACT_DIR, 'm32-repaired.png');
      const cleanupPath = resolve(ARTIFACT_DIR, 'm32-cleanup.png');

      await page.evaluate(() => globalThis.__forgeaxMultiMaterial.m32Baseline());
      await page.waitForFunction(
        () => {
          const state = globalThis.__forgeaxMultiMaterial.readM32State();
          return state.stage === 'baseline' && state.bindings.length === 2 && state.diagnostics.length === 0;
        },
        undefined,
        { timeout: 10_000 },
      );
      await waitForRenderFrame();
      const baselinePng = await page.locator('#app').screenshot({ path: baselinePath });
      const baseline = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readM32State());
      const baselineColors = colors(baselinePng);
      assert(baselineColors.red > 0 && baselineColors.cyan > 0, `M32 baseline pixels: ${JSON.stringify(baselineColors)}`);
      assert(baseline.bindings[0]?.handle === baseline.oldHandle, `M32 old handle was not bound: ${JSON.stringify(baseline)}`);
      assert(baseline.bindings[1]?.handle === baseline.siblingHandle, `M32 sibling was not bound: ${JSON.stringify(baseline)}`);
      assert(baseline.refcounts.old === 2 && baseline.refcounts.sibling === 2, `M32 baseline refs: ${JSON.stringify(baseline)}`);

      await page.evaluate(() => globalThis.__forgeaxMultiMaterial.m32Invalidate());
      await page.waitForFunction(
        () => globalThis.__forgeaxMultiMaterial.readM32State().stage === 'stale',
        undefined,
        { timeout: 10_000 },
      );
      await waitForRenderFrame();
      const preRepairPng = await page.locator('#app').screenshot({ path: preRepairPath });
      const stale = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readM32State());
      const preRepairColors = colors(preRepairPng);
      assert(
        stale.stale?.code === 'shared-ref-stale' &&
          stale.stale.detail.slot === stale.oldSlot &&
          stale.stale.detail.expectedGeneration === stale.oldGeneration &&
          stale.stale.detail.actualGeneration === stale.replacementGeneration,
        `M32 stale detail: ${JSON.stringify(stale)}`,
      );
      assert(
        stale.replacementHandle !== stale.oldHandle &&
          stale.replacementGeneration === stale.oldGeneration + 1,
        `M32 old/fresh handles aliased: ${JSON.stringify(stale)}`,
      );
      assert(stale.bindings[0]?.handle !== stale.oldHandle && stale.bindings[0]?.source === 'mesh-default', `M32 stale handle remained visible: ${JSON.stringify(stale)}`);
      assert(stale.bindings[1]?.handle === baseline.bindings[1]?.handle, `M32 sibling changed before repair: ${JSON.stringify({ baseline, stale })}`);
      assert(stale.refcounts.old === 0 && stale.refcounts.replacement === 1 && stale.refcounts.sibling === 2, `M32 stale refs: ${JSON.stringify(stale)}`);
      assert(
        Math.abs(preRepairColors.red - baselineColors.red) <= baselineColors.red * 0.02 &&
          Math.abs(preRepairColors.cyan - baselineColors.cyan) <= baselineColors.cyan * 0.02 &&
          preRepairColors.blue === baselineColors.blue,
        `M32 pixels changed before fresh binding: ${JSON.stringify({ baselineColors, preRepairColors })}`,
      );

      await page.evaluate(() => globalThis.__forgeaxMultiMaterial.m32Repair());
      await page.waitForFunction(
        () => {
          const state = globalThis.__forgeaxMultiMaterial.readM32State();
          return state.stage === 'repaired' && state.diagnostics.length === 0 && state.bindings[0]?.handle === state.replacementHandle;
        },
        undefined,
        { timeout: 10_000 },
      );
      await waitForRenderFrame();
      const repairedPng = await page.locator('#app').screenshot({ path: repairedPath });
      const repaired = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readM32State());
      const repairedColors = colors(repairedPng);
      assert(repairedColors.blue > 0 && repairedColors.cyan > 0, `M32 repaired pixels: ${JSON.stringify(repairedColors)}`);
      assert(repairedColors.red < baselineColors.red / 4, `M32 target semantic identity did not change: ${JSON.stringify({ baselineColors, repairedColors })}`);
      assert(repaired.bindings[1]?.handle === baseline.bindings[1]?.handle, `M32 healthy sibling changed during repair: ${JSON.stringify({ baseline, repaired })}`);
      assert(repaired.refcounts.old === 0 && repaired.refcounts.replacement === 2 && repaired.refcounts.sibling === 2, `M32 repaired refs: ${JSON.stringify(repaired)}`);

      await page.evaluate(() => globalThis.__forgeaxMultiMaterial.m32Cleanup());
      await page.waitForFunction(
        () => {
          const state = globalThis.__forgeaxMultiMaterial.readM32State();
          return state.stage === 'cleaned' && state.diagnostics.length === 0;
        },
        undefined,
        { timeout: 10_000 },
      );
      await waitForRenderFrame();
      const cleanupPng = await page.locator('#app').screenshot({ path: cleanupPath });
      const cleanup = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readM32State());
      await page.evaluate(() => globalThis.__forgeaxMultiMaterial.m32Cleanup());
      await page.waitForTimeout(300);
      const cleanupAgain = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readM32State());
      const cleanupColors = colors(cleanupPng);
      assert(JSON.stringify(cleanupAgain) === JSON.stringify(cleanup), `M32 cleanup was not idempotent: ${JSON.stringify({ cleanup, cleanupAgain })}`);
      assert(cleanup.refcounts.old === 0 && cleanup.refcounts.replacement === 0 && cleanup.refcounts.sibling === 0, `M32 refs were not balanced: ${JSON.stringify(cleanup)}`);
      assert(
        cleanupColors.blue === 0 &&
          Math.abs(cleanupColors.red - baselineColors.red) <= baselineColors.red * 0.02 &&
          Math.abs(cleanupColors.cyan - baselineColors.cyan) <= baselineColors.cyan * 0.02,
        `M32 cleanup did not restore baseline colors: ${JSON.stringify({ baselineColors, cleanupColors })}`,
      );
      assert(pageErrors.length === 0, `M32 page errors: ${pageErrors.join(' | ')}`);
      assert(consoleErrors.length === 0, `M32 console errors: ${consoleErrors.join(' | ')}`);

      const evidence = {
        baseline,
        stale,
        repair: repaired,
        cleanup,
        pixels: {
          baseline: { path: baselinePath, sha256: hash(baselinePng), colors: baselineColors },
          preRepair: { path: preRepairPath, sha256: hash(preRepairPng), colors: preRepairColors },
          repaired: { path: repairedPath, sha256: hash(repairedPng), colors: repairedColors },
          cleanup: { path: cleanupPath, sha256: hash(cleanupPng), colors: cleanupColors },
        },
        pageErrors,
        consoleErrors,
      };
      writeFileSync(resolve(ARTIFACT_DIR, 'm32-browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(
        `[m32] Browser PASS baseline=${JSON.stringify(baselineColors)} preRepair=${JSON.stringify(preRepairColors)} ` +
          `repair=${JSON.stringify(repairedColors)} cleanup=${JSON.stringify(cleanupColors)}`,
      );
    } else {
    const baselinePath = resolve(ARTIFACT_DIR, 'baseline.png');
    const faultPath = resolve(ARTIFACT_DIR, 'overflow.png');
    const repairedPath = resolve(ARTIFACT_DIR, 'repaired.png');
    const cleanupPath = resolve(ARTIFACT_DIR, 'cleanup.png');
    const baselinePng = await page.locator('#app').screenshot({ path: baselinePath });
    const baseline = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readState());
    const baselineColors = colors(baselinePng);
    assert(baseline.diagnostics.length === 0, `baseline diagnostics: ${JSON.stringify(baseline)}`);
    assert(
      baseline.bindings.every((binding) => binding.source === 'mesh-default'),
      `baseline did not inherit mesh defaults: ${JSON.stringify(baseline)}`,
    );
    assert(baselineColors.red > 0 && baselineColors.cyan > 0, `baseline pixels: ${JSON.stringify(baselineColors)}`);

    await page.evaluate(() => globalThis.__forgeaxMultiMaterial.injectOverflow());
    await page.waitForFunction(
      () => globalThis.__forgeaxMultiMaterial.readState().diagnostics.some(
        (diagnostic) => diagnostic.code === 'mesh-renderer-material-override-overflow',
      ),
      undefined,
      { timeout: 10_000 },
    );
    await waitForRenderFrame();
    const faultPng = await page.locator('#app').screenshot({ path: faultPath });
    const fault = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readState());
    const overflow = fault.diagnostics.find(
      (diagnostic) => diagnostic.code === 'mesh-renderer-material-override-overflow',
    );
    const faultColors = colors(faultPng);
    assert(overflow !== undefined, `overflow diagnostic missing: ${JSON.stringify(fault)}`);
    assert(
      overflow.detail?.expectedCount === 2 && overflow.detail?.actualCount === 3,
      `overflow detail is not structured: ${JSON.stringify(overflow)}`,
    );
    assert(
      fault.bindings.every((binding) => binding.source === 'mesh-default'),
      `invalid override displaced defaults: ${JSON.stringify(fault)}`,
    );
    assert(
      faultColors.red > 0 && faultColors.cyan > 0,
      `invalid override did not preserve default pixels: ${JSON.stringify(faultColors)}`,
    );

    await page.evaluate(() => globalThis.__forgeaxMultiMaterial.repair());
    await page.waitForFunction(
      () => {
        const state = globalThis.__forgeaxMultiMaterial.readState();
        return state.diagnostics.length === 0 && state.bindings[0]?.source === 'renderer-override';
      },
      undefined,
      { timeout: 10_000 },
    );
    await waitForRenderFrame();
    const repairedPng = await page.locator('#app').screenshot({ path: repairedPath });
    const repaired = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readState());
    const repairedColors = colors(repairedPng);
    assert(repaired.bindings[1]?.source === 'mesh-default', `healthy sibling lost default provenance: ${JSON.stringify(repaired)}`);
    assert(repaired.bindings[1]?.handle === baseline.bindings[1]?.handle, 'healthy sibling handle changed during repair');
    assert(repairedColors.blue > 0 && repairedColors.cyan > 0, `repair pixels: ${JSON.stringify(repairedColors)}`);
    assert(repairedColors.red < baselineColors.red / 4, `target slot pixels did not change: ${JSON.stringify({ baselineColors, repairedColors })}`);

    await page.evaluate(() => globalThis.__forgeaxMultiMaterial.cleanup());
    await page.waitForFunction(
      () => {
        const state = globalThis.__forgeaxMultiMaterial.readState();
        return state.diagnostics.length === 0 && state.bindings.every((binding) => binding.source === 'mesh-default');
      },
      undefined,
      { timeout: 10_000 },
    );
    await waitForRenderFrame();
    const cleanupPng = await page.locator('#app').screenshot({ path: cleanupPath });
    const cleanup = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readState());
    await page.evaluate(() => globalThis.__forgeaxMultiMaterial.cleanup());
    await page.waitForTimeout(300);
    const cleanupAgain = await page.evaluate(() => globalThis.__forgeaxMultiMaterial.readState());
    const cleanupColors = colors(cleanupPng);
    assert(JSON.stringify(cleanupAgain) === JSON.stringify(cleanup), `cleanup was not idempotent: ${JSON.stringify({ cleanup, cleanupAgain })}`);
    assert(
      cleanupColors.blue === 0 &&
        Math.abs(cleanupColors.red - baselineColors.red) <= baselineColors.red * 0.02 &&
        Math.abs(cleanupColors.cyan - baselineColors.cyan) <= baselineColors.cyan * 0.02,
      `cleanup did not restore baseline colors: ${JSON.stringify({ baselineColors, cleanupColors })}`,
    );
    assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`);
    const unexpectedConsoleErrors = consoleErrors.filter(
      (line) => !line.includes('[AssetError mesh-renderer-material-override-overflow]'),
    );
    assert(unexpectedConsoleErrors.length === 0, `unexpected console errors: ${unexpectedConsoleErrors.join(' | ')}`);

    const evidence = {
      baseline,
      fault,
      repair: repaired,
      cleanup,
      pixels: {
        baseline: { path: baselinePath, sha256: hash(baselinePng), colors: baselineColors },
        fault: { path: faultPath, sha256: hash(faultPng), colors: faultColors },
        repaired: { path: repairedPath, sha256: hash(repairedPng), colors: repairedColors },
        cleanup: { path: cleanupPath, sha256: hash(cleanupPng), colors: cleanupColors },
      },
      pageErrors,
      consoleErrors,
    };
    writeFileSync(resolve(ARTIFACT_DIR, 'browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(
      `[m26] Browser PASS defaults=${JSON.stringify(baselineColors)} overflow=${JSON.stringify(faultColors)} ` +
        `repair=${JSON.stringify(repairedColors)} cleanup=${JSON.stringify(cleanupColors)}`,
    );
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[${M32_RECOVERY ? 'm32' : 'm26'}] Browser FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  vite.kill('SIGTERM');
  await sleep(300);
}
