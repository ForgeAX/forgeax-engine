#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';

const here = resolve(new URL('.', import.meta.url).pathname);
const root = resolve(here, '..', '..', '..', '..');
const remoteLive = resolve(root, 'skills/forgeax-engine-cli/scripts/remote-live.mjs');
const childEnv = { ...process.env, INIT_CWD: root };

function findFreePort(excluded = new Set()) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        if (typeof address !== 'object' || address === null || typeof address.port !== 'number') {
          reject(new Error('free-port probe did not return a TCP port'));
          return;
        }
        if (excluded.has(address.port)) {
          findFreePort(excluded).then(resolvePort, reject);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function run(label, args, extraEnv = {}) {
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: { ...childEnv, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  console.log(`[m6-forensics] ${label}: PASS`);
  return result.stdout ?? '';
}

function runNode(label, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...childEnv, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status ?? 'unknown'}`);
  if (/^validation:/m.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) {
    throw new Error(`${label} emitted a Dawn validation error; inspect the replay output above`);
  }
  return result.stdout ?? '';
}

function parseJsonOutput(output, label) {
  const trimmed = output.trim();
  const start = trimmed.startsWith('{') ? 0 : trimmed.indexOf('{');
  if (start < 0) throw new Error(`${label} did not emit JSON`);
  try {
    return JSON.parse(trimmed.slice(start));
  } catch (error) {
    throw new Error(`${label} emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function artifactDigest(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function runDevKitOperation(label, operation, artifactPath, extraArgs = []) {
  const cli = resolve(root, 'packages/devkit/dist/cli.mjs');
  const output = runNode(label, [
    cli,
    'debug',
    ...operation.split('.'),
    '--artifact',
    artifactPath,
    '--digest',
    artifactDigest(artifactPath),
    ...extraArgs,
    '--json',
  ]);
  const envelope = parseJsonOutput(output, label);
  if (!envelope.ok) throw new Error(`${label} returned ${JSON.stringify(envelope.error)}`);
  return envelope.value;
}

async function waitForPage(url, dev) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null || dev.signalCode !== null) {
      throw new Error(`dev-live exited before page became ready (code=${dev.exitCode} signal=${dev.signalCode})`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The dev server is still booting.
    }
    await sleep(250);
  }
  throw new Error(`page did not become ready: ${url}`);
}

async function waitForBridge(env) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync(process.execPath, [remoteLive, '--health'], {
      cwd: root,
      env,
      encoding: 'utf8',
    });
    if (result.status === 0) return parseJsonOutput(result.stdout, 'remote-live health');
    await sleep(250);
  }
  throw new Error('remote-live bridge did not connect to the browser');
}

async function captureArtifact(page, label) {
  const captured = await page.evaluate(async (captureLabel) => {
    const captureFn = globalThis.__forgeax?.captureFrame;
    if (typeof captureFn !== 'function') return { ok: false, error: { code: 'capture-unavailable' } };
    const result = await captureFn();
    if (!result.ok) return result;
    const runId = `m6-${captureLabel}-${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
    const response = await fetch(`/__forgeax-debug/tape?runId=${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-forgeax-rhitape' },
      body: result.value.bytes,
    });
    const artifact = await response.json();
    if (!response.ok) return { ok: false, error: artifact };
    return { ok: true, value: { ...artifact, source: 'rhi.capture', digest: result.value.digest, runId } };
  }, label);
  if (!captured.ok) throw new Error(`${label} capture failed: ${JSON.stringify(captured.error)}`);
  if (captured.value?.kind !== 'rhi-tape' || typeof captured.value.path !== 'string') {
    throw new Error(`${label} capture returned an invalid ArtifactRef: ${JSON.stringify(captured)}`);
  }
  const source = [captured.value.path, resolve(root, captured.value.path), resolve(root, 'apps/remote-demo', captured.value.path)]
    .find((candidate) => existsSync(candidate));
  if (source === undefined) throw new Error(`${label} tape artifact is missing: ${captured.value.path}`);
  const artifactDir = resolve(process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ?? resolve(root, '.forgeax-debug', 'm6-forensics'), label);
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = resolve(artifactDir, 'frame.rhitape');
  copyFileSync(source, artifactPath);
  return { ...captured.value, path: artifactPath };
}

/**
 * Capture the first frame as a state-settling observation, then use the next
 * frame as the evidence artifact. A World mutation can legitimately rebuild
 * directional shadows in the first frame; keeping that warmup tape preserves
 * the work evidence while the compared artifacts are both post-settle frames.
 * No wall-clock wait or work-count exception is involved.
 */
async function captureSettledArtifact(page, label) {
  const warmup = await captureArtifact(page, `${label}-warmup`);
  const settled = await captureArtifact(page, label);
  return { ...settled, warmup };
}

function liveEval(env, script) {
  const result = spawnSync(process.execPath, [remoteLive, script], {
    cwd: root,
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

async function runRemoteLiveBrowser() {
  const bridgePort = String(await findFreePort());
  const pagePort = String(await findFreePort(new Set([Number(bridgePort)])));
  const pageUrl = `http://localhost:${pagePort}`;
  const env = {
    ...childEnv,
    FORGEAX_ENGINE_BRIDGE_PORT: bridgePort,
    FORGEAX_REMOTE_DEMO_PORT: pagePort,
  };
  const liveArtifactDir = mkdtempSync(resolve(tmpdir(), 'forgeax-m6-live-'));
  process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR ??= liveArtifactDir;
  const dev = spawn(process.execPath, ['scripts/dev-live.mjs', '@forgeax/remote-demo'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  dev.stdout.on('data', (chunk) => process.stderr.write(`[dev-live] ${chunk}`));
  dev.stderr.on('data', (chunk) => process.stderr.write(`[dev-live.err] ${chunk}`));
  let browser;
  try {
    await waitForPage(pageUrl, dev);
    browser = await chromium.launch({
      headless: true,
      channel: 'chrome',
      args: ['--disable-features=MacAppCodeSignClone', '--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer', '--ignore-gpu-blocklist'],
      chromiumSandbox: true,
    });
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    const health = await waitForBridge(env);
    const entities = liveEval(
      env,
      "(async () => { const q = world.query({}); if (!q.ok) throw q.error; return Array.from(q.value, row => row.entity); })()",
    );
    if (!Array.isArray(entities) || entities.length < 3) throw new Error(`unexpected live entities: ${JSON.stringify(entities)}`);
    const handle = entities[0];
    const before = liveEval(env, "(async () => { world.insertResource('m6Probe', { value: 1 }); return world.getResource('m6Probe').value; })()");
    liveEval(
      env,
      "(async () => { world.insertResource('m6Probe', { value: 7 }); return 'mutated'; })()",
    );
    const after = liveEval(env, "world.getResource('m6Probe').value");
    if (before !== 1 || after !== 7) {
      throw new Error(`live resource mutation did not read back: before=${before} after=${after}`);
    }
    const baselineArtifact = await captureSettledArtifact(page, 'before');
    const baselineCapture = liveEval(
      env,
      `(async () => { const m = await _import('@forgeax/engine-scene'); const t = world.get(${JSON.stringify(handle)}, m.Transform); return { available: rhiCapture !== undefined, probe: world.getResource('m6Probe').value, posX: t.ok ? t.value.pos[0] : null }; })()`,
    );
    baselineCapture.capture = baselineArtifact;
    if (
      baselineCapture?.available !== true ||
      baselineCapture.probe !== 7 ||
      baselineCapture.posX !== 0 ||
      baselineCapture.capture?.kind !== 'rhi-tape'
    ) {
      throw new Error(`baseline live capture did not return one ArtifactRef: ${JSON.stringify(baselineCapture)}`);
    }

    const moved = liveEval(
      env,
      `(async () => { const m = await _import('@forgeax/engine-scene'); world.set(${JSON.stringify(handle)}, m.Transform, { pos: [1.25, 0, 0] }); const t = world.get(${JSON.stringify(handle)}, m.Transform); return t.ok ? t.value.pos[0] : null; })()`,
    );
    if (moved !== 1.25) {
      throw new Error(`visible Transform mutation did not read back: ${JSON.stringify(moved)}`);
    }

    const mutatedArtifact = await captureSettledArtifact(page, 'after');
    const mutatedCapture = liveEval(
      env,
      `(async () => { const m = await _import('@forgeax/engine-scene'); const t = world.get(${JSON.stringify(handle)}, m.Transform); return { available: rhiCapture !== undefined, probe: world.getResource('m6Probe').value, posX: t.ok ? t.value.pos[0] : null }; })()`,
    );
    mutatedCapture.capture = mutatedArtifact;
    if (
      mutatedCapture?.available !== true ||
      mutatedCapture.probe !== 7 ||
      mutatedCapture.posX !== 1.25 ||
      mutatedCapture.capture?.kind !== 'rhi-tape'
    ) {
      throw new Error(`mutated live capture did not return one ArtifactRef: ${JSON.stringify(mutatedCapture)}`);
    }
    const retry = await captureArtifact(page, 'retry-1');
    await sleep(250);
    const retry2 = await captureArtifact(page, 'retry-2');
    if (retry.digest === retry2.digest || retry.digest === mutatedArtifact.digest) {
      throw new Error(`capture retry did not produce fresh digests: ${JSON.stringify({ retry, retry2, mutated: mutatedArtifact })}`);
    }
    console.log(`[m6-forensics] capture retry recovery: PASS (same-process digests=${retry.digest},${retry2.digest})`);

    const baseline = baselineArtifact;
    const mutated = mutatedArtifact;
    console.log(
      `[m6-forensics] same-scene live capture: PASS (before=${baseline.runId}, after=${mutated.runId}, probe=7)`,
    );
    console.log(
      `[m6-forensics] semantic live mutation: PASS (Transform.pos.x ${baselineCapture.posX} -> ${mutatedCapture.posX})`,
    );
    return {
      beforeArtifactPath: baseline.path,
      afterArtifactPath: mutated.path,
      beforeRunId: baseline.runId,
      afterRunId: mutated.runId,
      probe: mutatedCapture.probe,
      beforePosX: baselineCapture.posX,
      afterPosX: mutatedCapture.posX,
      m21: {
        captureCapability: baselineCapture.available,
        retry,
        retry2,
        sameProcess: true,
      },
    };
  } finally {
    if (browser) await browser.close();
    if (dev.exitCode === null && dev.signalCode === null) {
      dev.kill('SIGTERM');
      await Promise.race([
        new Promise((resolveExit) => dev.once('exit', resolveExit)),
        sleep(3000),
      ]);
    }
    if (dev.exitCode === null && dev.signalCode === null) dev.kill('SIGKILL');
  }
}

async function main() {
  try {
    const liveCapture = await runRemoteLiveBrowser();
    const m21ArtifactDir = process.env.FORGEAX_GAUNTLET_ARTIFACT_DIR;
    if (m21ArtifactDir !== undefined) {
      mkdirSync(m21ArtifactDir, { recursive: true });
      writeFileSync(
        resolve(m21ArtifactDir, 'm21-rhi-debug-recovery.json'),
        `${JSON.stringify(liveCapture.m21, null, 2)}\n`,
      );
    }
    run('remote contracts', ['--filter', '@forgeax/remote-demo', 'e2e:motion']);
    run('remote contract syntax/error', ['--filter', '@forgeax/remote-demo', 'e2e:cli']);

    const fixtureDir = mkdtempSync(resolve(tmpdir(), 'forgeax-m6-rhi-'));
    try {
      runNode('RHI fixture', ['apps/rhi-debug-viewer/fixtures/generate-fixture.mjs', fixtureDir]);
      const fixturePath = resolve(fixtureDir, 'frame-0.rhitape');
      const summary = runDevKitOperation('RHI frame model', 'rhi.summary', fixturePath);
      if (!Array.isArray(summary.summary?.works) || summary.summary.works.length < 1 || !Number.isInteger(summary.summary.commandCount) || summary.summary.commandCount < 1) {
        throw new Error(`frame model lacks work/command evidence: ${JSON.stringify(summary)}`);
      }
      console.log(`[m6-forensics] RHI frame model: PASS (works=${summary.summary.works.length}, commands=${summary.summary.commandCount})`);
      const fixtureWorkIndex = summary.summary.works.findIndex((work) => work.kind.startsWith('draw'));
      const inspected = runDevKitOperation('RHI inspect/replay', 'rhi.inspect', fixturePath, ['--work-index', String(Math.max(0, fixtureWorkIndex))]);
      if (inspected.inspection?.workIndex !== fixtureWorkIndex || inspected.inspection?.eventIndex === undefined) {
        throw new Error(`inspect lacks replay evidence: ${JSON.stringify(inspected)}`);
      }
      console.log(`[m6-forensics] RHI inspect/replay: PASS (workIndex=${inspected.inspection.workIndex})`);

      const beforeSummary = runDevKitOperation('same-scene baseline RHI frame model', 'rhi.summary', liveCapture.beforeArtifactPath);
      const liveSummary = runDevKitOperation('same-scene mutated RHI frame model', 'rhi.summary', liveCapture.afterArtifactPath);
      if (
        !Array.isArray(beforeSummary.summary?.works) ||
        beforeSummary.summary.works.length < 1 ||
        !Array.isArray(liveSummary.summary?.works) ||
        liveSummary.summary.works.length < 1 ||
        !Number.isInteger(liveSummary.summary.commandCount) ||
        liveSummary.summary.commandCount < 1 ||
        beforeSummary.summary.works.length !== liveSummary.summary.works.length
      ) {
        throw new Error('same-scene before/after tapes lack stable work evidence');
      }
      console.log(
        `[m6-forensics] same-scene live RHI frame model: PASS (before=${liveCapture.beforeRunId}, after=${liveCapture.afterRunId}, works=${liveSummary.summary.works.length}, commands=${liveSummary.summary.commandCount})`,
      );
      const liveWorkIndex = liveSummary.summary.works.findIndex((work) => work.kind.startsWith('draw'));
      const beforeInspected = runDevKitOperation('same-scene baseline RHI inspect/replay', 'rhi.inspect', liveCapture.beforeArtifactPath, ['--work-index', String(Math.max(0, liveWorkIndex))]);
      const liveInspected = runDevKitOperation('same-scene live RHI inspect/replay', 'rhi.inspect', liveCapture.afterArtifactPath, ['--work-index', String(Math.max(0, liveWorkIndex))]);
      if (
        beforeInspected.inspection?.workIndex !== liveWorkIndex ||
        liveInspected.inspection?.workIndex !== liveWorkIndex ||
        liveInspected.inspection?.eventIndex === undefined
      ) {
        throw new Error(`same-scene live tape lacks replay evidence: ${JSON.stringify(liveInspected)}`);
      }
      console.log(`[m6-forensics] same-scene live RHI inspect/replay: PASS (workIndex=${liveInspected.inspection.workIndex})`);
      console.log(`[m6-forensics] semantic-to-structural correlation: PASS (Transform.pos.x ${liveCapture.beforePosX} -> ${liveCapture.afterPosX})`);

      const m21Summary = runDevKitOperation('capture retry RHI frame model', 'rhi.summary', liveCapture.m21.retry.path);
      const retryWorkIndex = m21Summary.summary.works.findIndex((work) => work.kind.startsWith('draw'));
      const m21Inspect = runDevKitOperation('capture retry inspect', 'rhi.inspect', liveCapture.m21.retry.path, ['--work-index', String(Math.max(0, retryWorkIndex))]);
      if (m21Inspect.inspection?.workIndex !== retryWorkIndex || m21Inspect.inspection?.eventIndex === undefined) {
        throw new Error(`capture retry inspect lacks evidence: ${JSON.stringify(m21Inspect)}`);
      }
      writeFileSync(resolve(liveCapture.m21.retry.path, '..', 'retry-summary.json'), `${JSON.stringify(m21Summary, null, 2)}\n`);
      writeFileSync(resolve(liveCapture.m21.retry.path, '..', 'retry-inspect.json'), `${JSON.stringify(m21Inspect, null, 2)}\n`);
      console.log(`[m6-forensics] capture retry inspect: PASS (workIndex=${m21Inspect.inspection.workIndex}, works=${m21Summary.summary.works.length}, commands=${m21Summary.summary.commandCount})`);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }

    run('RHI viewer', ['--filter', '@forgeax/engine-rhi-debug-viewer', 'smoke:browser']);
    const falsifier = run('RHI falsifier', ['--filter', '@forgeax/engine-rhi-debug-viewer', 'smoke:browser'], { FORGEAX_FALSIFY_TEXTURE_ATTACHMENT: '1' });
    if (!falsifier.includes('FALSIFIER_CONFIRMED')) {
      throw new Error('RHI attachment falsifier did not confirm missing resources and pixels');
    }
    console.log('[m6-forensics] PASS - M6 inspection/forensics gates GREEN');
    console.log('[m6-forensics] deferred: renderer device-loss recovery remains open.');
  } catch (error) {
    console.error(`[m6-forensics] FAIL - ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main();
