#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const artifacts = resolve(here, '..', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const vite = spawn('pnpm', ['--filter', '@forgeax/bevy-animated-transform', 'dev'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let url;
vite.stdout.on('data', (chunk) => {
  const text = String(chunk);
  process.stdout.write(`[vite] ${text}`);
  url ??= text.match(/Local:\s+(http:\/\/[^\s]+)/)?.[1];
});
vite.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${String(chunk)}`));

try {
  const deadline = Date.now() + 30_000;
  while (!url && Date.now() < deadline) await delay(100);
  if (!url) throw new Error('Vite did not become ready');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true});
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForFunction(
      () =>
        globalThis.__bevyAnimatedTransformEvidence?.running === true &&
        globalThis.__bevyAnimatedTransformEvidence.motion === true &&
        globalThis.__bevyAnimatedTransformEvidence.isolation === true,
      undefined,
      { timeout: 20_000 },
    );
    const screenshot = resolve(artifacts, 'animated-transform-browser.png');
    await page.screenshot({ path: screenshot });
    console.log('[smoke-browser] PASS - running=1 motion=1 isolation=1');
    console.log(`[smoke-browser] screenshot=${screenshot}`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(`[smoke-browser] FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  vite.kill('SIGTERM');
  await delay(300);
}
