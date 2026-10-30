#!/usr/bin/env node
// scripts/bench/pixel-parity.mjs — pixel-parity bench runner (native dual-fixture).
//
// Orchestrates the full capture pipeline:
//   1. spawn × 1 vite preview for the selected target (port 4174 for
//      @forgeax/parity-forgeax; 4175 for @forgeax/parity-urp-vs-hdrp).
//   2. wait-on tcp 30s for the preview port.
//   3. chromium.launch({ args: ['--enable-unsafe-webgpu', ...] }).
//   4. browser.newContext + one page; two captures via window.__captureLeft
//      and window.__captureRight from the same frame (D-1 / D-3: single
//      ForgeAX render provides both hooks — self-consistency check).
//   5. Evaluate parity inline (Node-side mirror of
//      apps/parity/forgeax/src/evaluate-parity.ts; semantics SSOT'd in
//      TS — see that file's tests for the 9-case contract). The .ts
//      surface is the AI-user-facing SDK (consumed via
//      apps/parity/forgeax/package.json#exports['./evaluate-parity']);
//      this Node mirror exists only so the bench command does not need
//      a TS runtime loader.
//   6. Write the target report (report/pixel-parity.json or
//      report/pixel-parity-standard-lanes.json; D-P12 Schema-as-Contract).
//   7. CLI exhaustive switch (result.error.code) over MetricErrorCode
//      6 members for exit code + stderr three-part output (D-P9 #2).
//   8. try/finally cleanup: SIGTERM + 5s SIGKILL fallback for vite
//      preview + browser.close (research Finding 4).
//
// CLI surface (`pnpm bench:pixel-parity`):
//   - exit 0   — parity within threshold; report written.
//   - exit 65  — pixel-parity-threshold-exceeded (EX_DATAERR vibe).
//   - exit 74  — pixel-parity-capture-failed (EX_IOERR vibe).
//   - exit 70  — metric-status-not-ok (infra failure).
//   - exit 78  — metric-not-declared / metric-kind-unknown /
//                metric-schema-malformed (EX_CONFIG vibe).
//
// Env overrides:
//   PIXEL_PARITY_THRESHOLD             — diagnostic override of the fixture's pixel-count cap.
//   PIXEL_PARITY_PER_PIXEL_THRESHOLD   — diagnostic override of its per-pixel epsilon.
//   FORGEAX_BROWSER_HEADLESS           — set to 0/false for headed Chromium
//                                        under Xvfb on Linux software-WebGPU
//                                        runners; headless GPU-process teardown
//                                        can destroy the device mid-capture.
//   BENCH_TARGET                       — parity-forgeax (default),
//                                        parity-standard-lanes, or all.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import pixelmatch from 'pixelmatch';

// Heavy deps (playwright + wait-on) are deferred to main() so importing
// this module for its evaluator / validator helpers (e.g. unit tests
// under scripts/metrics/__tests__/bench-report-schema.test.mjs) does
// not pay the chromium binary discovery cost or block on TCP probes.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const REPORT_DIR = resolve(REPO_ROOT, 'report');
const SCHEMA_PATH = resolve(REPO_ROOT, 'schemas/forgeax-metrics.schema.json');

// Bench targets: pick which fixture pair the bench drives. Default is the
// historical 'parity-forgeax' (D-1 / D-3 left/right both from the same forgeax
// preview); 'parity-standard-lanes' drives the Standard direct-vs-clustered
// fixture so AC-22's ε ≤ 0.001 ≤4-light parity becomes machine-checkable. The
// CI producer may select `all` to run both targets from one Node/Xvfb command
// while retaining one report and one preview lifecycle per fixture.
const BENCH_TARGETS = {
  'parity-forgeax': {
    filter: '@forgeax/parity-forgeax',
    root: 'apps/parity/forgeax',
    port: 4174,
    reportFile: 'pixel-parity.json',
  },
  'parity-standard-lanes': {
    filter: '@forgeax/parity-urp-vs-hdrp',
    root: 'apps/parity/urp-vs-hdrp',
    port: 4175,
    reportFile: 'pixel-parity-standard-lanes.json',
  },
};
const BENCH_TARGET_ALL = 'all';
const BENCH_TARGET = process.env.BENCH_TARGET ?? 'parity-forgeax';
const BENCH_TARGET_NAMES =
  BENCH_TARGET === BENCH_TARGET_ALL ? Object.keys(BENCH_TARGETS) : [BENCH_TARGET];
if (BENCH_TARGET_NAMES.some((targetName) => BENCH_TARGETS[targetName] === undefined)) {
  console.error(
    `[bench:pixel-parity] unknown BENCH_TARGET=${BENCH_TARGET}; valid: ${Object.keys(BENCH_TARGETS).join(' | ')} | ${BENCH_TARGET_ALL}`,
  );
  process.exit(78);
}
const CANVAS_W = 512;
const CANVAS_H = 512;
const PIXELMATCH_DEFAULT_PER_PIXEL_THRESHOLD = 0.1;

export function readParityThresholds(packageRoot, env = process.env) {
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  const declared = manifest.forgeax.metrics.bench.pixelDiff;
  return {
    threshold: Number.parseInt(env.PIXEL_PARITY_THRESHOLD ?? String(declared.threshold), 10),
    perPixelThreshold: Number.parseFloat(
      env.PIXEL_PARITY_PER_PIXEL_THRESHOLD ??
        String(declared.perPixelThreshold ?? PIXELMATCH_DEFAULT_PER_PIXEL_THRESHOLD),
    ),
  };
}

// ─── learn-render section-1 7-entry placeholder registry (feat-20260515 M4) ───
//
// plan-strategy section 2.7 Open Q-1 option (a): each example milestone
// (M5-M11) records its own golden PNG into forgeax-engine-assets/
// feat-20260515-learn-render-getting-started/screenshots/round-N-<topic>.png.
// M4 milestone establishes the entry placeholder so AI users grep
// `learn-render-1-` once and see the full 7-entry roadmap; M5-M11 fills
// the `expected` field with the real baseline path; M12 milestone walks
// the registry to verify all 7 baselines exist (AC-04).
//
// At M4 the entries carry `expected: 'tbd'` and SKIP at runtime; the
// native dual-fixture left/right capture path (D-1 / D-3) stays
// unchanged. M7-M11 lookup `LEARN_RENDER_BENCH_ENTRIES` and append per-
// entry capture sites without touching this scaffold (architecture
// principle #6 idempotency).
//
// The registry is exported so unit tests under scripts/metrics/__tests__/
// can assert the 7-entry shape without invoking the runner.
export const LEARN_RENDER_BENCH_ENTRIES = Object.freeze([
  {
    name: 'app-learn-render-1-getting-started-1-hello-window',
    topic: 'hello-window',
    expected: 'recorded',
    baseline:
      'forgeax-engine-assets/feat-20260515-learn-render-getting-started/screenshots/round-1-hello-window.png',
    fillsAt: 'M5',
  },
  {
    name: 'app-learn-render-1-getting-started-2-hello-triangle',
    topic: 'hello-triangle',
    expected: 'recorded',
    baseline:
      'forgeax-engine-assets/feat-20260515-learn-render-getting-started/screenshots/round-2-hello-triangle.png',
    fillsAt: 'M6',
    note: 'M6 baseline copies apps/hello/triangle golden PNG (PD-4 redirect SSOT)',
  },
  {
    name: 'app-learn-render-1-getting-started-3-shaders',
    topic: 'shaders',
    expected: 'recorded',
    baseline:
      'forgeax-engine-assets/feat-20260515-learn-render-getting-started/screenshots/round-3-shaders.png',
    fillsAt: 'M7',
  },
  {
    name: 'app-learn-render-1-getting-started-4-textures',
    topic: 'textures',
    expected: 'recorded',
    baseline:
      'forgeax-engine-assets/feat-20260515-learn-render-getting-started/screenshots/round-4-textures.png',
    fillsAt: 'M8',
  },
  {
    name: 'app-learn-render-1-getting-started-5-transformations',
    topic: 'transformations',
    expected: 'recorded',
    baseline:
      'forgeax-engine-assets/feat-20260515-learn-render-getting-started/screenshots/round-5-transformations.png',
    fillsAt: 'M9',
  },
  {
    name: 'app-learn-render-1-getting-started-6-coordinate-systems',
    topic: 'coordinate-systems',
    expected: 'recorded',
    baseline:
      'forgeax-engine-assets/feat-20260515-learn-render-getting-started/screenshots/round-6-coordinate-systems.png',
    fillsAt: 'M10',
  },
  {
    name: 'app-learn-render-1-getting-started-7-camera',
    topic: 'camera',
    expected: 'recorded',
    baseline:
      'forgeax-engine-assets/feat-20260515-learn-render-getting-started/screenshots/round-7-camera.png',
    fillsAt: 'M11',
  },
]);

// Reference the constant so it survives tree-shaking + grep gates (charter
// F1: AI users discover the 7-entry surface via a single grep).
void LEARN_RENDER_BENCH_ENTRIES;

// ─── pure-function evaluator (mirror of apps/parity/forgeax/src/evaluate-parity.ts) ───
//
// Kept inline so this .mjs file is Node-loadable without a TS runtime
// loader. The TS source remains the AI-user-facing SDK + the
// vitest-tested SSOT; semantics here mirror it 1:1. Any divergence is
// caught by the runner integration phase (M3 T-016 CI step).

function evaluateParity(leftPixels, rightPixels, opts) {
  const { threshold, width, height } = opts;
  const perPixelThreshold = opts.perPixelThreshold ?? PIXELMATCH_DEFAULT_PER_PIXEL_THRESHOLD;
  // Step 1
  if (leftPixels.length === 0 || rightPixels.length === 0) {
    return errResult('pixel-parity-capture-failed', {
      stage: 'pixel-readback',
      leftSize: leftPixels.length,
      rightSize: rightPixels.length,
    });
  }
  // Step 2
  if (leftPixels.length !== rightPixels.length) {
    return errResult('pixel-parity-capture-failed', {
      stage: 'size-mismatch',
      leftSize: leftPixels.length,
      rightSize: rightPixels.length,
    });
  }
  // Step 4-5
  let diffPixelCount;
  try {
    diffPixelCount = pixelmatch(leftPixels, rightPixels, undefined, width, height, {
      threshold: perPixelThreshold,
      includeAA: false,
      alpha: 0.1,
    });
  } catch (caught) {
    void caught;
    return errResult('pixel-parity-capture-failed', {
      stage: 'diff',
      leftSize: leftPixels.length,
      rightSize: rightPixels.length,
    });
  }
  // Step 6
  let maxChannelDelta = 0;
  for (let i = 0; i < leftPixels.length; i += 4) {
    const dr = Math.abs((leftPixels[i] ?? 0) - (rightPixels[i] ?? 0));
    const dg = Math.abs((leftPixels[i + 1] ?? 0) - (rightPixels[i + 1] ?? 0));
    const db = Math.abs((leftPixels[i + 2] ?? 0) - (rightPixels[i + 2] ?? 0));
    if (dr > maxChannelDelta) maxChannelDelta = dr;
    if (dg > maxChannelDelta) maxChannelDelta = dg;
    if (db > maxChannelDelta) maxChannelDelta = db;
  }
  const totalPixels = width * height;
  const diffPercent = diffPixelCount / totalPixels;
  // Step 7
  if (diffPixelCount > threshold) {
    return errResult('pixel-parity-threshold-exceeded', {
      diffPixelCount,
      diffPercent,
      maxChannelDelta,
      threshold,
      perPixelThreshold,
    });
  }
  // Step 8
  return {
    ok: true,
    value: { diffPixelCount, diffPercent, maxChannelDelta, threshold, perPixelThreshold },
  };
}

function errResult(code, detail) {
  return {
    ok: false,
    error: {
      code,
      expected: expectedFor({ code }),
      hint: hintFor({ code }),
      detail,
    },
  };
}

// Exhaustive switch over MetricErrorCode (6 members). NO default branch
// — adding / removing a member in the TS alias must surface here via
// the M3 T-015 dispatcher's grep gate that reads this file.
function expectedFor(arg) {
  switch (arg.code) {
    case 'metric-not-declared':
      return 'metric registration present in package.json#forgeax.metrics';
    case 'metric-kind-unknown':
      return 'metric kind belongs to the closed MetricKind union';
    case 'metric-status-not-ok':
      return 'dispatcher reports status=ok';
    case 'metric-schema-malformed':
      return 'schemas/forgeax-metrics.schema.json compiles as JSON Schema 2020-12';
    case 'pixel-parity-threshold-exceeded':
      return 'diffPixelCount <= threshold';
    case 'pixel-parity-capture-failed':
      return 'both pages capture Uint8Array(width * height * 4) with status=ok';
  }
  // Defensive: unreachable when MetricErrorCode union is exhaustively
  // covered above; the only path here would be a producer literal that
  // skipped the TS alias gate. Throw to surface immediately.
  throw new Error(`bench/pixel-parity.mjs: unknown MetricErrorCode literal ${arg.code}`);
}

function hintFor(arg) {
  switch (arg.code) {
    case 'metric-not-declared':
      return 'add package.json#forgeax.metrics declaration with all 5 MetricKind members';
    case 'metric-kind-unknown':
      return 'remove the unknown key from forgeax.metrics or fix the typo';
    case 'metric-status-not-ok':
      return 'inspect the offending report/<package>/<kind>.json for the value-vs-threshold delta';
    case 'metric-schema-malformed':
      return 'check schemas/forgeax-metrics.schema.json for unbalanced braces or missing $defs node';
    case 'pixel-parity-threshold-exceeded':
      return 'inspect git diff for shader / material / camera regressions; if driver noise, bump apps/parity/*/package.json#forgeax.metrics.bench.pixelDiff.threshold in a PR commit (append-only audit)';
    case 'pixel-parity-capture-failed':
      return 'inspect .detail.stage to localize the capture pipeline step; re-run pnpm bench:pixel-parity locally with --enable-unsafe-webgpu verified via chrome://gpu';
  }
  throw new Error(`bench/pixel-parity.mjs: unknown MetricErrorCode literal ${arg.code}`);
}

// ─── runner orchestration ─────────────────────────────────────────────

async function ensureBuild(targetConfig) {
  const appRoot = resolve(REPO_ROOT, targetConfig.root);
  const viteBin = resolve(appRoot, 'node_modules/.bin/vite');
  const command = existsSync(viteBin) ? viteBin : 'pnpm';
  const args = existsSync(viteBin) ? ['build'] : ['--filter', targetConfig.filter, 'build'];
  await new Promise((resolveFn, rejectFn) => {
    const child = spawn(command, args, {
      cwd: existsSync(viteBin) ? appRoot : REPO_ROOT,
      stdio: 'inherit',
    });
    child.on('exit', (code) =>
      code === 0
        ? resolveFn(undefined)
        : rejectFn(new Error(`build ${targetConfig.filter} exit ${code ?? 'null'}`)),
    );
  });
}

function spawnPreview(targetConfig) {
  // Use `--port` and `--host 127.0.0.1` so waitOn can probe TCP on the
  // loopback. The fixture's vite.config.ts already enforces
  // strictPort=true in the preview section, so no CLI flag is needed
  // for that. Launch Vite directly: terminating a pnpm exec wrapper can
  // leave its Vite descendant holding these output pipes open after both
  // fixture captures have completed.
  const appRoot = resolve(REPO_ROOT, targetConfig.root);
  const child = spawn(
    process.execPath,
    [
      resolve(appRoot, 'node_modules/vite/bin/vite.js'),
      'preview',
      '--port',
      String(targetConfig.port),
      '--host',
      '127.0.0.1',
    ],
    { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[${targetConfig.filter}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${targetConfig.filter}] ${chunk}`));
  return child;
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolveFn) => child.once('close', resolveFn));
  child.kill('SIGTERM');

  let timeout;
  const timedOut = await Promise.race([
    closed.then(() => false),
    new Promise((resolveFn) => {
      timeout = setTimeout(() => resolveFn(true), 5000);
    }),
  ]);
  clearTimeout(timeout);
  if (!timedOut) return;

  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await closed;
}

function dispatchAndExit(result, targetName = BENCH_TARGET) {
  const logPrefix = `[bench:pixel-parity:${targetName}]`;
  if (result.ok) {
    console.warn(
      `${logPrefix} PASS diffPixelCount=${result.value.diffPixelCount} <= threshold=${result.value.threshold}`,
    );
    return 0;
  }
  const e = result.error;
  console.error(`${logPrefix} [ERROR ${e.code}]`);
  console.error(`expected: ${e.expected}`);
  console.error(`hint:     ${e.hint}`);
  if (e.detail !== undefined) console.error(`detail:   ${JSON.stringify(e.detail)}`);
  // D-P9 real consumer site #2: full 6-member MetricErrorCode exhaustive
  // switch routes to a process exit code. NO default branch.
  switch (e.code) {
    case 'metric-not-declared':
      return 78;
    case 'metric-kind-unknown':
      return 78;
    case 'metric-status-not-ok':
      return 70;
    case 'metric-schema-malformed':
      return 78;
    case 'pixel-parity-threshold-exceeded':
      return 65;
    case 'pixel-parity-capture-failed':
      return 74;
  }
  // Defensive — unreachable while the union is closed.
  throw new Error(`bench/pixel-parity.mjs: unhandled MetricErrorCode ${e.code}`);
}

// Schema-as-Contract validator (D-P12 + T-020). Compiled lazily so importers
// pay the ajv compile cost only when they actually validate. The report
// shape is the SSOT defined under schemas/forgeax-metrics.schema.json
// $defs.benchReportPixelParity; runner entry/exit must validate against it
// (Fail Fast + Schema as Contract architecture principles).
let _reportValidator = null;
function getReportValidator() {
  if (_reportValidator !== null) return _reportValidator;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const reportSchema = schema?.$defs?.benchReportPixelParity;
  if (!reportSchema) {
    throw new Error(
      'schemas/forgeax-metrics.schema.json $defs.benchReportPixelParity missing (T-020 schema add)',
    );
  }
  _reportValidator = ajv.compile(reportSchema);
  return _reportValidator;
}

export function validateReport(payload) {
  const validator = getReportValidator();
  const ok = validator(payload);
  if (ok) return { ok: true };
  return { ok: false, errors: validator.errors ?? [] };
}

function buildReportPayload(result, thresholds) {
  return result.ok
    ? {
        leftCapture: { bytes: CANVAS_W * CANVAS_H * 4 },
        rightCapture: { bytes: CANVAS_W * CANVAS_H * 4 },
        diffPixelCount: result.value.diffPixelCount,
        diffPercent: result.value.diffPercent,
        maxChannelDelta: result.value.maxChannelDelta,
        threshold: result.value.threshold,
        perPixelThreshold: result.value.perPixelThreshold,
        verdict: 'pass',
      }
    : {
        diffPixelCount: result.error.detail?.diffPixelCount ?? 0,
        diffPercent: result.error.detail?.diffPercent ?? 0,
        maxChannelDelta: result.error.detail?.maxChannelDelta ?? 0,
        ...thresholds,
        verdict: 'fail',
        code: result.error.code,
        expected: result.error.expected,
        hint: result.error.hint,
        detail: result.error.detail ?? null,
      };
}

function writeReport(result, targetConfig) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const REPORT_PATH = resolve(REPORT_DIR, targetConfig.reportFile);
  const payload = buildReportPayload(
    result,
    readParityThresholds(resolve(REPO_ROOT, targetConfig.root)),
  );
  // Fail-fast exit-gate: refuse to write a payload that violates the
  // Schema as Contract ($defs.benchReportPixelParity). If this fires the
  // runner's internal data shape has drifted from the schema; bumping the
  // schema (minor add) is the documented path (charter proposition 4).
  const validation = validateReport(payload);
  if (!validation.ok) {
    throw new Error(
      `[bench:pixel-parity] report payload fails $defs.benchReportPixelParity validation: ${JSON.stringify(
        validation.errors,
      )}`,
    );
  }
  writeFileSync(REPORT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.warn(`[bench:pixel-parity] report -> ${REPORT_PATH}`);
}

async function captureBothFromSinglePage(targetConfig) {
  const { chromium } = await import('playwright');
  const forgeaxUrl = `http://127.0.0.1:${targetConfig.port}`;
  const browserHeadless = !['0', 'false'].includes(
    (process.env.FORGEAX_BROWSER_HEADLESS ?? '1').toLowerCase(),
  );
  const browser = await chromium.launch({
    headless: browserHeadless,
    channel: 'chrome-beta',
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
    ],
    chromiumSandbox: true,
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: CANVAS_W, height: CANVAS_H } });
    const page = await ctx.newPage();
    page.on('console', (msg) => {
      process.stderr.write(`[forgeax.console.${msg.type()}] ${msg.text()}\n`);
    });
    page.on('pageerror', (err) => {
      process.stderr.write(`[forgeax.pageerror] ${err.message}\n`);
    });
    await page.goto(forgeaxUrl, { waitUntil: 'load' });
    // D-1 / D-3: single ForgeAX preview provides both __captureLeft and
    // __captureRight hooks. Wait for both to be installed (they share the
    // same assignment in declare_capture_hook, so either probe works, but
    // checking both is defense-in-depth).
    await page.waitForFunction(
      () =>
        typeof window.__captureLeft === 'function' && typeof window.__captureRight === 'function',
      null,
      { timeout: 30_000 },
    );
    // Both captures share the same function reference (D-1), so they read
    // the same frame. Sequential evaluate avoids any race between draw+read
    // cycles on the same canvas — the second call re-draws + re-reads,
    // producing pixel-identical data when rendering is deterministic.
    const leftArray = await page.evaluate(async () => Array.from(await window.__captureLeft()));
    const rightArray = await page.evaluate(async () => Array.from(await window.__captureRight()));
    return { left: new Uint8Array(leftArray), right: new Uint8Array(rightArray) };
  } finally {
    await browser.close();
  }
}

// Infer which pre-evaluate stage owns a thrown error by matching its
// message against signal phrases from the three pre-capture call sites
// (pnpm build / wait-on preview / chromium.launch). Returns one of the
// ParityCaptureDetail.stage literals so the catch path can route the
// failure through the structured dispatchAndExit channel.
function inferPreEvalStage(message) {
  const m = String(message);
  if (/build\b|pnpm\s+--filter|rolldown|vite\s+build/i.test(m)) return 'vite-preview';
  if (/wait-on|tcp:|preview/i.test(m)) return 'vite-preview';
  if (/chromium|playwright|browser|launch/i.test(m)) return 'chromium-launch';
  return 'chromium-launch';
}

async function runTarget(targetName, waitOn, { build = true } = {}) {
  const targetConfig = BENCH_TARGETS[targetName];
  let forgeaxPreview = null;
  try {
    if (build) await ensureBuild(targetConfig);
    forgeaxPreview = spawnPreview(targetConfig);
    await waitOn({
      resources: [`tcp:127.0.0.1:${targetConfig.port}`],
      timeout: 30_000,
    });
    const { left, right } = await captureBothFromSinglePage(targetConfig);
    const result = evaluateParity(left, right, {
      ...readParityThresholds(resolve(REPO_ROOT, targetConfig.root)),
      width: CANVAS_W,
      height: CANVAS_H,
    });
    writeReport(result, targetConfig);
    return dispatchAndExit(result, targetName);
  } catch (err) {
    // F1: route pre-evaluate throws (pnpm build / wait-on / chromium
    // launch) through the structured MetricError dispatchAndExit channel
    // — not a flattened "FATAL: <msg>" string + raw exit 74. This both
    // preserves the [ERROR code] / expected / hint / detail three-part
    // stderr contract AND ensures the target report is written (Schema as
    // Contract entry/exit gate, architecture-principles §3+§5).
    const message = err instanceof Error ? err.message : String(err);
    const result = errResult('pixel-parity-capture-failed', {
      stage: inferPreEvalStage(message),
      cause: message,
    });
    try {
      writeReport(result, targetConfig);
    } catch (writeErr) {
      // If the schema-validate write itself fails we still want the
      // structured stderr; surface the secondary failure to stderr but
      // do not swap it for the primary cause (which is more actionable).
      console.error(
        '[bench:pixel-parity] report write failed during fatal handler:',
        writeErr instanceof Error ? writeErr.message : String(writeErr),
      );
    }
    return dispatchAndExit(result, targetName);
  } finally {
    if (forgeaxPreview) await killChild(forgeaxPreview);
  }
}

async function main() {
  const { default: waitOn } = await import('wait-on');
  const exitCodes = [];

  // `all` is still one CI job and one Node process (never a GitHub matrix).
  // Build the two independent fixture bundles together, then keep browser
  // capture serialized so WebGPU contexts do not contend for the same runner.
  // This removes duplicate build wall time without weakening either fixture's
  // real browser/readback gate.
  if (BENCH_TARGET_NAMES.length > 1) {
    await Promise.all(
      BENCH_TARGET_NAMES.map((targetName) => ensureBuild(BENCH_TARGETS[targetName])),
    );
  }
  for (const targetName of BENCH_TARGET_NAMES) {
    exitCodes.push(await runTarget(targetName, waitOn, { build: BENCH_TARGET_NAMES.length === 1 }));
  }
  process.exitCode = exitCodes.find((code) => code !== 0) ?? 0;
}

// Main-module guard: only run the bench orchestration when this file is
// invoked as a script (`node scripts/bench/pixel-parity.mjs`); when
// `import`-ed from a test or sibling module, only the exported helpers
// (validateReport / evaluateParity-equivalents) are surfaced.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
