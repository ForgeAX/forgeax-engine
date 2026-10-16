#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { PNG } from 'pngjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..', '..');
const artifactDir = process.env.FORGEAX_M10_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'm10-render-feature-browser');
mkdirSync(artifactDir, { recursive: true });
const screenshotPath = resolve(artifactDir, 'm10-browser.png');
const secondScreenshotPath = resolve(artifactDir, 'm10-browser-second.png');
const evidencePath = resolve(artifactDir, 'm10-browser.json');
let vite;
let browser;
let exitCode = 0;

function waitForServer(child) {
  return new Promise((resolveUrl, reject) => {
    let output = '';
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Local:\s+(https?:\/\/[^\s]+)/);
      if (match) resolveUrl(match[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => reject(new Error(`vite exited before ready: ${code}\n${output}`)));
  });
}

try {
  vite = spawn(
    'pnpm',
    ['--filter', '@forgeax/hello-m3-programmable-rendering', 'dev', '--', '--host', '127.0.0.1', '--port', '5188'],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const url = await waitForServer(vite);
  browser = await chromium.launch({
    ...browserLaunch,
    args: [...browserLaunch.args, ...(process.env.CI ? ['--use-angle=swiftshader'] : [])],
    headless: true,
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  const deadline = Date.now() + 30_000;
  let evidence;
  while (Date.now() < deadline) {
    evidence = await page.evaluate(() => globalThis.__forgeaxM10Evidence);
    if (evidence?.status === 'pass') break;
    await delay(100);
  }
  if (evidence?.status !== 'pass') {
    throw new Error(`browser evidence timeout: ${JSON.stringify({ evidence, pageErrors, consoleErrors })}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`browser console errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
  }
  await page.locator('#m10-render-feature').screenshot({ path: screenshotPath });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  await page.locator('#m10-render-feature').screenshot({ path: secondScreenshotPath });
  const png = PNG.sync.read(readFileSync(screenshotPath));
  const secondPng = PNG.sync.read(readFileSync(secondScreenshotPath));
  const centerOffset = ((Math.floor(png.height / 2) * png.width) + Math.floor(png.width / 2)) * 4;
  const centerPixel = [...png.data.slice(centerOffset, centerOffset + 4)];
  const secondCenterPixel = [...secondPng.data.slice(centerOffset, centerOffset + 4)];
  if (centerPixel.slice(0, 3).every((channel) => channel === 17)) {
    throw new Error(`browser screenshot is page background: ${JSON.stringify(centerPixel)}`);
  }
  if (JSON.stringify(centerPixel) !== JSON.stringify(secondCenterPixel)) {
    throw new Error(`browser screenshot pixel is unstable: ${JSON.stringify({ centerPixel, secondCenterPixel })}`);
  }
  await page.evaluate(() => {
    const globals = globalThis;
    globals.__forgeaxM10Dispose?.();
  });
  const disposedEvidence = await page.evaluate(() => globalThis.__forgeaxM10Evidence);
  const finalEvidence = {
    ...(disposedEvidence ?? evidence),
    screenshot: screenshotPath,
    screenshotSize: { width: png.width, height: png.height },
    centerPixel,
    secondScreenshot: secondScreenshotPath,
    secondCenterPixel,
    pixelStable: JSON.stringify(centerPixel) === JSON.stringify(secondCenterPixel),
    pageErrors,
    consoleErrors,
  };
  writeFileSync(evidencePath, `${JSON.stringify(finalEvidence, null, 2)}\n`);
  console.log(`[m10-render-feature] Browser PASS centerPixel=${JSON.stringify(centerPixel)} artifact=${evidencePath} screenshot=${screenshotPath}`);
} catch (error) {
  exitCode = 1;
  const failure = { status: 'fail', error: error instanceof Error ? error.stack : String(error) };
  writeFileSync(resolve(artifactDir, 'm10-browser-failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
  console.error(`[m10-render-feature] Browser FAIL ${failure.error}`);
} finally {
  await browser?.close().catch(() => undefined);
  if (vite !== undefined && vite.exitCode === null) vite.kill('SIGTERM');
}
process.exit(exitCode);
