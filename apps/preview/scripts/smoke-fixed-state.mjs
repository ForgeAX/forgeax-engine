#!/usr/bin/env node
// game-default fixed-step/state smoke: semantic state is the oracle, while
// screenshots provide a behavioral reset witness for the same render surface.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(process.env.FORGEAX_FIXED_STATE_DIR ?? resolve(ROOT, 'apps/game-capability-lab/.forgeax-debug/fixed-state'));
const PORT = Number.parseInt(process.env.FORGEAX_FIXED_STATE_PORT ?? '5188', 10);
mkdirSync(ARTIFACT_DIR, { recursive: true });
const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'], chromiumSandbox: true});
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
const badResponses = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} @ ${message.location().url}`); });
page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) badResponses.push(`${response.status()} ${response.url()}`); });
try {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(`http://127.0.0.1:${PORT}/?render-evidence=1`, { waitUntil: 'networkidle', timeout: 2_000 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForFunction(() => Boolean(globalThis.__forgeaxGameDefaultRenderEvidence?.state), undefined, { timeout: 10_000 });
  const read = () => page.evaluate(() => {
    const evidence = globalThis.__forgeaxGameDefaultRenderEvidence;
    if (!evidence?.state) throw new Error('state evidence handle was not installed');
    return evidence.snapshot();
  });
  const before = await read();
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'before-reset.png') });
  const invalidCode = await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.state.requestInvalid());
  if (invalidCode !== 'invalid-variant') throw new Error(`expected invalid-variant, got ${invalidCode}`);
  const fixedBefore = before.state.fixedTicks;
  await page.evaluate(() => globalThis.__forgeaxGameDefaultRenderEvidence.state.requestReset());
  await page.waitForTimeout(250);
  const after = await read();
  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'after-reset.png') });
  const report = { before, invalidCode, after, pageErrors, consoleErrors, badResponses };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
  if (badResponses.length > 0) throw new Error(`bad responses: ${badResponses.join(' | ')}`);
  const actionableConsoleErrors = consoleErrors.filter((line) => !line.includes('favicon') && !line.includes('Failed to load resource'));
  if (actionableConsoleErrors.length > 0) throw new Error(`console errors: ${actionableConsoleErrors.join(' | ')}`);
  if (before.state.phase !== 'Play' || before.state.fixedTicks <= 0) throw new Error(`fixed-step baseline missing: ${JSON.stringify(before.state)}`);
  if (after.state.phase !== 'Play' || after.state.resetTransitions < 1) throw new Error(`reset did not return to Play: ${JSON.stringify(after.state)}`);
  if (after.state.fixedTicks <= fixedBefore) throw new Error(`fixed ticks did not advance: ${fixedBefore} -> ${after.state.fixedTicks}`);
  console.log(`[fixed-state] PASS phase=${after.state.phase} fixedTicks=${after.state.fixedTicks} resetTransitions=${after.state.resetTransitions} invalid=${invalidCode}`);
  console.log(`[fixed-state] artifacts=${ARTIFACT_DIR}`);
} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
}
