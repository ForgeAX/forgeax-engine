import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { waitGizmoFrames } from '../browser-host.mjs';
import { smokeFrameBudget } from '../../../../shared/scripts/smoke-receipt.mjs';

test('the real host forwards the explicit shader manifest ahead of an existing local default', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'forgeax-gizmo-host-'));
  const repository = resolve(import.meta.dirname, '../../../../..');
  const scripts = join(root, 'apps/hello/transform-gizmo/scripts');
  const manager = join(root, 'pnpm.cjs');
  const selected = join(root, 'selected-manifest.json');
  const fallback = join(root, 'shared-build-inputs/manifest.json');
  const previous = Object.fromEntries(['npm_execpath', 'GIZMO_URL', 'FORGEAX_SHARED_APP_INPUTS_MANIFEST'].map(key => [key, process.env[key]]));
  let host;
  try {
    mkdirSync(scripts, { recursive: true });
    mkdirSync(join(root, 'shared-build-inputs'));
    writeFileSync(selected, '{}');
    writeFileSync(fallback, '{"obsolete":true}');
    copyFileSync(resolve(import.meta.dirname, '../browser-host.mjs'), join(scripts, 'browser-host.mjs'));
    symlinkSync(join(repository, 'scripts'), join(root, 'scripts'), 'dir');
    symlinkSync(join(repository, 'apps/shared'), join(root, 'apps/shared'), 'dir');
    // Keep the actual child-process and HTTP-readiness path; the child exposes
    // the forwarded environment without starting a shader build or GPU device.
    writeFileSync(manager, `
const http = require('node:http');
const server = http.createServer((_request, response) => response.end(JSON.stringify({ manifest: process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST })));
server.listen(0, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + server.address().port));
`);
    process.env.npm_execpath = manager;
    delete process.env.GIZMO_URL;
    process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = selected;
    const { startGizmoHost } = await import(pathToFileURL(join(scripts, 'browser-host.mjs')).href);
    host = await startGizmoHost();
    assert.equal((await (await fetch(host.url)).json()).manifest, selected);
    await host.stop();
    host = undefined;
    delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    host = await startGizmoHost();
    assert.equal((await (await fetch(host.url)).json()).manifest, fallback);
  } finally {
    await host?.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('the submitted-frame admission uses its declared budget with real Playwright', async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20);
    await page.setContent('<div>Frame admission contract</div>', { timeout: 10000 });
    const observed = smokeFrameBudget() + 1;
    await page.evaluate((observed) => {
      let frames = 0;
      globalThis.__gizmo = { frames: () => frames };
      setTimeout(() => { frames = observed; }, 100);
    }, observed);
    await waitGizmoFrames(page);
    assert.equal(await page.evaluate(() => globalThis.__gizmo.frames()), observed);
  } finally {
    await browser.close();
  }
});

test('the real frame admission honors an explicit smoke minimum', async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome-beta',
    chromiumSandbox: true,
  });
  const previous = process.env.SMOKE_MIN_FRAMES;
  try {
    process.env.SMOKE_MIN_FRAMES = '300';
    const page = await browser.newPage();
    await page.setContent('<div>Explicit completed-frame minimum</div>');
    await page.evaluate(() => {
      let frames = 61;
      globalThis.__gizmo = { frames: () => frames };
      setTimeout(() => { frames = 301; }, 100);
    });
    await waitGizmoFrames(page);
    assert.equal(await page.evaluate(() => globalThis.__gizmo.frames()), 301);
  } finally {
    if (previous === undefined) delete process.env.SMOKE_MIN_FRAMES;
    else process.env.SMOKE_MIN_FRAMES = previous;
    await browser.close();
  }
});
