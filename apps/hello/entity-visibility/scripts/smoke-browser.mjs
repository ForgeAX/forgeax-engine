#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const CANVAS_WIDTH = 640;
const CANVAS_HEIGHT = 360;
const TARGET_ROI = { x0: 280, y0: 225, x1: 360, y1: 315 };
const SHADOW_ROI = { x0: 220, y0: 310, x1: 320, y1: 355 };
const CHILD_ROI = { x0: 380, y0: 200, x1: 480, y1: 310 };

function describeStructuredError(error) {
  if (typeof error !== 'object' || error === null) return error;
  return {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
    detail: error.detail,
    message: error.message,
  };
}

const variant = process.env.FORGEAX_FALSIFY_VARIANT ?? '';
const port = process.env.FORGEAX_ENTITY_VISIBILITY_PORT ?? '5173';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const appUrl = `http://127.0.0.1:${port}/?variant=${encodeURIComponent(variant)}`;
const evidenceDir = resolve(
  repoRoot,
  'artifacts/feat-20260803-entity-visibility/screenshots',
);

function scaledRoi(frame, roi) {
  return {
    x0: Math.floor((roi.x0 / CANVAS_WIDTH) * frame.width),
    y0: Math.floor((roi.y0 / CANVAS_HEIGHT) * frame.height),
    x1: Math.ceil((roi.x1 / CANVAS_WIDTH) * frame.width),
    y1: Math.ceil((roi.y1 / CANVAS_HEIGHT) * frame.height),
  };
}

function colorCount(frame, roi, color) {
  const area = scaledRoi(frame, roi);
  let count = 0;
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      const offset = (y * frame.width + x) * 4;
      const red = frame.data[offset] ?? 0;
      const green = frame.data[offset + 1] ?? 0;
      const blue = frame.data[offset + 2] ?? 0;
      if (color === 'red' && red > 80 && red > green * 1.5 && red > blue * 1.3) count += 1;
      if (color === 'blue' && blue > 70 && blue > red * 1.3 && blue > green * 1.2) count += 1;
      if (color === 'gold' && red > 80 && green > 45 && red > blue * 2 && green > blue * 1.5)
        count += 1;
    }
  }
  return count;
}

function roiDelta(first, second, roi) {
  if (first.width !== second.width || first.height !== second.height) {
    throw new Error('PNG dimensions changed between visibility phases');
  }
  const area = scaledRoi(first, roi);
  let changedPixels = 0;
  let totalL1 = 0;
  let pixels = 0;
  for (let y = area.y0; y < area.y1; y += 1) {
    for (let x = area.x0; x < area.x1; x += 1) {
      const offset = (y * first.width + x) * 4;
      const l1 =
        Math.abs((first.data[offset] ?? 0) - (second.data[offset] ?? 0)) +
        Math.abs((first.data[offset + 1] ?? 0) - (second.data[offset + 1] ?? 0)) +
        Math.abs((first.data[offset + 2] ?? 0) - (second.data[offset + 2] ?? 0));
      if (l1 > 15) changedPixels += 1;
      totalL1 += l1;
      pixels += 1;
    }
  }
  return { changedPixels, meanL1: totalL1 / pixels };
}

function evaluate({ baseline, hidden, restored, child, evidence }) {
  const targetRed = {
    baseline: colorCount(baseline.frame, TARGET_ROI, 'red'),
    hidden: colorCount(hidden.frame, TARGET_ROI, 'red'),
    restored: colorCount(restored.frame, TARGET_ROI, 'red'),
  };
  const childColors = {
    blue: colorCount(child.frame, CHILD_ROI, 'blue'),
    gold: colorCount(child.frame, CHILD_ROI, 'gold'),
  };
  const hiddenShadowDelta = roiDelta(baseline.frame, hidden.frame, SHADOW_ROI);
  const restoredShadowDelta = roiDelta(restored.frame, hidden.frame, SHADOW_ROI);
  const failures = [];
  if (targetRed.baseline <= 1_000)
    failures.push('baseline-render-output: target ROI has no red target');
  if (targetRed.hidden >= targetRed.baseline * 0.05) {
    failures.push('hidden-render-output: red target remains in the hidden target ROI');
  }
  if (targetRed.restored <= targetRed.baseline * 0.8) {
    failures.push('restored-render-output: red target did not return to the target ROI');
  }
  if (hiddenShadowDelta.changedPixels <= 500 || hiddenShadowDelta.meanL1 <= 20) {
    failures.push('hidden-shadow-output: target shadow remains in the floor ROI');
  }
  if (restoredShadowDelta.changedPixels <= 500 || restoredShadowDelta.meanL1 <= 20) {
    failures.push('restored-shadow-output: target shadow did not return to the floor ROI');
  }
  if (childColors.blue <= 1_000 || childColors.gold <= 100) {
    failures.push(
      'visible-child-override-output: child or inherited descendant is absent from the child ROI',
    );
  }
  if (evidence.hidden.targetEffective !== 'hidden') {
    failures.push('hidden-render-output: production visibility input did not resolve hidden');
  }
  if (evidence.restored.targetEffective !== 'visible') {
    failures.push('restored-render-output: production visibility input did not resolve visible');
  }
  if (
    evidence.child.visibleChildEffective !== 'visible' ||
    evidence.child.inheritedDescendantEffective !== 'visible'
  ) {
    failures.push('visible-child-override-output: hierarchy did not resolve visible');
  }
  return { targetRed, childColors, hiddenShadowDelta, restoredShadowDelta, failures };
}

const vite = spawn(
  'pnpm',
  [
    '--filter',
    '@forgeax/hello-entity-visibility',
    'exec',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    port,
  ],
  {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    detached: true,
  },
);

let ready = false;
vite.stdout.on('data', (chunk) => {
  process.stdout.write(`[vite] ${chunk}`);
  if (chunk.toString().includes('Local:')) ready = true;
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite-err] ${chunk}`));

try {
  const deadline = Date.now() + 30_000;
  while (!ready && Date.now() < deadline) await delay(100);
  if (!ready) throw new Error('vite did not become ready');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    });
    await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () => typeof globalThis.__forgeaxEntityVisibility?.ready === 'function',
      null,
      {
        timeout: 30_000,
      },
    );
    await page.waitForFunction(
      async () => (await globalThis.__forgeaxEntityVisibility.ready())?.ok === true,
      null,
      {
        timeout: 30_000,
      },
    );
    await mkdir(evidenceDir, { recursive: true });
    const canvas = page.locator('#app');
    const prefix = variant || 'repaired';
    const capture = async (phase) => {
      const path = resolve(evidenceDir, `${prefix}-${phase}.png`);
      const bytes = await canvas.screenshot({ path, type: 'png' });
      return { path, frame: PNG.sync.read(bytes) };
    };
    await delay(180);
    const baseline = await capture('baseline');
    const baselineEvidence = await page.evaluate(() =>
      globalThis.__forgeaxEntityVisibility.evidence(),
    );
    await page.evaluate(() => globalThis.__forgeaxEntityVisibility.setTargetHidden());
    await delay(180);
    const hidden = await capture('hidden');
    const hiddenEvidence = await page.evaluate(() =>
      globalThis.__forgeaxEntityVisibility.evidence(),
    );
    await page.evaluate(() => globalThis.__forgeaxEntityVisibility.setTargetVisible());
    await delay(180);
    const restored = await capture('restored');
    const restoredEvidence = await page.evaluate(() =>
      globalThis.__forgeaxEntityVisibility.evidence(),
    );
    await page.evaluate(() =>
      globalThis.__forgeaxEntityVisibility.setAncestorHiddenWithVisibleChild(),
    );
    await delay(180);
    const child = await capture('visible-child');
    const childEvidence = await page.evaluate(() =>
      globalThis.__forgeaxEntityVisibility.evidence(),
    );
    const evidence = {
      baseline: baselineEvidence,
      hidden: hiddenEvidence,
      restored: restoredEvidence,
      child: childEvidence,
    };
    const result = evaluate({ baseline, hidden, restored, child, evidence });
    const report = {
      variant: variant || null,
      screenshots: [baseline.path, hidden.path, restored.path, child.path],
      observed: { evidence, ...result, failures: undefined },
      verdict: result.failures.length === 0 ? 'pass' : 'fail',
      confidence: 'high',
      failures: result.failures,
    };
    console.log(JSON.stringify(report));
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[smoke-browser] FAIL: ${JSON.stringify(describeStructuredError(error))}`);
  process.exitCode = 1;
} finally {
  try {
    if (vite.pid !== undefined) process.kill(-vite.pid, 'SIGTERM');
  } catch {
    vite.kill('SIGTERM');
  }
}
