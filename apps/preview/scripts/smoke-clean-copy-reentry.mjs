#!/usr/bin/env node
// P7 clean-copy proof: Stop must dispose the first Preview instance before a
// fresh page boot creates the same inspection surface again.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_CLEAN_COPY_DIR ?? resolve(ROOT, '.forgeax-debug/clean-copy-reentry'),
);
const PORT = Number.parseInt(process.env.FORGEAX_CLEAN_COPY_PORT ?? '5201', 10);
const CYCLES = 3;
mkdirSync(ARTIFACT_DIR, { recursive: true });

const production = process.env.FORGEAX_CLEAN_COPY_MODE === 'production';
const server = spawn(
  'pnpm',
  production
    ? ['--filter', '@forgeax/preview', 'preview', '--host', '127.0.0.1', '--port', String(PORT)]
    : ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)],
  { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
    badResponses.push(`${response.status()} ${response.url()}`);
  }
});

async function boot() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?game=game-default`, {
      waitUntil: 'domcontentloaded',
        timeout: 2_000,
      });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForFunction(
    () => {
      const inspection = globalThis.__forgeaxPreviewInspection;
      const listed = inspection?.list();
      return (listed?.actions.length ?? 0) >= 4 && (listed?.reads.length ?? 0) >= 2;
    },
    null,
    { timeout: 30_000, polling: 100 },
  );
  return page.evaluate(async (isProduction) => {
    const inspection = globalThis.__forgeaxPreviewInspection;
    if (!inspection) throw new Error('Preview inspection global is unavailable after clean boot');
    return {
      listed: inspection.list(),
      snapshot: await inspection.read('game-default.snapshot'),
      capture: isProduction ? await inspection.captureFrame(1) : null,
    };
  }, production);
}

try {
  const cycles = [];
  let expectedProjectionIds = null;
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    const before = await boot();
    const projectionIds = {
      actions: before.listed.actions.map((entry) => entry.id).sort(),
      reads: before.listed.reads.map((entry) => entry.id).sort(),
    };
    if (projectionIds.actions.length < 4 || projectionIds.reads.length < 2) {
      throw new Error(`projection surface drifted on cycle ${cycle}: ${JSON.stringify(before.listed)}`);
    }
    if (expectedProjectionIds === null) expectedProjectionIds = projectionIds;
    else if (JSON.stringify(projectionIds) !== JSON.stringify(expectedProjectionIds)) {
      throw new Error(`projection surface changed across clean boots on cycle ${cycle}: ${JSON.stringify({ expectedProjectionIds, projectionIds })}`);
    }
    if (!before.snapshot.ok || before.snapshot.value.state.phase !== 'Play') {
      throw new Error(`clean boot snapshot failed on cycle ${cycle}: ${JSON.stringify(before.snapshot)}`);
    }
    if (
      production &&
      (before.capture?.ok !== false || before.capture.error?.code !== 'rhi-debug-unavailable')
    ) {
      throw new Error(`production capture boundary was not explicit on cycle ${cycle}: ${JSON.stringify(before.capture)}`);
    }
    await page.screenshot({ path: resolve(ARTIFACT_DIR, `cycle-${cycle}-before.png`) });

    const reset = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.reset'));
    await page.waitForTimeout(250);
    const afterReset = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.read('game-default.snapshot'));
    if (!reset.ok || !afterReset.ok || afterReset.value.state.phase !== 'Play') {
      throw new Error(`reset failed on cycle ${cycle}: ${JSON.stringify({ reset, afterReset })}`);
    }

    await page.evaluate(() => window.postMessage({ type: 'VAG_PREVIEW_DISPOSE' }, '*'));
    await page.waitForTimeout(100);
    const cleared = await page.evaluate(() => globalThis.__forgeaxPreviewInspection === undefined);
    if (!cleared) throw new Error(`inspection global survived Stop on cycle ${cycle}`);
    cycles.push({ cycle, before, reset, afterReset, cleared });
  }

  const report = { cycles, pageErrors, consoleErrors, badResponses, serverOutput };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter(
    (line) => !line.includes('favicon') && !line.includes('Failed to load resource'),
  );
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  console.log(`[clean-copy-reentry] PASS mode=${production ? 'production' : 'dev'} cycles=${cycles.length} resetCycles=${cycles.filter((entry) => entry.reset.ok).length} cleared=${cycles.every((entry) => entry.cleared)}`);
  console.log(`[clean-copy-reentry] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  if (server.pid !== undefined) {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
  }
  await sleep(300);
}
