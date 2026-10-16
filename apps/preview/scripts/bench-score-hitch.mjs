#!/usr/bin/env node
// Measure the real game-default projectile -> scored-target path.
//
// The benchmark deliberately uses canvas input. Inspection is used only to
// verify the resulting gameplay state and to read the existing render/audio
// evidence handles; it never triggers the score or hit owners itself.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const ARTIFACT_DIR = resolve(
  process.env.FORGEAX_SCORE_HITCH_DIR ?? resolve(ROOT, '.forgeax-debug/score-hitch'),
);
const PORT = Number.parseInt(process.env.FORGEAX_SCORE_HITCH_PORT ?? '5207', 10);
const FRESH_TRIALS = Number.parseInt(process.env.FORGEAX_SCORE_HITCH_FRESH_TRIALS ?? '30', 10);
const WARM_TRIALS = Number.parseInt(process.env.FORGEAX_SCORE_HITCH_WARM_TRIALS ?? '30', 10);
const SETTLE_MS = 500;
const HIT_TIMEOUT_MS = 2_000;
const POST_EVENT_MS = 120;
const CONTROL_WINDOW_MS = 700;
const MAX_TRIAL_ATTEMPTS = 3;
const VIEWPORT = { width: 800, height: 600 };
const HIT_POINT = { x: 493, y: 244 };
const CONTROL_POINT = { x: 400, y: 100 };
const URL = `http://127.0.0.1:${PORT}/?game=game-default&render-evidence=1&audio-evidence=1`;

mkdirSync(ARTIFACT_DIR, { recursive: true });

const server = spawn('pnpm', ['--filter', '@forgeax/preview', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '';
server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer', '--ignore-gpu-blocklist'],
  chromiumSandbox: true,
});
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function summarize(values) {
  return {
    count: values.length,
    min: values.length === 0 ? null : Math.min(...values),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

async function boot() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await page.goto(URL, { waitUntil: 'networkidle', timeout: 2_500 });
      break;
    } catch (error) {
      if (Date.now() >= deadline) throw new Error(`Preview did not boot: ${serverOutput}\n${String(error)}`);
      await sleep(250);
    }
  }
  await page.waitForFunction(() => {
    const inspection = globalThis.__forgeaxPreviewInspection;
    const render = globalThis.__forgeaxGameDefaultRenderEvidence;
    return typeof inspection?.read === 'function' && typeof render?.snapshot === 'function';
  }, { timeout: 15_000 });
  await page.waitForTimeout(SETTLE_MS);
}

async function resetAndSettle() {
  const result = await page.evaluate(() => globalThis.__forgeaxPreviewInspection.run('game-default.reset'));
  if (!result.ok) throw new Error(`game-default reset failed: ${JSON.stringify(result)}`);
  await page.waitForTimeout(SETTLE_MS);
}

async function readEvidence() {
  return page.evaluate(async () => {
    const inspection = globalThis.__forgeaxPreviewInspection === undefined
      ? null
      : await globalThis.__forgeaxPreviewInspection.read('game-default.snapshot');
    const renderEvidence = globalThis.__forgeaxGameDefaultRenderEvidence;
    const audioEvidence = globalThis.__forgeaxGameDefaultAudioEvidence;
    const renderInspection = renderEvidence?.renderer.inspect();
    return {
      inspection,
      render: renderEvidence?.snapshot() ?? null,
      renderer: renderEvidence === undefined ? null : {
        backend: renderInspection?.capabilities.backendKind ?? null,
        state: renderInspection?.state ?? null,
        surface: renderInspection?.surface ?? null,
      },
      audio: audioEvidence?.snapshot() ?? null,
    };
  });
}

async function startRecorder() {
  return page.evaluate(() => {
    const hosts = [...document.querySelectorAll('*')];
    const score = hosts
      .map((host) => host.shadowRoot?.querySelector('[data-ui-slot="score"]'))
      .find((node) => node !== undefined);
    if (!(score instanceof HTMLElement)) throw new Error('score HUD slot is unavailable');
    const start = performance.now();
    let lastFrame = null;
    let lastScore = score.textContent ?? '';
    let frameHandle = 0;
    const frames = [];
    const scoreMarkers = [];
    const longTasks = [];
    const onScoreMutation = () => {
      const nextScore = score.textContent ?? '';
      if (nextScore === lastScore) return;
      const previousScore = lastScore;
      lastScore = nextScore;
      if (previousScore !== '') scoreMarkers.push({ t: performance.now() - start, text: nextScore });
    };
    const scoreObserver = new MutationObserver(onScoreMutation);
    scoreObserver.observe(score, { childList: true, characterData: true, subtree: true });
    let longTaskObserver = null;
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ t: entry.startTime - start, duration: entry.duration, name: entry.name });
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: false });
    } catch {
      longTaskObserver = null;
    }
    const frame = (timestamp) => {
      if (lastFrame !== null) frames.push({ t: timestamp - start, delta: timestamp - lastFrame });
      lastFrame = timestamp;
      frameHandle = requestAnimationFrame(frame);
    };
    frameHandle = requestAnimationFrame(frame);
    globalThis.__forgeaxScoreHitchRecorder = {
      stop: () => {
        cancelAnimationFrame(frameHandle);
        scoreObserver.disconnect();
        longTaskObserver?.disconnect();
        delete globalThis.__forgeaxScoreHitchRecorder;
        return { frames, scoreMarkers, longTasks };
      },
      peek: () => ({ scoreMarkers: [...scoreMarkers] }),
    };
    return { scoreNode: score.textContent, start };
  });
}

async function stopRecorder() {
  return page.evaluate(() => globalThis.__forgeaxScoreHitchRecorder?.stop() ?? { frames: [], scoreMarkers: [], longTasks: [] });
}

async function waitForScoreMarker() {
  const deadline = Date.now() + HIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const peek = await page.evaluate(() => globalThis.__forgeaxScoreHitchRecorder?.peek() ?? { scoreMarkers: [] });
    if (peek.scoreMarkers.length > 0) return peek.scoreMarkers[0];
    await sleep(10);
  }
  return null;
}

async function startTrace() {
  const client = await page.context().newCDPSession(page);
  let complete;
  const done = new Promise((resolveDone) => { complete = resolveDone; });
  client.once('Tracing.tracingComplete', (event) => complete(event));
  await client.send('Tracing.start', {
    categories: '-*,devtools.timeline,blink.user_timing,v8.execute,gpu,disabled-by-default-devtools.timeline.frame',
    transferMode: 'ReturnAsStream',
  });
  return async (path) => {
    await client.send('Tracing.end');
    const event = await done;
    const chunks = [];
    let eof = false;
    while (!eof) {
      const chunk = await client.send('IO.read', { handle: event.stream });
      chunks.push(chunk.data ?? '');
      eof = chunk.eof === true;
    }
    await client.send('IO.close', { handle: event.stream });
    writeFileSync(path, chunks.join(''));
    await client.detach();
  };
}

function frameWindow(recording, marker) {
  const frames = recording.frames;
  if (frames.length === 0 || marker === null) return { eventFrame: null, window: [] };
  let eventFrame = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < frames.length; index += 1) {
    const candidate = Math.abs((frames[index]?.t ?? 0) - marker.t);
    if (candidate < distance) {
      distance = candidate;
      eventFrame = index;
    }
  }
  return {
    eventFrame,
    window: frames.slice(Math.max(0, eventFrame - 1), eventFrame + 4),
  };
}

async function hitTrial(kind, index, trace) {
  await startRecorder();
  const stopTrace = trace === true ? await startTrace() : null;
  let recorderStopped = false;
  let marker;
  try {
    await page.mouse.click(HIT_POINT.x, HIT_POINT.y);
    marker = await waitForScoreMarker();
    if (marker === null) throw new Error(`real hit did not change the score (${kind} trial ${index})`);
    const evidenceAtEvent = await readEvidence();
    if (kind === 'fresh' && index === 1) {
      await page.screenshot({ path: resolve(ARTIFACT_DIR, 'fresh-hit.png') });
    }
    await page.waitForTimeout(POST_EVENT_MS);
    const finalEvidence = await readEvidence();
    const render = evidenceAtEvent.render;
    const vfx = evidenceAtEvent.inspection?.value?.vfxHit;
    if (
      evidenceAtEvent.inspection?.ok !== true
      || evidenceAtEvent.inspection.value.targetHealth.damageEvents <= 0
      || render?.changeDetection?.score <= 0
      || vfx?.seed <= 0
      || render?.worldScoreText?.active !== true
    ) {
      throw new Error(`score-hitch admission failed: ${JSON.stringify({ kind, index, evidence: evidenceAtEvent, marker })}`);
    }
    const recording = await stopRecorder();
    recorderStopped = true;
    const eventScore = Number.parseInt(marker.text.replace(/[^0-9-]/g, ''), 10);
    const result = {
      kind,
      index,
      click: HIT_POINT,
      marker,
      eventScore,
      evidence: evidenceAtEvent,
      finalEvidence,
      recording,
      window: frameWindow(recording, marker),
    };
    writeFileSync(resolve(ARTIFACT_DIR, `${kind}-${String(index).padStart(3, '0')}.json`), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (!recorderStopped) {
      await stopRecorder().catch(() => undefined);
    }
    if (stopTrace !== null) await stopTrace(resolve(ARTIFACT_DIR, `${kind}-${String(index).padStart(3, '0')}.trace.json`));
  }
}

async function hitTrialWithRetry(kind, index, trace) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_TRIAL_ATTEMPTS; attempt += 1) {
    try {
      const result = await hitTrial(kind, index, trace === true && attempt === 1);
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_TRIAL_ATTEMPTS) await resetAndSettle();
    }
  }
  throw new Error(`${kind} trial ${index} failed after ${MAX_TRIAL_ATTEMPTS} attempts: ${String(lastError)}`);
}

async function controlTrial(index) {
  await resetAndSettle();
  await startRecorder();
  await page.mouse.click(CONTROL_POINT.x, CONTROL_POINT.y);
  await page.waitForTimeout(CONTROL_WINDOW_MS);
  const recording = await stopRecorder();
  if (recording.scoreMarkers.length > 0) {
    throw new Error(`matched control scored unexpectedly: ${JSON.stringify({ index, recording })}`);
  }
  const result = { kind: 'control', index, click: CONTROL_POINT, recording };
  writeFileSync(resolve(ARTIFACT_DIR, `control-${String(index).padStart(3, '0')}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function metrics(hits, controls) {
  const controlFrames = controls.flatMap((control) => control.recording.frames.slice(3).map((frame) => frame.delta));
  const controlP95 = percentile(controlFrames, 0.95);
  const hitMetrics = hits.map((hit) => {
    const window = hit.window.window.map((frame) => frame.delta);
    const peak = window.length === 0 ? null : Math.max(...window);
    return {
      kind: hit.kind,
      index: hit.index,
      eventScore: hit.eventScore,
      eventDelayMs: hit.marker.t,
      peakFrameDeltaMs: peak,
      hitchExcessMs: peak === null || controlP95 === null ? null : peak - controlP95,
      eventFrame: hit.window.eventFrame,
      longTasks: hit.recording.longTasks,
      window,
    };
  });
  const peakValues = hitMetrics.flatMap((metric) => metric.peakFrameDeltaMs === null ? [] : [metric.peakFrameDeltaMs]);
  const excessValues = hitMetrics.flatMap((metric) => metric.hitchExcessMs === null ? [] : [metric.hitchExcessMs]);
  const eventDelays = hitMetrics.map((metric) => metric.eventDelayMs);
  return {
    control: { frameDeltaMs: summarize(controlFrames), steadyP95Ms: controlP95 },
    hit: {
      trials: hitMetrics.length,
      eventDelayMs: summarize(eventDelays),
      peakFrameDeltaMs: summarize(peakValues),
      hitchExcessMs: summarize(excessValues),
      longTaskCount: hitMetrics.reduce((count, metric) => count + metric.longTasks.length, 0),
    },
    hitMetrics,
  };
}

const engineSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const startedAt = new Date().toISOString();
const fresh = [];
const warm = [];
const controls = [];
let report;

try {
  await boot();
  for (let index = 1; index <= FRESH_TRIALS; index += 1) {
    if (index > 1) await boot();
    const hit = await hitTrialWithRetry('fresh', index, index === 1);
    fresh.push(hit);
    const control = await controlTrial(index);
    controls.push(control);
    if (index === 1) {
      await resetAndSettle();
      await page.mouse.click(CONTROL_POINT.x, CONTROL_POINT.y);
      await page.waitForTimeout(CONTROL_WINDOW_MS);
      await page.screenshot({ path: resolve(ARTIFACT_DIR, 'matched-control.png') });
    }
  }
  await boot();
  for (let index = 1; index <= WARM_TRIALS; index += 1) {
    if (index > 1) await resetAndSettle();
    const hit = await hitTrialWithRetry('warm', index, index === 1);
    warm.push(hit);
    const control = await controlTrial(index);
    controls.push(control);
  }
  const hits = [...fresh, ...warm];
  report = {
    schema: 'forgeax.score-hitch.v1',
    startedAt,
    finishedAt: new Date().toISOString(),
    engineSha,
    environment: {
      browser: 'chrome',
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      url: URL,
      backend: fresh[0]?.evidence.renderer?.backend ?? null,
      rendererState: fresh[0]?.evidence.renderer?.state ?? null,
      hitPoint: HIT_POINT,
      matchedControlPoint: CONTROL_POINT,
      scene: 'apps/game-capability-lab/assets/scene.pack.json RedBox at (3, 0.5, -2)',
    },
    workloadFingerprint: {
      targetHealth: fresh[0]?.evidence.render?.targetHealth ?? null,
      targetDisabling: fresh[0]?.evidence.render?.targetDisabling ?? null,
      vfxHit: fresh[0]?.evidence.inspection?.value?.vfxHit ?? null,
      worldScoreText: fresh[0]?.evidence.render?.worldScoreText ?? null,
      audio: fresh[0]?.evidence.audio ?? null,
      initialState: fresh[0]?.evidence.inspection?.value?.state ?? null,
      projectileSpawned: fresh[0]?.evidence.render?.deferredCommands?.spawned ?? null,
    },
    admission: {
      realCanvasInput: true,
      scoreMutationRequired: true,
      matchedControlRequired: true,
      freshTrials: fresh.length,
      warmTrials: warm.length,
      controlTrials: controls.length,
      pageErrors,
      consoleErrors,
    },
    metrics: metrics(hits, controls),
    artifacts: {
      freshHit: 'fresh-001.json',
      warmHit: 'warm-001.json',
      matchedControl: 'control-001.json',
      freshTrace: 'fresh-001.trace.json',
      warmTrace: 'warm-001.trace.json',
      screenshots: ['fresh-hit.png', 'matched-control.png'],
    },
  };
  writeFileSync(resolve(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: resolve(ARTIFACT_DIR, 'report.json'), metrics: report.metrics, admission: report.admission }, null, 2));
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
