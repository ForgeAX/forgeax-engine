#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';

const APP_DIR = resolve(new URL('..', import.meta.url).pathname);
const ROOT = resolve(APP_DIR, '..', '..');
const REMOTE_LIVE = resolve(ROOT, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
const PROFILER_CLI = resolve(ROOT, 'packages/profiler/dist/cli.mjs');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ?? mkdtempSync(resolve(tmpdir(), 'forgeax-m13-profiler-')),
);
const CHILD_ENV = { ...process.env, INIT_CWD: ROOT };

mkdirSync(ARTIFACT_DIR, { recursive: true });

function writeJson(name, value) {
  const path = resolve(ARTIFACT_DIR, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function parseJsonOutput(output, label) {
  const trimmed = output.trim();
  const start = trimmed.startsWith('{') ? 0 : trimmed.indexOf('{');
  if (start < 0) throw new Error(`${label} did not emit JSON: ${trimmed}`);
  try {
    return JSON.parse(trimmed.slice(start));
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForPage(url) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The Vite server is still booting.
    }
    await sleep(250);
  }
  throw new Error(`page did not become ready: ${url}`);
}

async function waitForBridge(env) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [REMOTE_LIVE, '--health'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      const health = parseJsonOutput(result.stdout, 'remote-live health');
      if (health.pageConnected === true) return health;
    }
    await sleep(250);
  }
  throw new Error('remote-live bridge did not connect to the Browser page');
}

function liveEval(env, script) {
  const result = spawnSync(process.execPath, [REMOTE_LIVE, script], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`remote-live eval failed: ${result.stderr || result.stdout}`);
  }
  const envelope = parseJsonOutput(result.stdout, 'remote-live eval');
  if (!envelope.ok) throw new Error(`remote-live eval returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

async function waitForCapture(env, captureId, status) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const capture = liveEval(env, 'return profiler.latestCapture();');
      if (capture?.captureId === captureId && capture.completeness?.status === status) return capture;
    } catch {
      // The frame boundary may be publishing the artifact between polls.
    }
    await sleep(100);
  }
  throw new Error(`capture ${captureId} did not reach ${status}`);
}

function runProfilerSummary(capturePath, label) {
  const result = spawnSync(process.execPath, [PROFILER_CLI, 'summary', '--file', capturePath], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${label} profiler CLI failed: ${result.stderr || result.stdout}`);
  }
  return parseJsonOutput(result.stdout, `${label} profiler CLI`);
}

async function requestIntrospect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/inspector`);
  await once(ws, 'open');
  try {
    const response = await new Promise((resolveResponse, reject) => {
      const onMessage = (raw) => {
        ws.off('message', onMessage);
        try {
          const message = JSON.parse(raw.toString());
          if (message.error) reject(message.error);
          else resolveResponse(message.result);
        } catch (error) {
          reject(error);
        }
      };
      ws.on('message', onMessage);
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'introspect', id: 1 }));
    });
    return response;
  } finally {
    ws.close();
  }
}

async function verifyProfilerNotEnabled() {
  const { startServer } = await import(resolve(ROOT, 'packages/remote/dist/server.mjs'));
  const { defaultConnect } = await import(resolve(ROOT, 'packages/types/dist/inspector-client.mjs'));
  const server = await startServer({ port: 0, host: '127.0.0.1', world: {} });
  assertCondition(server.ok, `disabled profiler server failed: ${JSON.stringify(server.error)}`);
  const connected = await defaultConnect(`ws://127.0.0.1:${server.value.port}/inspector`);
  assertCondition(connected.ok, `disabled profiler client failed: ${JSON.stringify(connected.error)}`);
  try {
    const doc = await requestIntrospect(server.value.port);
    const methods = doc.methods?.map((method) => method.name);
    assertCondition(doc.roots?.profiler === undefined, 'disabled host exposed a profiler root');
    assertCondition(
      doc.capabilities?.profiler?.code === 'profiler-not-enabled',
      `disabled host omitted profiler-not-enabled: ${JSON.stringify(doc.capabilities?.profiler)}`,
    );
    assertCondition(
      JSON.stringify(methods) === JSON.stringify(['eval', 'introspect']),
      `disabled method roster changed: ${JSON.stringify(methods)}`,
    );
    const missing = await connected.value.eval(
      "typeof profiler === 'undefined' ? { ok: false, error: { code: 'profiler-not-enabled', expected: 'an opted-in profiler root', hint: 'Pass profiler to createApp.', detail: { enabled: false } } } : { ok: true }",
    );
    assertCondition(
      missing?.error?.code === 'profiler-not-enabled',
      `missing profiler eval was not structured: ${JSON.stringify(missing)}`,
    );
    writeJson('profiler-not-enabled.json', { doc, methods, eval: missing });
    console.log('[m13-profiler] profiler-not-enabled: PASS');
    console.log('[m13-profiler] RPC method roster: PASS');
    return { methods, capability: doc.capabilities.profiler };
  } finally {
    await connected.value.dispose();
    await server.value.close();
  }
}

async function runBrowserJourney() {
  const bridgePort = '5743';
  const env = { ...CHILD_ENV, FORGEAX_ENGINE_BRIDGE_PORT: bridgePort };
  const dev = spawn(process.execPath, ['scripts/dev-live.mjs', '@forgeax/remote-demo'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dev.stdout.on('data', (chunk) => process.stderr.write(`[dev-live] ${chunk}`));
  dev.stderr.on('data', (chunk) => process.stderr.write(`[dev-live.err] ${chunk}`));
  let browser;
  const consoleMessages = [];
  const pageErrors = [];
  try {
    await waitForPage('http://localhost:5173');
    browser = await chromium.launch({
      headless: process.env.FORGEAX_M13_HEADED !== '1',
      channel: 'chrome',
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 30_000 });
    const health = await waitForBridge(env);
    assertCondition(health.pageConnected === true, `Browser bridge health was not connected: ${JSON.stringify(health)}`);

    const introspection = liveEval(env, '--introspect');
    const methods = introspection.methods?.map((method) => method.name);
    assertCondition(
      introspection.roots?.profiler?.capability === 'cpu-profile-v1',
      `Browser profiler root was not discoverable: ${JSON.stringify(introspection.roots?.profiler)}`,
    );
    assertCondition(
      JSON.stringify(methods) === JSON.stringify(['eval', 'introspect']),
      `Browser method roster changed: ${JSON.stringify(methods)}`,
    );
    writeJson('browser-introspect.json', introspection);
    console.log('[m13-profiler] optional root discovery: PASS');

    const firstStart = liveEval(
      env,
      "const result = profiler.startCapture({ frameLimit: 1, eventLimit: 1 }); if (!result.ok) throw result.error; return result.value;",
    );
    assertCondition(typeof firstStart?.captureId === 'string', `overflow capture did not start: ${JSON.stringify(firstStart)}`);
    const overflow = await waitForCapture(env, firstStart.captureId, 'overflow');
    assertCondition(
      overflow.completeness.droppedEventCount > 0,
      `overflow artifact dropped no events: ${JSON.stringify(overflow.completeness)}`,
    );
    const overflowPath = writeJson('browser-overflow.capture.json', overflow);
    console.log('[m13-profiler] undersized overflow artifact: PASS');

    const overflowSummary = runProfilerSummary(overflowPath, 'overflow');
    assertCondition(
      overflowSummary.captureId === overflow.captureId && overflowSummary.completeness?.status === 'overflow',
      `overflow CLI summary did not preserve status: ${JSON.stringify(overflowSummary)}`,
    );
    writeJson('browser-overflow.summary.json', overflowSummary);
    console.log('[m13-profiler] overflow offline summary: PASS');

    const secondStart = liveEval(
      env,
      "const result = profiler.startCapture({ frameLimit: 1, eventLimit: 64 }); if (!result.ok) throw result.error; return result.value;",
    );
    assertCondition(typeof secondStart?.captureId === 'string', `complete recapture did not start: ${JSON.stringify(secondStart)}`);
    assertCondition(secondStart.captureId !== overflow.captureId, 'second capture reused overflow identity');
    const complete = await waitForCapture(env, secondStart.captureId, 'complete');
    assertCondition(
      complete.completeness.droppedEventCount === 0,
      `complete recapture retained dropped events: ${JSON.stringify(complete.completeness)}`,
    );
    const completePath = writeJson('browser-complete.capture.json', complete);
    console.log('[m13-profiler] same-process correctly-sized recapture: PASS');

    const completeSummary = runProfilerSummary(completePath, 'complete');
    assertCondition(
      completeSummary.captureId === complete.captureId && completeSummary.completeness?.status === 'complete',
      `complete CLI summary did not preserve status: ${JSON.stringify(completeSummary)}`,
    );
    writeJson('browser-complete.summary.json', completeSummary);
    console.log('[m13-profiler] complete offline summary: PASS');

    const latest = liveEval(env, '--profile-latest');
    assertCondition(
      latest.captureId === complete.captureId && latest.completeness?.status === 'complete',
      `latest capture inherited stale overflow: ${JSON.stringify(latest)}`,
    );
    assertCondition(
      overflow.completeness.status === 'overflow' && overflow.captureId !== latest.captureId,
      'saved overflow artifact was mutated or identity was reused',
    );
    writeJson('browser-recapture-falsifier.json', {
      firstCaptureId: overflow.captureId,
      firstStatus: overflow.completeness.status,
      secondCaptureId: complete.captureId,
      secondStatus: complete.completeness.status,
      latestCaptureId: latest.captureId,
      latestStatus: latest.completeness.status,
    });
    console.log('[m13-profiler] stale overflow falsifier: PASS');

    await page.screenshot({ path: resolve(ARTIFACT_DIR, 'browser-profiler-journey.png'), fullPage: true });
    writeJson('browser-console.json', { messages: consoleMessages, pageErrors });
    assertCondition(pageErrors.length === 0, `Browser page errors: ${JSON.stringify(pageErrors)}`);
    console.log('[m13-profiler] real Browser evidence: PASS');
  } finally {
    if (browser) await browser.close();
    if (dev.exitCode === null) {
      dev.kill('SIGTERM');
      await Promise.race([once(dev, 'exit'), sleep(2_000)]);
      if (dev.exitCode === null) dev.kill('SIGKILL');
    }
  }
}

async function main() {
  const disabled = await verifyProfilerNotEnabled();
  await runBrowserJourney();
  writeJson('journey-result.json', {
    scenario: 'm13-remote-profiler-bounded-recapture',
    disabled,
    browser: {
      captureSequence: ['overflow', 'complete'],
      hostRestartBetweenCaptures: false,
      rpcMethods: ['eval', 'introspect'],
      artifacts: [
        'browser-introspect.json',
        'browser-overflow.capture.json',
        'browser-overflow.summary.json',
        'browser-complete.capture.json',
        'browser-complete.summary.json',
        'browser-recapture-falsifier.json',
        'browser-profiler-journey.png',
      ],
    },
  });
  console.log('[m13-profiler] cleanup: PASS');
  console.log('[m13-profiler] PASS - M13 remote profiler bounded recapture GREEN');
}

main().catch((error) => {
  writeJson('journey-failure.json', { error: error?.stack ?? String(error) });
  process.stderr.write(`m13-profiler-gauntlet: ${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
