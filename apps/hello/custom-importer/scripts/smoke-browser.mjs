#!/usr/bin/env node
// Browser HMR smoke for the host-importer content path.
//
// This is deliberately a source mutation, not a direct API probe:
//   edit source -> Vite watcher -> catalog delta -> browser
//   -> dev pack/import route -> loadByGuid -> host-driven scene.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { createOwnedProcessGroupStopper } from '../../../shared/scripts/rhi-debug-process.mjs';
import { observeViteHttpReadiness } from '../../../../scripts/lib/vite-http-readiness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');
const sourcePath = resolve(appRoot, 'assets/level-1.reel.json');
const metaPath = resolve(appRoot, 'assets/level-1.reel.json.meta.json');
const artifactDir = resolve(appRoot, '.forgeax-debug/m2-browser-hmr');
const port = Number.parseInt(process.env.FORGEAX_CUSTOM_IMPORTER_PORT ?? '5196', 10);

mkdirSync(artifactDir, { recursive: true });
const originalSource = readFileSync(sourcePath, 'utf8');
const originalMetaSource = readFileSync(metaPath, 'utf8');
const original = JSON.parse(originalSource);
const originalMeta = JSON.parse(originalMetaSource);
const mutatedTitle = `${original.title} HMR Reloaded`;
const mutated = {
  ...original,
  title: mutatedTitle,
  reels: original.reels.map((reel, index) => ({
    ...reel,
    x: reel.x + (index === 1 ? 0.75 : 0),
  })),
};
const mutatedMeta = {
  ...originalMeta,
  revision: {
    ...originalMeta.revision,
    digest: 'level-1-reel-v2',
    observedAt: 2,
  },
};

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-custom-importer', 'dev'], {
  cwd: repoRoot,
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
const stopVite = createOwnedProcessGroupStopper(viteProc);
const viteReadiness = observeViteHttpReadiness(viteProc, {
  timeoutEnvName: 'FORGEAX_CUSTOM_IMPORTER_STARTUP_TIMEOUT_MS',
});

let browser;
let failure;
try {
  const { origin: portUrl } = await viteReadiness.wait();
  if (!portUrl.includes(`:${port}`)) throw new Error(`unexpected Vite URL: ${portUrl}`);

  browser = await chromium.launch({
    ...browserLaunch,
    args: [...browserLaunch.args, ...(process.env.CI ? ['--use-angle=swiftshader'] : [])],
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel,
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const logs = [];
  const pageErrors = [];
  const consoleErrors = [];
  let pageLoads = 0;
  page.on('load', () => {
    pageLoads += 1;
  });
  page.on('console', (message) => {
    logs.push(message.text());
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(portUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('#asset-status')?.textContent?.includes('Reel Game Level 1'),
    null,
    { timeout: 30_000 },
  );
  const beforePath = resolve(artifactDir, 'before-hmr.png');
  await page.screenshot({ path: beforePath });

  writeFileSync(sourcePath, `${JSON.stringify(mutated, null, 2)}\n`);
  writeFileSync(metaPath, `${JSON.stringify(mutatedMeta, null, 2)}\n`);
  await page.waitForFunction(
    (title) => document.querySelector('#asset-status')?.textContent?.includes(title),
    mutatedTitle,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(500);
  const afterPath = resolve(artifactDir, 'after-hmr.png');
  await page.screenshot({ path: afterPath });

  const before = PNG.sync.read(readFileSync(beforePath));
  const after = PNG.sync.read(readFileSync(afterPath));
  const changedPixels = pixelmatch(before.data, after.data, undefined, before.width, before.height, {
    threshold: 0.1,
  });
  const reloadLogs = logs.filter((line) => line.includes('[custom-importer] loaded reel-game blob'));
  const changedLog = reloadLogs.find((line) => line.includes(JSON.stringify(mutatedTitle)));
  if (!changedLog) throw new Error(`browser did not log the mutated blob; logs=${JSON.stringify(reloadLogs)}`);
  if (pageLoads > 1) throw new Error(`valid catalog HMR required a page reload: pageLoads=${pageLoads}`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('404'));
  if (unexpectedConsoleErrors.length > 0) {
    throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
  }

  console.log(`[smoke-browser] artifacts: before=${beforePath} after=${afterPath}`);
  console.log(
    `[smoke-browser] PASS - browser HMR reloaded changed host asset content; title=${JSON.stringify(mutatedTitle)}, changedPixels=${changedPixels}.`,
  );
} catch (error) {
  failure = error;
} finally {
  writeFileSync(sourcePath, originalSource);
  writeFileSync(metaPath, originalMetaSource);
  if (browser) await browser.close();
  await stopVite();
}

if (failure) {
  console.error(`[smoke-browser] FAIL - ${failure instanceof Error ? failure.message : String(failure)}`);
  process.exitCode = 1;
}
