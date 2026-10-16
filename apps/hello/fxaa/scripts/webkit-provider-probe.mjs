#!/usr/bin/env node

import { webkit } from 'playwright';

const timeoutMs = Number(process.env.FORGEAX_WEBKIT_PROBE_TIMEOUT_MS ?? 15_000);
const startedAt = Date.now();
let browser;
let stage = 'launch';

async function bounded(name, operation, limit = timeoutMs) {
  stage = name;
  let timeout;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`webkit-provider-probe timeout at ${name}`)), limit);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

try {
  const launchOptions = { headless: true };
  if (process.env.FORGEAX_WEBKIT_EXECUTABLE_PATH !== undefined) {
    launchOptions.executablePath = process.env.FORGEAX_WEBKIT_EXECUTABLE_PATH;
  }
  browser = await bounded('launch', () => webkit.launch(launchOptions));
  const page = await bounded('newPage', () => browser.newPage({ viewport: { width: 64, height: 64 } }));
  await bounded('data-navigation', () => page.goto('data:text/html,<script>requestAnimationFrame(() => document.body.dataset.raf=\'1\')</script><body></body>', { waitUntil: 'load' }));
  await bounded('raf', () => page.waitForFunction(() => document.body.dataset.raf === '1'));
  await bounded('screenshot', () => page.screenshot());
  console.log(JSON.stringify({
    status: 'pass',
    stage,
    elapsedMs: Date.now() - startedAt,
    executablePath: launchOptions.executablePath ?? null,
  }));
} catch (error) {
  console.error(JSON.stringify({
    status: 'provider-unavailable',
    stage,
    elapsedMs: Date.now() - startedAt,
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack ?? '' } : String(error),
  }));
  process.exitCode = 2;
} finally {
  if (browser !== undefined) await bounded('close', () => browser.close()).catch(() => undefined);
}
