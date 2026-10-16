#!/usr/bin/env node
// Minimal public-symbol sandbox for AI authoring evidence.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.env.POINTS_LINES_SANDBOX_PORT ?? 5195);
const baseUrl = process.env.POINTS_LINES_BASE_URL ?? `http://127.0.0.1:${port}`;
const outputDir = process.env.POINTS_LINES_SANDBOX_DIR ?? mkdtempSync(join(tmpdir(), 'forgeax-points-lines-sandbox-'));

function assert(condition, message) {
  if (!condition) throw new Error(`[ai-authoring-sandbox] ${message}`);
}

let server;
if (process.env.POINTS_LINES_BASE_URL === undefined) {
  server = spawn('pnpm', ['--filter', '@forgeax/hello-topology', 'dev', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}
const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  try {
    if ((await fetch(`${baseUrl}/`)).ok) break;
  } catch {
    // The focused carrier may still be starting.
  }
  await new Promise((resolveReady) => setTimeout(resolveReady, 100));
}

const browser = await chromium.launch({
  channel: process.env.POINTS_LINES_CHROME_CHANNEL ?? 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu'],
  chromiumSandbox: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(`${baseUrl}/?evidenceLane=webgpu&authoringSandbox=1`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForFunction(() => window.__pointsLinesEvidence !== undefined, undefined, { timeout: 10000 });
  const inspection = await page.evaluate(() => window.__pointsLinesEvidence.inspect());
  const sandbox = await page.evaluate(() => window.__pointsLinesEvidence.authoringSandbox);
  const screenshot = join(outputDir, 'ai-authoring-webgpu.png');
  await page.screenshot({ path: screenshot, fullPage: false });
  assert(inspection.length === 2, 'focused carrier did not expose both authored entries');
  assert(sandbox === true, 'sandbox route did not own the public World-to-capture closure');
  assert(inspection.every((entry) => entry.drawCount === 1 && entry.lastKnownGood), 'runtime inspection is not resident');
  assert(readFileSync(screenshot).byteLength > 0, 'capture artifact is empty');
  console.log(JSON.stringify({
    publicSymbols: ['Points', 'Lines', 'Materials.unlit', 'admitPointsLines'],
    closure: 'public World -> Standard renderer -> frame -> inspect -> capture',
    inspection,
    screenshot,
    backend: await page.evaluate(() => window.__pointsLinesEvidence.backend),
  }));
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}
