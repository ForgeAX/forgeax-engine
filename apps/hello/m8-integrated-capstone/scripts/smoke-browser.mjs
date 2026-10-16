#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import browserLaunch from '../../../../scripts/ci/browser-launch.json' with { type: 'json' };
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const appPackage = '@forgeax/hello-m8-integrated-capstone';
const bridgePort = process.env.FORGEAX_M8_BRIDGE_PORT ?? '5748';
const sourcePath = resolve(root, 'apps/hello/m8-integrated-capstone/assets/m8-content.json');
const originalSource = readFileSync(sourcePath, 'utf8');
const originalContent = JSON.parse(originalSource);
const mutatedContent = {
  ...originalContent,
  title: `${originalContent.title} HMR Reloaded`,
  markers: originalContent.markers.map((marker, index) => ({ ...marker, x: marker.x + (index === 1 ? 0.65 : 0) })),
};
const artifactDir = resolve(
  process.env.FORGEAX_M8_ARTIFACT_DIR ??
    resolve(root, '.forgeax-gauntlet', 'hello-m8-integrated-capstone', 'browser'),
);
mkdirSync(artifactDir, { recursive: true });
const env = { ...process.env, INIT_CWD: root, FORGEAX_ENGINE_BRIDGE_PORT: bridgePort, FORGEAX_ENGINE_RHI_DEBUG: '1' };

function parseJson(output, label) {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error(`${label} did not emit JSON: ${trimmed}`);
  try { return JSON.parse(trimmed.slice(start)); } catch (error) { throw new Error(`${label} JSON parse failed: ${error}`); }
}

function liveEval(script) {
  const result = spawnSync(process.execPath, [resolve(root, 'skills/forgeax-engine-cli/scripts/remote-live.mjs'), script], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`remote-live failed: ${result.stderr || result.stdout}`);
  const envelope = parseJson(result.stdout, 'remote-live');
  if (!envelope.ok) throw new Error(`remote-live returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

async function waitForUrl() {
  const url = 'http://localhost:5208';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return url; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error('M8 Vite host did not become reachable on port 5208');
}

async function waitForBridge() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [resolve(root, 'skills/forgeax-engine-cli/scripts/remote-live.mjs'), '--health'], {
      cwd: root, env, encoding: 'utf8',
    });
    if (result.status === 0) {
      const health = parseJson(result.stdout, 'remote-live health');
      if (health.ok && health.pageConnected === true) return health;
    }
    await sleep(250);
  }
  throw new Error('M8 remote-live bridge did not report pageConnected=true');
}

function readPng(path) {
  const png = PNG.sync.read(readFileSync(path));
  let nonBlack = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if ((png.data[i] ?? 0) > 8 || (png.data[i + 1] ?? 0) > 8 || (png.data[i + 2] ?? 0) > 8) nonBlack++;
  }
  return { width: png.width, height: png.height, nonBlack };
}

function copyArtifact(artifact) {
  if (artifact?.kind !== 'rhi-tape' || typeof artifact.path !== 'string' || typeof artifact.digest !== 'string') {
    throw new Error(`capture returned an invalid ArtifactRef: ${JSON.stringify(artifact)}`);
  }
  const candidates = [
    artifact.path,
    resolve(root, artifact.path),
    resolve(root, 'apps/hello/m8-integrated-capstone', artifact.path),
  ];
  const source = candidates.find((path) => existsSync(path));
  if (source === undefined) throw new Error(`single tape artifact missing: ${JSON.stringify(artifact)}`);
  const artifactPath = resolve(artifactDir, 'frame.rhitape');
  copyFileSync(source, artifactPath);
  return { ...artifact, path: artifactPath };
}

function runRhiCli(args, label) {
  const cli = resolve(root, 'packages/devkit/dist/cli.mjs');
  const result = spawnSync(process.execPath, [cli, ...args, '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  const envelope = parseJson(result.stdout, label);
  if (!envelope.ok) throw new Error(`${label} returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

async function captureArtifact(label) {
  const result = await page.evaluate(async (captureLabel) => {
    const captureFn = globalThis.__forgeax?.captureFrame;
    if (typeof captureFn !== 'function') return { ok: false, error: { code: 'capture-unavailable' } };
    const captured = await captureFn();
    if (!captured.ok) return captured;
    const runId = `m8-${captureLabel}-${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
    const response = await fetch(`/__forgeax-debug/tape?runId=${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-forgeax-rhitape' },
      body: captured.value.bytes,
    });
    const payload = await response.json();
    if (!response.ok) return { ok: false, error: payload };
    return {
      ok: true,
      value: {
        ...payload,
        source: 'rhi.capture',
        digest: captured.value.digest,
        runId,
      },
    };
  }, label);
  if (!result.ok) throw new Error(`${label} capture failed: ${JSON.stringify(result.error)}`);
  return copyArtifact(result.value);
}

const dev = spawn(process.execPath, [resolve(root, 'scripts/dev-live.mjs'), appPackage], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
dev.stdout.on('data', (chunk) => process.stdout.write(`[dev-live] ${chunk}`));
dev.stderr.on('data', (chunk) => process.stderr.write(`[dev-live:err] ${chunk}`));
let browser;
let page;
try {
  const url = await waitForUrl();
  browser = await chromium.launch({
    headless: true,
    channel: browserLaunch.channel,
    args: [...browserLaunch.args.filter(arg => !arg.startsWith('--autoplay-policy=')), ...(process.env.CI ? ['--use-angle=swiftshader'] : []), '--autoplay-policy=user-gesture-required'],
    chromiumSandbox: true,
  });
  page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) consoleErrors.push(message.text()); });
  // The live bridge need not become network-idle. Verify content and gameplay
  // readiness explicitly below before mutating or capturing the scene.
  await page.goto(`${url}/?m8-probe=1`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('content=ready'), undefined, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('phase=playing'), undefined, { timeout: 30_000 });
  await page.waitForTimeout(500);
  writeFileSync(sourcePath, `${JSON.stringify(mutatedContent, null, 2)}\n`);
  await page.waitForFunction(
    (title) => document.querySelector('#status')?.textContent?.includes(`contentTitle=${title}`),
    mutatedContent.title,
    { timeout: 30_000 },
  );
  const health = await waitForBridge();
  const baseline = liveEval('globalThis.__forgeaxM8.snapshot()');
  if (baseline.content.ready !== true || baseline.content.title !== mutatedContent.title || baseline.phase !== 'playing' || baseline.entityCount < 6) {
    throw new Error(`M8 baseline invariant failed: ${JSON.stringify(baseline)}`);
  }
  console.log(`[m8-capstone] content reimport/HMR: PASS title=${JSON.stringify(baseline.content.title)} markers=${baseline.content.markers}`);
  const beforePath = resolve(artifactDir, 'before.png');
  await page.screenshot({ path: beforePath });

  await page.keyboard.down('Space');
  await page.waitForTimeout(100);
  await page.keyboard.up('Space');
  await page.waitForFunction(() => /audio=running/.test(document.querySelector('#audio-status')?.textContent ?? '') && /starts=[1-9]/.test(document.querySelector('#audio-status')?.textContent ?? ''), undefined, { timeout: 15_000 });
  const audio = await page.locator('#audio-status').textContent();
  const picked = liveEval('globalThis.__forgeaxM8.pickCenter()');
  if (picked.hit !== true) throw new Error(`M8 center pick missed: ${JSON.stringify(picked)}`);
  const switched = liveEval('globalThis.__forgeaxM8.switchRender()');
  if (switched.renderMode !== 'custom') throw new Error(`M8 render mutation failed: ${JSON.stringify(switched)}`);
  const mutated = liveEval('globalThis.__forgeaxM8.snapshot()');
  if (mutated.pickCount < 1 || mutated.renderMode !== 'custom' || mutated.fixedTicks <= baseline.fixedTicks) {
    throw new Error(`M8 dynamic invariant failed: ${JSON.stringify(mutated)}`);
  }

  const captured = await captureArtifact('before-fault');
  const rhiSummary = runRhiCli(
    ['rhi', 'summary', '--artifact', captured.path, '--digest', captured.digest],
    'M8 RHI summary',
  );
  if (!Array.isArray(rhiSummary.summary?.works) || rhiSummary.summary.works.length < 1 || !Number.isInteger(rhiSummary.summary.commandCount) || rhiSummary.summary.commandCount < 1) {
    throw new Error(`M8 RHI summary lacks draw/command evidence: ${JSON.stringify(rhiSummary)}`);
  }
  writeFileSync(resolve(artifactDir, 'rhi-summary.json'), `${JSON.stringify(rhiSummary, null, 2)}\n`);
  const colorWorkIndex = rhiSummary.summary.works.findIndex((work) => work.kind.startsWith('draw'));
  if (colorWorkIndex < 0) throw new Error('M8 RHI summary has no draw work');
  const rhiInspect = runRhiCli(
    ['rhi', 'inspect', '--artifact', captured.path, '--digest', captured.digest, '--work-index', String(colorWorkIndex)],
    'M8 RHI inspect',
  );
  if (rhiInspect.inspection?.workIndex !== colorWorkIndex || rhiInspect.inspection?.eventIndex === undefined) {
    throw new Error(`M8 RHI inspect lacks work evidence: ${JSON.stringify(rhiInspect)}`);
  }
  writeFileSync(resolve(artifactDir, 'rhi-inspect.json'), `${JSON.stringify(rhiInspect, null, 2)}\n`);
  console.log(`[m8-capstone] RHI capture/inspect: PASS works=${rhiSummary.summary.works.length} commands=${rhiSummary.summary.commandCount} workIndex=${rhiInspect.inspection.workIndex}`);
  const fault = liveEval('globalThis.__forgeaxM8.injectFault()');
  if (fault.ok !== false || typeof fault.code !== 'string') throw new Error(`M8 fault oracle failed: ${JSON.stringify(fault)}`);
  const recovery = liveEval('globalThis.__forgeaxM8.recover()');
  if (recovery.ok !== true || recovery.entityCount !== baseline.entityCount) throw new Error(`M8 recovery call failed: ${JSON.stringify(recovery)}`);
  await page.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('phase=recovered'), undefined, { timeout: 15_000 });
  const rendererHealth = liveEval('globalThis.__forgeaxM8.health()');
  if (rendererHealth !== 'alive') throw new Error(`M8 post-recovery renderer health failed: ${JSON.stringify(rendererHealth)}`);
  const afterPath = resolve(artifactDir, 'after-recovery.png');
  await page.screenshot({ path: afterPath });
  const after = liveEval('globalThis.__forgeaxM8.snapshot()');
  const beforeVisual = readPng(beforePath);
  const afterVisual = readPng(afterPath);
  if (afterVisual.nonBlack < 1000) throw new Error(`M8 recovered frame is empty: ${JSON.stringify(afterVisual)}`);
  if (pageErrors.length > 0) throw new Error(`M8 page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) throw new Error(`M8 console errors: ${consoleErrors.join(' | ')}`);
  console.log(`[m8-capstone] remote-live mutation: PASS pick=${picked.hit} render=${switched.renderMode} fixed=${mutated.fixedTicks}`);
  console.log(`[m8-capstone] structured fault/recovery: PASS code=${fault.code} phase=${after.phase} entities=${after.entityCount}`);
  const summary = { health, reimport: { originalTitle: originalContent.title, mutatedTitle: mutatedContent.title, markers: baseline.content.markers }, baseline, audio, picked, switched, mutated, capture: captured, rhi: { works: rhiSummary.summary.works.length, commands: rhiSummary.summary.commandCount, workIndex: rhiInspect.inspection.workIndex }, fault, recovery, after, beforeVisual, afterVisual, pageErrors, consoleErrors };
  writeFileSync(resolve(artifactDir, 'browser-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[m8-capstone] browser long-lived journey: PASS phase=${after.phase} entities=${after.entityCount} fixed=${after.fixedTicks} pick=${after.pickCount} fault=${fault.code} beforeNonBlack=${beforeVisual.nonBlack} afterNonBlack=${afterVisual.nonBlack}`);
} catch (error) {
  if (page !== undefined) {
    const state = await page
      .evaluate(() => ({
        status: document.querySelector('#status')?.textContent ?? '',
        audio: document.querySelector('#audio-status')?.textContent ?? '',
        snapshot: globalThis.__forgeaxM8?.snapshot?.(),
      }))
      .catch(() => undefined);
    if (state !== undefined) console.error(`[m8-capstone] failure state: ${JSON.stringify(state)}`);
  }
  console.error(`[m8-capstone] browser long-lived journey: FAIL - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  writeFileSync(sourcePath, originalSource);
  if (browser) await browser.close();
  dev.kill('SIGTERM');
  await sleep(300);
}
