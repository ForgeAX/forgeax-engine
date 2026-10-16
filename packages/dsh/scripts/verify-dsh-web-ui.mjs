import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

import { chromium } from 'playwright';
import browserLaunch from '../../../scripts/ci/browser-launch.json' with { type: 'json' };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '..', '..');
const home = await mkdtemp(join(tmpdir(), 'forgeax-dsh-visual-'));
const evidenceDir = resolve(
  process.env.FORGEAX_FEDERATION_EVIDENCE_DIR ?? join(tmpdir(), 'forgeax-dsh-federation-evidence'),
);
const dsh = process.env.DSH_EXECUTABLE ?? 'dsh';
let engineProcess;
let dshProcess;
let browser;

try {
  await mkdir(evidenceDir, { recursive: true });
  await run(dsh, ['plugin', '--profile', 'web', 'add', packageRoot], { DSH_HOME: home });

  engineProcess = await launch(
    'pnpm',
    [
      '--filter',
      '@forgeax/hello-dsh-federation',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ],
    /Local:\s+(http:\/\/127\.0\.0\.1:\d+)/,
    { FORGEAX_SKIP_HARNESS_SYNC: '1' },
  );
  dshProcess = await launch(
    dsh,
    ['web', '--host', '127.0.0.1', '--port', '0'],
    /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\S*)/,
    { DSH_HOME: home, FORGEAX_ENGINE_ENDPOINT: engineProcess.endpoint },
  );

  browser = await chromium.launch({
    ...browserLaunch,
    headless: process.env.FORGEAX_BROWSER_HEADLESS !== '0' && !!process.env.CI,
    channel: process.env.FORGEAX_PLAYWRIGHT_CHANNEL ?? browserLaunch.channel,
    chromiumSandbox: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'en-US' });
  await page.goto(dshProcess.endpoint, { waitUntil: 'domcontentloaded' });
  await dismissIfVisible(page, 'Continue');
  await dismissIfVisible(page, 'Configure later');

  const panel = page.locator('[data-forgeax-panel="mounted"]');
  await panel.waitFor();
  await page.locator('[data-forgeax-ready="true"]').waitFor();
  // Software GPU runs retain the 300-frame requirement without a 30s FPS floor.
  await page.waitForFunction(() => {
    const text = document.querySelector('[data-forgeax-status]')?.textContent ?? '';
    const matched = text.match(/FRAMEID\s*(\d+)/i);
    return Number(matched?.[1] ?? 0) >= 300;
  }, null, { timeout: 180_000 }).catch(async (cause) => {
    const status = await page.locator('[data-forgeax-status]').innerText();
    throw new Error(`DSH did not reach 300 frames: ${status}`, { cause });
  });
  const iframe = page.locator('iframe[data-forgeax-engine-frame="real"]');
  await iframe.waitFor();

  const beforePath = join(evidenceDir, 'dsh-engine-before.png');
  const afterPath = join(evidenceDir, 'dsh-engine-after.png');
  await page.screenshot({ path: beforePath });
  const before = await iframe.screenshot();
  const beforeStatus = await page.locator('[data-forgeax-status]').innerText();

  await page.getByRole('button', { name: 'Toggle Engine state' }).click();
  await page.waitForFunction(() =>
    (document.querySelector('[data-forgeax-status]')?.textContent ?? '').match(/STATE\s*1/i),
  );
  await page.waitForTimeout(300);
  await page.screenshot({ path: afterPath });
  const after = await iframe.screenshot();
  const afterStatus = await page.locator('[data-forgeax-status]').innerText();
  assert(hash(before) !== hash(after), 'Engine iframe pixels must change after deterministic control');

  const openRequests = await countStatusRequests(page, 2200);
  assert(openRequests >= 1 && openRequests <= 3, `visible panel status pull must be bounded: ${openRequests}`);
  await page.getByRole('button', { name: 'Hide preview' }).click();
  await page.waitForTimeout(100);
  const hiddenRequests = await countStatusRequests(page, 1400);
  assert(hiddenRequests === 0, `hidden panel must stop status pull: ${hiddenRequests}`);
  assert((await page.locator('iframe[data-forgeax-engine-frame]').count()) === 0, 'hidden panel removes iframe');

  await dshProcess.stop();
  assert(await reachable(engineProcess.endpoint), 'stopping DSH must not stop the attached Engine');
  await engineProcess.stop();
  assert(!(await reachable(engineProcess.endpoint)), 'Engine verifier must stop its owned dev server');

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      dshUi: new URL(dshProcess.endpoint).origin,
      engine: engineProcess.endpoint,
      beforeStatus,
      afterStatus,
      pixelsChanged: true,
      minimumObservedFrame: 300,
      openStatusRequests: openRequests,
      hiddenStatusRequests: hiddenRequests,
      screenshots: [beforePath, afterPath],
      teardown: { dshStopped: true, attachedEngineSurvived: true, ownedEngineStopped: true },
    })}\n`,
  );
} finally {
  await browser?.close().catch(() => undefined);
  await dshProcess?.stop().catch(() => undefined);
  await engineProcess?.stop().catch(() => undefined);
  await rm(home, { recursive: true, force: true });
}

async function dismissIfVisible(page, name) {
  const button = page.getByRole('button', { name });
  const visible = await button
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (visible) await button.click();
}

async function countStatusRequests(page, durationMs) {
  let count = 0;
  const listener = (request) => {
    if (request.url().includes('/forgeax-federation/v1/status')) count += 1;
  };
  page.on('request', listener);
  await page.waitForTimeout(durationMs);
  page.off('request', listener);
  return count;
}

async function launch(command, args, pattern, env) {
  const child = spawn(command, args, {
    detached: process.platform !== 'win32',
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolvePromise) => child.once('exit', resolvePromise));
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
    await exited;
  };
  const endpoint = await new Promise((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${command} URL timeout: ${output}`)), 15_000);
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      const matched = stripVTControlCharacters(output).match(pattern);
      if (matched?.[1] === undefined) return;
      clearTimeout(timer);
      resolvePromise(matched[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${command} exited before ready: ${code}: ${output}`));
    });
  }).catch(async (error) => {
    if (child.pid !== undefined) await stop();
    throw error;
  });
  return { endpoint, stop };
}

function run(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.once('exit', (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${output}`));
    });
  });
}

async function reachable(endpoint) {
  try {
    return (await fetch(endpoint)).ok;
  } catch {
    return false;
  }
}

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
