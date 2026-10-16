#!/usr/bin/env node
// run-fps.mjs (M5 w23 + M4 T-M4-2) - dedicated fps reporter (separate from run-all.mjs).
//
// Per plan-strategy K-11 fps measurement runs in its own CI step (vite preview
// boot is too slow to fit the 30s budget of run-all.mjs). This script honours
// that boundary while still writing into the same 2D report tree
// (report/<package>/fps.json) so render-sticky.mjs can fold fps results into
// the same sticky comment as the other kinds.
//
// Behaviour (charter proposition 4 explicit failure + user q4=A AC-09 reversal):
//   - exit 0 + report/<package>/fps.json with status='ok' on success.
//   - exit 1 + status='noisy' / 'unavailable' / 'over' otherwise; stderr 3-section
//     ('metric-status-not-ok') so PRs fail closed.
//
// M4 T-M4-2 / D-6: P95 field + compareKey switch ('p95' | 'median'). hello-
// triangle keeps median (no compareKey field -> default); apps/parity/
// instancing-static sets compareKey='p95' to align with AC-09 (P95 >= 60 fps).
//
// Usage:
//   node scripts/metrics/run-fps.mjs [--root <dir>] [--report-dir <dir>] [--app <package-dir>]
//   --app default = apps/hello/triangle.
//
// Reference:
//   - requirements §AC-05 / §AC-06 / §AC-09
//   - plan-strategy §K-11 / §4.5 / §D-6

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// MetricErrorCode mirror — string literals match `packages/types/src/index.ts`
// `export type MetricErrorCode` SSOT (M1 T-001 + T-002). This fps reporter
// fires `'metric-status-not-ok'` exclusively (every failure path collapses to
// the same kind); the 2 parity members 'pixel-parity-threshold-exceeded' /
// 'pixel-parity-capture-failed' are emitted by `scripts/bench/pixel-parity.mjs`
// (M2 T-009). The frozen array below is the AI-grep anchor that keeps
// drift between TS alias and .mjs producer detectable
// (research Finding 9 §6 g9 checklist item 5).
/** @type {Readonly<('metric-not-declared' | 'metric-kind-unknown' | 'metric-status-not-ok' | 'metric-schema-malformed' | 'pixel-parity-threshold-exceeded' | 'pixel-parity-capture-failed')[]>} */
const KNOWN_METRIC_ERROR_CODES = Object.freeze([
  'metric-not-declared',
  'metric-kind-unknown',
  'metric-status-not-ok',
  'metric-schema-malformed',
  'pixel-parity-threshold-exceeded',
  'pixel-parity-capture-failed',
]);
void KNOWN_METRIC_ERROR_CODES;

// ----------------------------------------------------------------------------
// Pure helpers (M4 T-M4-2 / D-6) — exported for unit tests; no side effects.
// ----------------------------------------------------------------------------

export function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

// computeP95: for fps "higher is better" the meaningful percentile is the
// lowest 5% — the worst-case frames a user actually feels during the sampled
// window. Formula: ascending sort + floor(n * 0.05). floor (not ceil): for the
// canonical 5-sample setup floor(0.25)=0 picks the single worst sample; ceil
// would point past index 0 and dilute the signal. Empty input returns 0
// (matches median() sentinel; production main() guards length before calling).
export function computeP95(numbers) {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.05)];
}

// resolveFpsStatus: pure-function status decision so the compareKey switch is
// unit-testable without spawning vite preview.
//   - no valid samples           -> 'unavailable'
//   - lost samples vs sampleCount -> 'noisy' (frame error during run)
//   - threshold null/undefined    -> 'ok' (no baseline yet, e.g. hello-triangle)
//   - compareKey='median' + median<threshold -> 'noisy'
//   - compareKey='p95'    + p95<threshold    -> 'noisy'
//   - else                        -> 'ok'
// 'metric-status-not-ok' is fired by main() whenever status !== 'ok' (charter
// proposition 4 explicit failure; existing behaviour preserved).
export function resolveFpsStatus({ samples, sampleCount, threshold, compareKey }) {
  if (samples.length === 0) return 'unavailable';
  if (samples.length < sampleCount) return 'noisy';
  if (threshold === null || threshold === undefined) return 'ok';
  const stat = compareKey === 'p95' ? computeP95(samples) : median(samples);
  return stat < threshold ? 'noisy' : 'ok';
}

// withTimeout: Fail Fast backstop (architecture principle #5). playwright's
// page.evaluate has NO internal timeout, so a stalled compositor (rAF never
// fires) hangs the await forever — in CI that decays into a 15m job-level
// cancel (non-success, non-actionable) instead of a structured failure
// (bug-20260622-fps-reporter-lavapipe-raf-stall). Racing the work against a
// timer converts the hang into a rejection within `ms`, which the sample loop
// records as a lost sample -> resolveFpsStatus returns 'noisy' -> exit 1 +
// 'metric-status-not-ok'. The timer is cleared on settle so a winning work
// promise never leaks a pending handle that would keep the event loop alive.
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function viteCliPath(appDir) {
  return resolve(appDir, 'node_modules/vite/bin/vite.js');
}

export function buildPreviewApp(appDir, run = spawnSync) {
  const result = run(process.execPath, [viteCliPath(appDir), 'build'], {
    cwd: appDir,
    stdio: 'inherit',
  });
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    message: `vite build failed with exit code ${result.status ?? 'unknown'}`,
  };
}

export function spawnPreview(appDir, previewHost, previewPort, run = spawn) {
  return run(
    process.execPath,
    [
      viteCliPath(appDir),
      'preview',
      '--host',
      previewHost,
      '--port',
      String(previewPort),
      '--strictPort',
    ],
    { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

/** Stop a directly launched preview and drain its stdio before returning. */
export async function stopPreview(preview, timeoutMs = 5000) {
  if (preview.exitCode !== null || preview.signalCode !== null) return;

  const closed = new Promise((resolveClosed) => preview.once('close', resolveClosed));
  preview.kill('SIGTERM');

  let timeout;
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(true), timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  if (!timedOut) return;

  if (preview.exitCode === null && preview.signalCode === null) preview.kill('SIGKILL');
  await closed;
}

// ----------------------------------------------------------------------------
// CLI entry — gated so `import { computeP95, ... }` from tests does not boot
// vite preview. The check `import.meta.url === url.pathToFileURL(argv[1]).href`
// matches when this file is invoked directly via `node run-fps.mjs ...`.
// ----------------------------------------------------------------------------

const isCliEntry = (() => {
  if (!process.argv[1]) return false;
  try {
    const entryUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === entryUrl;
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  await runFpsCli();
}

async function runFpsCli() {
  const here = dirname(fileURLToPath(import.meta.url));
  const defaultRepoRoot = resolve(here, '..', '..');

  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root' && argv[i + 1]) args.root = argv[++i];
    else if (a === '--report-dir' && argv[i + 1]) args.reportDir = argv[++i];
    else if (a === '--app' && argv[i + 1]) args.app = argv[++i];
  }

  const root = resolve(args.root ?? defaultRepoRoot);
  const reportDir = resolve(args.reportDir ?? `${root}/report`);
  const appDir = resolve(root, args.app ?? 'apps/hello/triangle');

  const pkgJson = JSON.parse(readFileSync(`${appDir}/package.json`, 'utf8'));
  const pkgShortName = (pkgJson.name ?? 'app').replace(/^@[^/]+\//, '');
  const fpsDecl = pkgJson?.forgeax?.metrics?.fps ?? null;
  if (!fpsDecl || fpsDecl.enabled !== true) {
    process.stdout.write(
      `[ok] fps disabled for ${pkgShortName} (forgeax.metrics.fps.enabled=false), nothing to do\n`,
    );
    process.exit(0);
  }

  const sampleCount = Number.parseInt(
    process.env.FPS_SAMPLE_COUNT ?? String(fpsDecl.sampleCount ?? 5),
    10,
  );
  const framesPerSample = Number.parseInt(
    process.env.FPS_FRAMES_PER_SAMPLE ?? String(fpsDecl.frameCount ?? 120),
    10,
  );
  const previewPort = Number.parseInt(process.env.PREVIEW_PORT ?? '4174', 10);
  const previewHost = process.env.PREVIEW_HOST ?? '127.0.0.1';
  const previewUrl = `http://${previewHost}:${previewPort}/`;
  const threshold = fpsDecl.baseline?.threshold ?? null;
  const compareKey = fpsDecl.compareKey === 'p95' ? 'p95' : 'median';

  function failStructured(code, expected, hint) {
    process.stderr.write(
      `[reason] ${code}: ${expected}\n[rerun]  pnpm metrics:run\n[hint]   ${hint}\n`,
    );
    process.exit(1);
  }

  function writeReport(report) {
    const outDir = resolve(reportDir, pkgShortName);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, 'fps.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }

  function buildEntry(status, value, samples, message, extras = {}) {
    const entry = {
      package: pkgShortName,
      member: `apps/${pkgShortName}`,
      kind: 'fps',
      enabled: true,
      status,
      value,
      threshold,
      details: { sampleCount, frameCount: framesPerSample, samples, compareKey, ...extras },
    };
    if (message) entry.details.message = message;
    return entry;
  }

  const appBuild = buildPreviewApp(appDir);
  if (!appBuild.ok) {
    writeReport(buildEntry('unavailable', null, [], appBuild.message));
    failStructured(
      'metric-status-not-ok',
      `apps/${pkgShortName}.fps reports status === 'ok'`,
      `build apps/${pkgShortName} before preview; inspect report/${pkgShortName}/fps.json`,
    );
  }

  const preview = spawnPreview(appDir, previewHost, previewPort);
  let stopPreviewPromise;
  const stopPreviewServer = () => {
    stopPreviewPromise ??= stopPreview(preview);
    return stopPreviewPromise;
  };
  const killPreview = () => {
    if (preview.exitCode === null && preview.signalCode === null) preview.kill('SIGTERM');
  };
  process.on('exit', killPreview);
  process.on('SIGINT', () => void stopPreviewServer().finally(() => process.exit(130)));

  preview.stdout.on('data', (chunk) => process.stdout.write(`[preview:stdout] ${chunk}`));
  preview.stderr.on('data', (chunk) => process.stderr.write(`[preview:stderr] ${chunk}`));

  async function waitForPreview(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(previewUrl);
        if (res.ok) return;
      } catch {
        /* not ready yet */
      }
      await delay(200);
    }
    throw new Error(`vite preview not ready at ${previewUrl} within ${timeoutMs}ms`);
  }

  try {
    await waitForPreview();
  } catch (err) {
    await stopPreviewServer();
    writeReport(buildEntry('unavailable', null, [], err.message));
    failStructured(
      'metric-status-not-ok',
      `apps/${pkgShortName}.fps reports status === 'ok'`,
      `inspect report/${pkgShortName}/fps.json for value vs threshold; rerun: pnpm metrics:run`,
    );
  }

  let chromium;
  try {
    const requireFromApp = createRequire(`${appDir}/package.json`);
    const playwrightModule = requireFromApp('playwright');
    chromium = playwrightModule?.chromium;
    if (!chromium) throw new Error('playwright.chromium not found');
  } catch (err) {
    await stopPreviewServer();
    writeReport(buildEntry('unavailable', null, [], `playwright not importable: ${err.message}`));
    failStructured(
      'metric-status-not-ok',
      `apps/${pkgShortName}.fps reports status === 'ok'`,
      `inspect report/${pkgShortName}/fps.json for value vs threshold; rerun: pnpm metrics:run`,
    );
  }

  let browser;
  try {
    // --disable-gpu: the fps reporter only counts raw requestAnimationFrame
    // callbacks (no WebGPU dependency — see ci.yml metrics-validate comment).
    // The metrics-validate job's `Detect lavapipe ICD` step exports
    // VK_ICD_FILENAMES / VK_DRIVER_FILES into $GITHUB_ENV, which leak into this
    // step's env. Without this flag headless chromium's GPU process picks up the
    // lavapipe ICD and tries to init software Vulkan; that init intermittently
    // stalls the compositor, so rAF stops firing and page.evaluate (which has no
    // internal timeout) hangs until the 15m job-level cancel
    // (bug-20260622-fps-reporter-lavapipe-raf-stall). Forcing the pure-software
    // compositor path keeps rAF on a CPU timer that never touches Vulkan.
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-gpu'],
      chromiumSandbox: true,
    });
  } catch (err) {
    await stopPreviewServer();
    writeReport(buildEntry('unavailable', null, [], `chromium launch failed: ${err.message}`));
    failStructured(
      'metric-status-not-ok',
      `apps/${pkgShortName}.fps reports status === 'ok'`,
      `inspect report/${pkgShortName}/fps.json for value vs threshold; rerun: pnpm metrics:run`,
    );
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(previewUrl, { waitUntil: 'load' });
  await delay(500);

  async function measureOneSample(framesPerSampleArg) {
    return await page.evaluate(async (n) => {
      return await new Promise((res) => {
        const start = performance.now();
        let count = 0;
        const tick = () => {
          count += 1;
          if (count >= n) {
            res(performance.now() - start);
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }, framesPerSampleArg);
  }

  // Per-sample wall-clock ceiling. A healthy sample is framesPerSample/60s
  // (~2s for the 120-frame default); even a slow lavapipe runner finishes in a
  // few seconds. 30s is far above any healthy sample yet far below the 15m
  // job-level timeout, so a stalled rAF fails in seconds with a structured
  // 'metric-status-not-ok' instead of an opaque job cancel. Override via
  // FPS_SAMPLE_TIMEOUT_MS for slower environments.
  const sampleTimeoutMs = Number.parseInt(process.env.FPS_SAMPLE_TIMEOUT_MS ?? '30000', 10);

  const samples = [];
  for (let i = 0; i < sampleCount; i++) {
    try {
      const elapsedMs = await withTimeout(
        measureOneSample(framesPerSample),
        sampleTimeoutMs,
        `fps sample ${i + 1}/${sampleCount}`,
      );
      const fps = elapsedMs > 0 ? (framesPerSample * 1000) / elapsedMs : 0;
      samples.push({ frames: framesPerSample, elapsed_ms: elapsedMs, fps });
      process.stdout.write(
        `[fps] sample ${i + 1}/${sampleCount}: ${fps.toFixed(2)} fps over ${elapsedMs.toFixed(1)}ms\n`,
      );
    } catch (err) {
      samples.push({ frames: framesPerSample, elapsed_ms: null, fps: 0, error: String(err) });
    }
  }

  await context.close();
  await browser.close();
  await stopPreviewServer();

  const validFps = samples.filter((s) => s.fps > 0).map((s) => s.fps);
  const medianFps = validFps.length > 0 ? median(validFps) : 0;
  const p95Fps = validFps.length > 0 ? computeP95(validFps) : 0;
  const status = resolveFpsStatus({
    samples: validFps,
    sampleCount,
    threshold,
    compareKey,
  });

  const reportedValue = compareKey === 'p95' ? p95Fps : medianFps;
  const entry = buildEntry(status, Number(reportedValue.toFixed(2)), samples, undefined, {
    median: Number(medianFps.toFixed(2)),
    p95: Number(p95Fps.toFixed(2)),
  });
  writeReport(entry);
  process.stdout.write(
    `[fps] ${compareKey} ${entry.value} fps across ${validFps.length}/${sampleCount} samples (median=${medianFps.toFixed(2)} p95=${p95Fps.toFixed(2)} status=${status})\n`,
  );

  if (status !== 'ok') {
    failStructured(
      'metric-status-not-ok',
      `apps/${pkgShortName}.fps reports status === 'ok'`,
      `inspect report/${pkgShortName}/fps.json for value vs threshold; rerun: pnpm metrics:run`,
    );
  }
}
