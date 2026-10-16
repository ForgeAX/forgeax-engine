#!/usr/bin/env node
// Same-browser WebGPU comparison for the ForgeaX and Three.js object paths.
// This is intentionally an ad-hoc experiment, not a CI admission gate.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const repoRoot = resolve(appRoot, '..', '..', '..');

const config = {
  cubes: integerEnv('PERF_CUBES', 10_000),
  pointLights: integerEnv('PERF_POINT_LIGHTS', 16),
  spotLights: integerEnv('PERF_SPOT_LIGHTS', 16),
  warmupFrames: integerEnv('PERF_WARMUP_FRAMES', 60),
  measureFrames: integerEnv('PERF_MEASURE_FRAMES', 180),
  runs: integerEnv('PERF_RUNS', 3),
  port: integerEnv('PERF_PREVIEW_PORT', 5207),
  timeoutMs: integerEnv('PERF_TIMEOUT_MS', 180_000),
  cpuProfile: process.env.PERF_CPU_PROFILE === '1',
};
const outputPath = resolve(
  process.env.PERF_COMPARE_OUTPUT ?? resolve(appRoot, 'artifacts', 'three-forgeax-comparison.json'),
);

if (config.cubes < 1 || config.cubes > 100_000) {
  fail('PERF_CUBES must be an integer in [1, 100000]');
}
if (config.pointLights < 0 || config.spotLights < 0 || config.pointLights + config.spotLights > 256) {
  fail('PERF_POINT_LIGHTS + PERF_SPOT_LIGHTS must be an integer in [0, 256]');
}
if (config.warmupFrames < 1 || config.measureFrames < 30 || config.runs < 1) {
  fail('warmup, measured frames, and runs must be positive (measure >= 30)');
}

function integerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isSafeInteger(value) ? value : fallback;
}

function fail(message) {
  throw new Error(`[three-forgeax-comparison] ${message}`);
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const left = sorted[lower];
  const right = sorted[upper];
  if (left === undefined || right === undefined) return null;
  return lower === upper ? left : left + (right - left) * (index - lower);
}

function lowerTail(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? null;
}

function stats(values) {
  if (values.length === 0) return { count: 0, min: null, median: null, p95: null, max: null, mean: null };
  return {
    count: values.length,
    min: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
  };
}

function queryString() {
  const query = new URLSearchParams({
    cubes: String(config.cubes),
    pointLights: String(config.pointLights),
    spotLights: String(config.spotLights),
    profile: process.env.PERF_PROFILE ?? '0',
  });
  return query.toString();
}

function spawnBuild() {
  if (process.env.PERF_SKIP_BUILD === '1') return;
  const result = spawnSync(
    'pnpm',
    ['--filter', '@forgeax/perf-10k-cubes-lights', 'build'],
    { cwd: repoRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) fail(`build failed with exit code ${result.status ?? 'unknown'}`);
}

function probeHttp(url) {
  return new Promise((resolve) => {
    const request = httpRequest(url, { method: 'GET' }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });
    request.setTimeout(1_000, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function startPreview() {
  const server = spawn(
    resolve(appRoot, 'node_modules', '.bin', 'vite'),
    ['preview', '--host', '127.0.0.1', '--port', String(config.port)],
    { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  server.stdout.on('data', (chunk) => process.stdout.write(`[preview] ${chunk.toString()}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[preview-err] ${chunk.toString()}`));
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await probeHttp(`${baseUrl}/three.html`)) return { server, baseUrl };
    await delay(100);
  }
  server.kill('SIGTERM');
  fail('Vite preview did not become ready within 30s');
}

async function runOne({ implementation, path, globalName }, baseUrl, runIndex) {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer',
      '--ignore-gpu-blocklist',
    ],
    chromiumSandbox: true,
  });
  const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const cdp = config.cpuProfile ? await context.newCDPSession(page) : undefined;
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    const nativeRequestAnimationFrame = globalThis.requestAnimationFrame.bind(globalThis);
    const callbackState = { active: false, samples: [] };
    globalThis.__threeForgeaxRafCallbackTracker = callbackState;
    globalThis.requestAnimationFrame = (callback) =>
      nativeRequestAnimationFrame((timestamp) => {
        const start = performance.now();
        try {
          callback(timestamp);
        } finally {
          if (callbackState.active) {
            callbackState.samples.push({
              timestamp,
              durationMs: performance.now() - start,
              name: callback.name,
            });
          }
        }
      });
    const state = { active: false, done: false, last: null, intervals: [] };
    globalThis.__threeForgeaxFrameTracker = state;
    const tick = (now) => {
      if (state.active && state.last !== null) state.intervals.push(now - state.last);
      state.last = state.active ? now : null;
      if (!state.done) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const url = `${baseUrl}${path}?${queryString()}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(
      ({ name, target }) => globalThis[name]?.frameProgress >= target,
      { name: globalName, target: config.warmupFrames },
      { timeout: config.timeoutMs },
    );
    if (cdp !== undefined) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.start');
    }
    await page.evaluate(() => {
      const state = globalThis.__threeForgeaxFrameTracker;
      const callbacks = globalThis.__threeForgeaxRafCallbackTracker;
      state.active = true;
      state.last = null;
      state.intervals = [];
      callbacks.active = true;
      callbacks.samples = [];
    });
    await page.waitForFunction(
      ({ name, target }) => globalThis[name]?.frameProgress >= target,
      { name: globalName, target: config.warmupFrames + config.measureFrames + 1 },
      { timeout: config.timeoutMs },
    );
    let cpuProfilePath = null;
    if (cdp !== undefined) {
      const stopped = await cdp.send('Profiler.stop');
      cpuProfilePath = resolve(
        dirname(outputPath),
        `${implementation}-run-${runIndex + 1}.cpuprofile`,
      );
      mkdirSync(dirname(cpuProfilePath), { recursive: true });
      writeFileSync(cpuProfilePath, JSON.stringify(stopped.profile));
    }
    const captured = await page.evaluate((name) => {
      const evidence = globalThis[name];
      const tracker = globalThis.__threeForgeaxFrameTracker;
      const callbacks = globalThis.__threeForgeaxRafCallbackTracker;
      tracker.active = false;
      tracker.done = true;
      callbacks.active = false;
      return {
        evidence,
        intervals: [...tracker.intervals],
        callbackSamples: [...callbacks.samples],
        userAgent: navigator.userAgent,
        devicePixelRatio: window.devicePixelRatio,
      };
    }, globalName);
    const screenshotPath = resolve(
      dirname(outputPath),
      `${implementation}-${config.cubes}-p${config.pointLights}-s${config.spotLights}-run-${runIndex + 1}.png`,
    );
    const screenshot = await page.locator('#app').screenshot({ path: screenshotPath, type: 'png' });
    const imageAnalysis = await page.evaluate(async (base64) => {
      const response = await fetch(`data:image/png;base64,${base64}`);
      const bitmap = await createImageBitmap(await response.blob());
      const copy = document.createElement('canvas');
      copy.width = bitmap.width;
      copy.height = bitmap.height;
      const context = copy.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('comparison 2D readback is unavailable');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      let nonClearPixels = 0;
      let sumLuma = 0;
      let sumLumaSquared = 0;
      let maxLuma = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const r = (pixels[index] ?? 0) / 255;
        const g = (pixels[index + 1] ?? 0) / 255;
        const b = (pixels[index + 2] ?? 0) / 255;
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sumLuma += luma;
        sumLumaSquared += luma * luma;
        maxLuma = Math.max(maxLuma, luma);
        if (r > 8 / 255 || g > 8 / 255 || b > 14 / 255) nonClearPixels += 1;
      }
      const pixelCount = pixels.length / 4;
      const meanLuma = sumLuma / pixelCount;
      return {
        width: copy.width,
        height: copy.height,
        nonClearPixels,
        meanLuma,
        maxLuma,
        lumaVariance: sumLumaSquared / pixelCount - meanLuma * meanLuma,
      };
    }, screenshot.toString('base64'));
    const evidence = captured.evidence;
    const hostIntervals = captured.intervals
      .filter((value) => Number.isFinite(value) && value > 0)
      .slice(-config.measureFrames);
    const intervals = (evidence?.frameIntervalsMs ?? [])
      .filter((value) => Number.isFinite(value) && value > 0)
      .slice(-config.measureFrames);
    const validationErrors = validateEvidence(implementation, evidence, intervals, pageErrors, consoleErrors);
    const frameFps = intervals.map((value) => 1000 / value);
    const updateSamples = (evidence?.cubeUpdateSamplesMs ?? []).slice(-config.measureFrames);
    const renderSamples = (evidence?.renderSamplesMs ?? []).slice(-config.measureFrames);
    const rafWork = summarizeRafCallbackWork(captured.callbackSamples, config.measureFrames);
    return {
      implementation,
      run: runIndex + 1,
      valid: validationErrors.length === 0,
      errors: validationErrors,
      pageErrors,
      consoleErrors,
      userAgent: captured.userAgent,
      devicePixelRatio: captured.devicePixelRatio,
      cpuProfilePath,
      screenshotPath,
      imageAnalysis,
      evidence: compactEvidence(evidence),
      samples: {
        intervalsMs: intervals,
        hostIntervalsMs: hostIntervals,
        hostFrameTimeMs: stats(hostIntervals),
        fps: frameFps,
        frameTimeMs: stats(intervals),
        fpsStats: stats(frameFps),
        fpsP05: lowerTail(frameFps, 0.05),
        rafWork,
        cubeUpdateMs: stats(updateSamples),
        renderMs: renderSamples.length === 0 ? null : stats(renderSamples),
      },
    };
  } catch (error) {
    return {
      implementation,
      run: runIndex + 1,
      valid: false,
      errors: [error instanceof Error ? error.message : String(error)],
      pageErrors,
      consoleErrors,
      evidence: null,
      samples: null,
    };
  } finally {
    await browser.close();
  }
}

function summarizeRafCallbackWork(samples, frameLimit) {
  const byTimestamp = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample?.timestamp) || !Number.isFinite(sample?.durationMs)) continue;
    const frame = byTimestamp.get(sample.timestamp) ?? { totalMs: 0, maxMs: 0, callbackCount: 0 };
    frame.totalMs += sample.durationMs;
    frame.maxMs = Math.max(frame.maxMs, sample.durationMs);
    frame.callbackCount += 1;
    byTimestamp.set(sample.timestamp, frame);
  }
  const frames = [...byTimestamp.values()].slice(-frameLimit);
  return {
    frameCount: frames.length,
    callbackCount: frames.reduce((total, frame) => total + frame.callbackCount, 0),
    totalCallbackMs: stats(frames.map((frame) => frame.totalMs)),
    maxCallbackMs: stats(frames.map((frame) => frame.maxMs)),
    callbackCountPerFrame: stats(frames.map((frame) => frame.callbackCount)),
  };
}

function compactEvidence(evidence) {
  if (evidence === undefined || evidence === null) return null;
  return {
    implementation: evidence.implementation,
    version: evidence.version,
    backend: evidence.backend,
    workloadFingerprint: evidence.workloadFingerprint,
    seed: evidence.seed,
    requestedCounts: evidence.requestedCounts,
    postSpawn: evidence.postSpawn,
    frameProgress: evidence.frameProgress,
    processedCubeCount: evidence.processedCubeCount,
    cameraRotationRadians: evidence.cameraRotationRadians,
    bootstrapMs: evidence.bootstrapMs,
    frameErrors: evidence.frameErrors ?? [],
    appRendererErrors: evidence.appRendererErrors ?? [],
    profileCapture: evidence.profileCapture ?? null,
    profileSummary: evidence.profileSummary ?? null,
    rendererInfo: evidence.rendererInfo ?? null,
    rendererInspection: evidence.rendererInspection ?? null,
  };
}

function validateEvidence(implementation, evidence, intervals, pageErrors, consoleErrors) {
  const errors = [];
  if (evidence === undefined || evidence === null) errors.push('benchmark evidence was not published');
  if (evidence?.backend !== 'webgpu') errors.push('backend is not WebGPU');
  if (evidence?.postSpawn?.cubeCount !== config.cubes) errors.push('cube count drifted');
  if (evidence?.processedCubeCount !== config.cubes) errors.push('not every cube was updated');
  if (evidence?.postSpawn?.pointLightCount !== config.pointLights) errors.push('point-light count drifted');
  if (evidence?.postSpawn?.spotLightCount !== config.spotLights) errors.push('spot-light count drifted');
  if ((evidence?.frameErrors ?? []).length > 0) errors.push('implementation reported frame errors');
  if ((evidence?.appRendererErrors ?? []).length > 0) errors.push('ForgeaX reported renderer errors');
  if (intervals.length !== config.measureFrames) {
    errors.push(`captured ${intervals.length}/${config.measureFrames} frame intervals`);
  }
  if (pageErrors.length > 0) errors.push(`page errors: ${pageErrors.join(' | ')}`);
  if (consoleErrors.length > 0) errors.push(`console errors: ${consoleErrors.join(' | ')}`);
  return errors;
}

function workloadParityErrors(reference, candidate) {
  const errors = [];
  if (candidate?.workloadFingerprint !== reference?.workloadFingerprint) {
    errors.push('workload fingerprint differs between implementations');
  }
  if (candidate?.seed !== reference?.seed) errors.push('workload seed differs between implementations');
  const referenceCounts = reference?.requestedCounts;
  const candidateCounts = candidate?.requestedCounts;
  for (const key of ['cubeCount', 'pointLightCount', 'spotLightCount']) {
    if (candidateCounts?.[key] !== referenceCounts?.[key]) {
      errors.push(`requested ${key} differs between implementations`);
    }
  }
  if (candidate?.postSpawn?.positionChecksum !== reference?.postSpawn?.positionChecksum) {
    errors.push('position checksum differs between implementations');
  }
  return errors;
}

function aggregate(runs) {
  const validRuns = runs.filter((run) => run.valid && run.samples !== null);
  const intervals = validRuns.flatMap((run) => run.samples.intervalsMs);
  const fps = validRuns.flatMap((run) => run.samples.fps);
  // Keep aggregate statistics sample-based; per-run summaries are retained in
  // the report so a noisy machine can be identified instead of averaged away.
  const updateMedians = validRuns
    .map((run) => run.samples.cubeUpdateMs?.median)
    .filter((value) => typeof value === 'number');
  const renderMedians = validRuns
    .map((run) => run.samples.renderMs?.median)
    .filter((value) => typeof value === 'number');
  const initMedians = validRuns
    .map((run) => run.evidence?.bootstrapMs)
    .filter((value) => typeof value === 'number');
  const rafWorkMedians = validRuns
    .map((run) => run.samples.rafWork?.totalCallbackMs?.median)
    .filter((value) => typeof value === 'number');
  const imageMeanLuma = validRuns
    .map((run) => run.imageAnalysis?.meanLuma)
    .filter((value) => typeof value === 'number');
  const imageMaxLuma = validRuns
    .map((run) => run.imageAnalysis?.maxLuma)
    .filter((value) => typeof value === 'number');
  return {
    validRuns: validRuns.length,
    totalRuns: runs.length,
    frameTimeMs: stats(intervals),
    fps: { ...stats(fps), p05: lowerTail(fps, 0.05) },
    perRunMedianFrameTimeMs: validRuns.map((run) => run.samples.frameTimeMs.median),
    perRunMedianFps: validRuns.map((run) => run.samples.fpsStats.median),
    perRunP05Fps: validRuns.map((run) => run.samples.fpsP05),
    cubeUpdateMs: stats(updateMedians),
    renderMs: renderMedians.length === 0 ? null : stats(renderMedians),
    bootstrapMs: stats(initMedians),
    rafWorkMs: stats(rafWorkMedians),
    imageMeanLuma: stats(imageMeanLuma),
    imageMaxLuma: stats(imageMaxLuma),
  };
}

function ratio(left, right) {
  return typeof left === 'number' && typeof right === 'number' && right !== 0 ? left / right : null;
}

function gitCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function main() {
  spawnBuild();
  if (!existsSync(resolve(appRoot, 'dist', 'index.html')) || !existsSync(resolve(appRoot, 'dist', 'three.html'))) {
    fail('dist/index.html and dist/three.html are required after build');
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  const { server, baseUrl } = await startPreview();
  const cases = [
    { implementation: 'forgeax', path: '/', globalName: '__forgeaxPerf' },
    { implementation: 'three', path: '/three.html', globalName: '__threePerf' },
  ];
  const runs = [];
  try {
    for (let runIndex = 0; runIndex < config.runs; runIndex += 1) {
      // Counterbalance thermal/cache drift while preserving deterministic run ids.
      const roundCases = runIndex % 2 === 0 ? cases : [...cases].reverse();
      for (const entry of roundCases) {
        process.stdout.write(
          `[compare] ${entry.implementation} run ${runIndex + 1}/${config.runs} ` +
            `(${config.cubes} cubes, ${config.pointLights + config.spotLights} clustered punctual lights; ` +
              `${config.pointLights} point/${config.spotLights} spot)\n`,
        );
        const result = await runOne(entry, baseUrl, runIndex);
        runs.push(result);
        process.stdout.write(
          `[compare] ${entry.implementation} run ${runIndex + 1}: ` +
            `${result.valid ? 'PASS' : 'FAIL'} ` +
            `${result.samples?.frameTimeMs?.median?.toFixed?.(3) ?? 'n/a'} ms median frame\n`,
        );
      }
    }
  } finally {
    server.kill('SIGTERM');
  }

  const forgeaxRuns = runs.filter((run) => run.implementation === 'forgeax');
  const threeRuns = runs.filter((run) => run.implementation === 'three');
  const referenceEvidence = forgeaxRuns.find((run) => run.evidence !== null)?.evidence;
  const referenceWorkloadFingerprint = referenceEvidence?.workloadFingerprint;
  const workloadIdentity =
    typeof referenceWorkloadFingerprint === 'string'
      ? (referenceWorkloadFingerprint.split('|', 1)[0] ?? null)
      : null;
  if (referenceEvidence !== undefined) {
    for (const run of runs) {
      const parityErrors = workloadParityErrors(referenceEvidence, run.evidence);
      if (parityErrors.length > 0) {
        run.valid = false;
        run.errors.push(...parityErrors);
      }
    }
  }
  const forgeax = aggregate(forgeaxRuns);
  const three = aggregate(threeRuns);
  const valid = runs.length === config.runs * 2 && runs.every((run) => run.valid);
  const report = {
    schema: 'forgeax.three-object-comparison.v1',
    status: valid ? 'ok' : 'blocked',
    generatedAt: new Date().toISOString(),
    engineCommit: gitCommit(),
    threeVersion: '0.184.0',
    backend: 'webgpu',
    browser: runs.find((run) => run.userAgent)?.userAgent ?? null,
    viewport: { width: 320, height: 180, deviceScaleFactor: 1 },
    config,
    workload: {
      identity: workloadIdentity,
      fingerprint: referenceWorkloadFingerprint ?? null,
      seed: 0x010c0b35,
      volume: { min: [-24, -16, -24], max: [24, 16, 24] },
      material: 'standard-pbr / MeshStandardMaterial',
      objectPath: '10,000 independent render objects; no instancing',
      query: `?${queryString()}`,
    },
    summary: {
      forgeax,
      three,
      ratios: {
        threeOverForgeaxFrameTimeMedian: ratio(three.frameTimeMs.median, forgeax.frameTimeMs.median),
        forgeaxOverThreeFpsMedian: ratio(forgeax.fps.median, three.fps.median),
        threeOverForgeaxUpdateMedian: ratio(three.cubeUpdateMs.median, forgeax.cubeUpdateMs.median),
        threeOverForgeaxMeanLuma: ratio(three.imageMeanLuma.median, forgeax.imageMeanLuma.median),
      },
    },
    runs,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[compare] ${valid ? 'PASS' : 'BLOCKED'} report=${outputPath}\n`);
  if (!valid) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
