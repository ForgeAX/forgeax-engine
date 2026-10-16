#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { observeViteHttpReadiness } from '../../../../scripts/lib/vite-http-readiness.mjs';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const ARTIFACT_DIR = resolve(HERE, '..', '.forgeax-debug', 'dom-input-pick');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const viteProc = spawn('pnpm', ['-F', '@forgeax/hello-picking', 'dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const viteReadiness = observeViteHttpReadiness(viteProc, {
  timeoutEnvName: 'FORGEAX_PICKING_SERVER_READINESS_TIMEOUT_MS',
});

try {
  const { origin: portUrl, elapsedMs: serverReadyElapsedMs } = await viteReadiness.wait();

  const browser = await chromium.launch({
    headless: true,
    channel: process.env.FORGEAX_CHROME_CHANNEL ?? browserLaunch.channel,
    args: [...browserLaunch.args, ...(process.env.CI ? ['--use-angle=swiftshader'] : [])],
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    const pageErrors = [];
    const consoleErrors = [];
    const logs = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      logs.push(message.text());
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(portUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForSelector('#app', { timeout: 10_000 });
    if (!logs.includes('[picking] Standard pipeline active')) {
      await page.waitForEvent('console', {
        predicate: message => message.text() === '[picking] Standard pipeline active',
        timeout: 60_000,
      });
    }

    const beforePath = resolve(ARTIFACT_DIR, 'before-click.png');
    const hitPath = resolve(ARTIFACT_DIR, 'after-hit.png');
    const missPath = resolve(ARTIFACT_DIR, 'after-miss.png');
    const movedPath = resolve(ARTIFACT_DIR, 'after-transform.png');
    const cameraPath = resolve(ARTIFACT_DIR, 'after-camera.png');
    await page.screenshot({ path: beforePath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    await page.mouse.click(400, 300);
    await page.waitForTimeout(500);
    if (!logs.some((line) => line.startsWith('[picking] hit entity='))) {
      throw new Error(`center click did not produce a pick hit; logs=${JSON.stringify(logs)}`);
    }
    const pointerVertex = logs.find((line) => line.startsWith('[picking] vertex phase=pointer'));
    if (!pointerVertex?.includes('scene=[{')) {
      throw new Error(`center click did not produce vertex hits; logs=${JSON.stringify(logs)}`);
    }
    await page.screenshot({ path: hitPath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    await page.mouse.click(1, 1);
    await page.waitForTimeout(500);
    if (!logs.includes('[picking] miss (no entity under pointer)')) {
      throw new Error(`corner click did not produce a pick miss; logs=${JSON.stringify(logs)}`);
    }
    const missVertex = logs.find((line) => line.startsWith('[picking] vertex phase=pointer') && line.includes('scene=[]'));
    if (!missVertex) {
      throw new Error(`corner click did not produce a vertex miss; logs=${JSON.stringify(logs)}`);
    }
    await page.screenshot({ path: missPath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    await page.locator('#mutate-transform').click();
    await page.waitForTimeout(500);
    if (!logs.includes('[picking] transform phase=updated posX=0.25')) {
      throw new Error(`transform button did not update the live cube; logs=${JSON.stringify(logs)}`);
    }
    const movedVertex = logs.find((line) => line.startsWith('[picking] vertex phase=after-transform'));
    if (!movedVertex?.includes('scene=[{')) {
      throw new Error(`live transform did not recover vertex hits; logs=${JSON.stringify(logs)}`);
    }
    await page.screenshot({ path: movedPath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    await page.locator('#update-camera').click();
    await page.waitForTimeout(500);
    if (!logs.includes('[picking] camera phase=updated aspect=1.1 fov=1.0472')) {
      throw new Error(`camera update did not reach the live projection; logs=${JSON.stringify(logs)}`);
    }
    const cameraVertex = logs.find((line) => line.startsWith('[picking] vertex phase=after-camera'));
    if (!cameraVertex?.includes('scene=[{')) {
      throw new Error(`camera update did not preserve vertex hits; logs=${JSON.stringify(logs)}`);
    }
    await page.screenshot({ path: cameraPath, clip: { x: 300, y: 200, width: 200, height: 200 } });

    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    const unexpectedConsoleErrors = consoleErrors.filter((line) => !line.includes('404'));
    if (unexpectedConsoleErrors.length > 0) {
      throw new Error(`console errors: ${unexpectedConsoleErrors.join(' | ')}`);
    }

    const before = PNG.sync.read(readFileSync(beforePath));
    const hit = PNG.sync.read(readFileSync(hitPath));
    const changedPixels = pixelmatch(before.data, hit.data, undefined, before.width, before.height, {
      threshold: 0.1,
    });
    if (changedPixels < 20) {
      throw new Error(`hit click changed only ${changedPixels} pixels in the canvas capture`);
    }

    console.log(`[smoke-browser] artifacts: before=${beforePath} hit=${hitPath} miss=${missPath} moved=${movedPath} camera=${cameraPath}`);
    console.log(`[smoke-browser] PASS - real browser pointer hit/miss plus live vertex transform and camera recovery are GREEN; changedPixels=${changedPixels}; serverReadyElapsedMs=${serverReadyElapsedMs}.`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  viteProc.kill('SIGTERM');
  await sleep(300);
}
