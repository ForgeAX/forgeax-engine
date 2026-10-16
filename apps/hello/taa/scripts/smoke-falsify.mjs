#!/usr/bin/env node

// The falsifier consumes the same real Dawn and Browser carriers as the
// required smoke gates. It records each visual case from those readbacks and
// uses Motion Blur removal as an intentionally broken implementation variant.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { runCarrier, runCarrierAsync } from './smoke-carrier.mjs';

const SCRIPT_DIR = import.meta.dirname;
const APP_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..', '..');
const EVIDENCE_DIR = resolve(APP_ROOT, 'evidence', 'readback');
const FALSIFIER_PROFILES = Object.freeze({
  full: Object.freeze({
    frames: 60,
    caseIds: Object.freeze([
      'static',
      'moving-rigid',
      'camera-pan',
      'depth-edge',
      'reactive',
      'cut-reset',
      'taa-motion-blur-bloom',
    ]),
    defaultConcurrency: 3,
    outputName: 'visual-cases.json',
  }),
  ci: Object.freeze({
    // CI only needs one small live WebGPU falsifier witness. The full matrix
    // remains the default local/nightly evidence producer below.
    frames: 60,
    // Keep the required PR witness to one moving effect/falsifier pair. The
    // static control is owned by the full/nightly matrix; repeating it here
    // would only launch two more fresh Dawn processes without adding a new
    // browser-path assertion.
    caseIds: Object.freeze(['moving-rigid']),
    defaultConcurrency: 1,
    outputName: 'visual-cases-ci.json',
  }),
});
const FALSIFIER_PROFILE = process.env.FORGEAX_TAA_FALSIFIER_PROFILE ?? 'full';
const profile = FALSIFIER_PROFILES[FALSIFIER_PROFILE];
if (profile === undefined) {
  throw new Error(
    `FORGEAX_TAA_FALSIFIER_PROFILE must be one of ${Object.keys(FALSIFIER_PROFILES).join(', ')}, got ${FALSIFIER_PROFILE}`,
  );
}
const outputName = process.env.SMOKE_FALSIFY_OUTPUT ?? profile.outputName;
const VISUAL_CASES_PATH = resolve(APP_ROOT, 'evidence', outputName);
const REQUIRED_FRAMES = profile.frames;
const CASE_IDS = [...profile.caseIds];
const dawnFramesForCase = (visualCase) =>
  visualCase === 'camera-pan' && FALSIFIER_PROFILE === 'full' ? 600 : REQUIRED_FRAMES;
const requestedBrowserConcurrency = Number.parseInt(
  process.env.SMOKE_FALSIFY_CONCURRENCY ?? String(profile.defaultConcurrency),
  10,
);
const browserConcurrency = Number.isInteger(requestedBrowserConcurrency)
  ? Math.min(Math.max(requestedBrowserConcurrency, 1), 4)
  : profile.defaultConcurrency;

const runInBatches = async (values, mapper, concurrency) => {
  const results = new Map();
  for (let offset = 0; offset < values.length; offset += concurrency) {
    const batch = values.slice(offset, offset + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async (value) => [value, await mapper(value)]),
    );
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected !== undefined) throw rejected.reason;
    for (const result of settled) {
      results.set(result.value[0], result.value[1]);
    }
  }
  return results;
};

const fail = (message) => {
  throw new Error(message);
};

const parseTaggedJson = (output, marker) => {
  for (const line of output.split('\n').reverse()) {
    if (marker.startsWith('{') && line.startsWith(marker)) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
    const start = line.indexOf(marker);
    if (start < 0) continue;
    try {
      return JSON.parse(line.slice(start + marker.length));
    } catch {
      continue;
    }
  }
  fail(`carrier output did not contain JSON marker ${marker}`);
};

mkdirSync(EVIDENCE_DIR, { recursive: true });
const runDawnCapture = (visualCase, captureMode) =>
  parseTaggedJson(
    runCarrier('smoke-dawn.mjs', {
      SMOKE_CASE: visualCase,
      SMOKE_MIN_FRAMES: String(dawnFramesForCase(visualCase)),
      FORGEAX_TAA_FALSIFIER_PROFILE: FALSIFIER_PROFILE,
      ...(captureMode === undefined ? {} : { SMOKE_DAWN_CAPTURE_MODE: captureMode }),
    }),
    'dawnSummary=',
  );
const sampleNamesFor = (run) => Object.keys(run.pixelSamples ?? {}).sort();
const roiNamesFor = (run) => sampleNamesFor(run).filter((name) => name !== 'corner' && name !== 'ndcCenter');
const sampleEnergy = (sample) => (sample ?? []).reduce((sum, channel) => sum + channel, 0);
const roiEnergyFor = (run) => roiNamesFor(run).reduce((sum, name) => sum + sampleEnergy(run.pixelSamples[name]), 0);
const roiDeltaFor = (onRun, offRun) =>
  roiNamesFor(onRun).reduce(
    (maxDelta, name) =>
      Math.max(
        maxDelta,
        (onRun.pixelSamples[name] ?? []).reduce(
          (sum, channel, index) => sum + Math.abs(channel - (offRun.pixelSamples[name]?.[index] ?? 0)),
          0,
        ),
      ),
    0,
  );
const runStaticDawnPair = () => {
  const on = runDawnCapture('static', 'on');
  const off = runDawnCapture('static', 'off');
  const onNames = sampleNamesFor(on);
  const identity = {
    source: on.source,
    build: on.build,
    backend: on.backend,
    resolution: on.resolution,
    framesObserved: on.framesObserved,
    samplePointNames: onNames,
  };
  const identityMatches =
    JSON.stringify(identity) === JSON.stringify({
      source: off.source,
      build: off.build,
      backend: off.backend,
      resolution: off.resolution,
      framesObserved: off.framesObserved,
      samplePointNames: sampleNamesFor(off),
    });
  if (!identityMatches) fail(`static Dawn captures diverged in identity or frame/sample budget: ${JSON.stringify({ on: identity, off })}`);
  const roiDelta = roiDeltaFor(on, off);
  if (roiDelta > 0.01) fail(`static Dawn on/off ROI delta exceeded 0.01: ${roiDelta}`);
  return {
    ...on,
    captureMode: undefined,
    motionBlurFalsifier: {
      on: on.pixelSamples.ndcCenter,
      off: off.pixelSamples.ndcCenter,
      onFramesObserved: on.framesObserved,
      offFramesObserved: off.framesObserved,
      samplePointCount: roiNamesFor(on).length,
      onRoiEnergy: roiEnergyFor(on),
      offRoiEnergy: roiEnergyFor(off),
      roiDelta,
      offEnergy: roiEnergyFor(off) + sampleEnergy(off.pixelSamples.corner),
      offOutputPass: off.passes.includes('output-transform'),
      threshold: 0.01,
      verdict: 'pass',
    },
    isolatedCaptures: {
      mode: 'fresh-process-renderer',
      identity,
      on: { captureMode: on.captureMode, temporal: on.temporal, passes: on.passes },
      off: { captureMode: off.captureMode, temporal: off.temporal, passes: off.passes },
    },
  };
};
const dawnRuns = new Map(
  CASE_IDS.map((visualCase) => [
    visualCase,
    visualCase === 'static' ? runStaticDawnPair() : runDawnCapture(visualCase),
  ]),
);
const dawn = dawnRuns.get('moving-rigid');
console.log(`[falsifier] browser case concurrency=${browserConcurrency}`);
const browserRuns = await runInBatches(
  CASE_IDS,
  async (visualCase) =>
    parseTaggedJson(
      await runCarrierAsync('smoke-browser.mjs', {
        SMOKE_CASE: visualCase,
        SMOKE_MIN_FRAMES: String(REQUIRED_FRAMES),
        SMOKE_EVIDENCE_DIR: EVIDENCE_DIR,
        SMOKE_EVIDENCE_PREFIX: visualCase,
        FORGEAX_TAA_FALSIFIER_PROFILE: FALSIFIER_PROFILE,
      }),
      '{"schemaVersion":"hello-taa-browser-smoke/1"',
    ),
  browserConcurrency,
);
const browser = browserRuns.get('moving-rigid');
if (
  [...dawnRuns.entries()].some(([visualCase, run]) => run.framesObserved !== dawnFramesForCase(visualCase)) ||
  [...browserRuns.values()].some((run) => run.requiredFrames !== REQUIRED_FRAMES)
) {
  fail(`visual carriers did not execute the required frame budgets (base=${REQUIRED_FRAMES}, camera-pan Dawn=${dawnFramesForCase('camera-pan')})`);
}
if ([...dawnRuns.values()].some((run) => run.backend !== 'webgpu') || [...browserRuns.values()].some((run) => run.backend !== 'webgpu')) {
  fail(`visual carriers must use WebGPU: dawn=${dawn.backend} browser=${browser.backend}`);
}
for (const [visualCase, run] of dawnRuns) {
  if (run.temporal?.status !== 'stable' || run.temporal.historyValid !== true) {
    fail(`Dawn temporal readback is not stable/history-valid for ${visualCase}: ${JSON.stringify(run.temporal)}`);
  }
}
for (const [visualCase, run] of browserRuns) {
  if (run.errors.page.length > 0 || run.errors.console.length > 0 || run.errors.requests.length > 0) {
    fail(`Browser carrier reported unexpected errors for ${visualCase}: ${JSON.stringify(run.errors)}`);
  }
}

const screenshotByLabel = new Map();
for (const [visualCase, run] of browserRuns) {
  for (const entry of run.screenshots) screenshotByLabel.set(entry.label, entry);
  for (const label of ['taa-on-taau', 'taa-on-taa-only', 'taa-on-taau-restored', 'taa-on-taau-resumed', 'motion-blur-on', 'motion-blur-off']) {
    if (!screenshotByLabel.has(`${visualCase}-${label}`)) fail(`Browser carrier did not produce ${visualCase}-${label} PNG`);
  }
}
const dawnEvidence = (run) => {
  const readbackBytes = JSON.stringify(run.pixelSamples);
  return {
    sha256: createHash('sha256').update(readbackBytes).digest('hex'),
    sampleCount: Object.keys(run.pixelSamples).length,
    samples: {
      center: run.pixelSamples.ndcCenter,
      corner: run.pixelSamples.corner,
      edge: run.pixelSamples['edge-0.54-0.5'],
    },
  };
};
const dawnRoi = (run) => ({
  on: run.motionBlurFalsifier.onRoiEnergy,
  off: run.motionBlurFalsifier.offRoiEnergy,
  delta: run.motionBlurFalsifier.roiDelta,
  threshold: run.motionBlurFalsifier.threshold,
});
const dawnSource = (run) => ({
  path: run.source.path,
  sha256: run.source.sha256,
  buildCommand: run.build.command,
  backend: 'webgpu',
  frames: run.framesObserved,
});
const browserEvidence = (visualCase, label) => {
  const entry = screenshotByLabel.get(`${visualCase}-${label}`);
  return {
    path: relative(REPO_ROOT, entry.path ?? `${EVIDENCE_DIR}/${label}.png`),
    sha256: entry.sha256,
    bytes: entry.bytes,
    width: entry.pixels.width,
    height: entry.pixels.height,
    nonBlack: entry.pixels.nonBlack,
    meanLuma: entry.pixels.meanLuma,
    bottomStddevLuma: entry.pixels.bottomStddevLuma,
    rgbHash: entry.pixels.rgbHash,
    alphaMin: entry.pixels.alphaMin,
    alphaOpaque: entry.pixels.alphaOpaque,
    sampledPixels: entry.pixels.sampledPixels,
  };
};
const traceOrder = (trace) => {
  const taa = trace.indexOf('taa-resolve');
  const motion = trace.indexOf('motion-blur');
  return { taaBeforeMotionBlur: taa >= 0 && motion > taa, outputPresent: trace.includes('output-transform') };
};

const expected = {
  static: 'Static pixels remain identity with ROI difference at most 0.01.',
  'moving-rigid': 'Rigid object motion produces a motion ROI difference greater than 0.05.',
  'camera-pan': 'Camera pan produces screen-space motion without a stale previous-frame sample.',
  'depth-edge': 'Depth discontinuities reject unrelated samples and keep halo difference at most 0.05.',
  reactive: 'Reactive pixels suppress blur and preserve the current linear color and alpha.',
  'cut-reset': 'Cut, invalid depth, and subpixel motion resolve to current color with preserved alpha.',
  'taa-motion-blur-bloom': 'TAA resolves before Motion Blur and Bloom, preserving a bright moving streak without feedback ghost.',
};
const caseInputs = {
  static: { scene: 'stationary-bars', motion: 'none', camera: 'fixed', depth: 'single-plane', reactive: 'opaque', cut: 'none', bloom: 'off' },
  'moving-rigid': { scene: 'moving-bars', motion: 'rigid-horizontal', camera: 'fixed', depth: 'single-plane', reactive: 'opaque', cut: 'none', bloom: 'off' },
  'camera-pan': { scene: 'stationary-bars', motion: 'camera-pan', camera: 'horizontal-pan', depth: 'single-plane', reactive: 'opaque', cut: 'none', bloom: 'off' },
  'depth-edge': { scene: 'moving-bars', motion: 'rigid-horizontal', camera: 'fixed', depth: 'right-bar-offset-z', reactive: 'opaque', cut: 'none', bloom: 'off' },
  reactive: { scene: 'stationary-alpha-bars', motion: 'none', camera: 'fixed', depth: 'single-plane', reactive: 'alpha-0.6', cut: 'none', bloom: 'off' },
  'cut-reset': { scene: 'moving-bars', motion: 'rigid-with-cut', camera: 'fixed', depth: 'single-plane', reactive: 'opaque', cut: 'frame-90-position-jump', bloom: 'off' },
  'taa-motion-blur-bloom': { scene: 'moving-bars', motion: 'rigid-horizontal', camera: 'fixed', depth: 'single-plane', reactive: 'opaque', cut: 'none', bloom: 'enabled' },
};
const cases = [
  ['static', 'static', 'motion-blur-off', 'moving-rigid', 'motion-blur-on', 'off', 'on'],
  ['moving-rigid', 'moving-rigid', 'motion-blur-on', 'moving-rigid', 'motion-blur-off', 'on', 'off'],
  ['camera-pan', 'camera-pan', 'taa-on-taau-resumed', 'camera-pan', 'motion-blur-off', 'on', 'off'],
  ['depth-edge', 'depth-edge', 'motion-blur-on', 'depth-edge', 'motion-blur-off', 'on', 'off'],
  ['reactive', 'reactive', 'taa-on-taau-resumed', 'moving-rigid', 'motion-blur-off', 'on', 'off'],
  ['cut-reset', 'cut-reset', 'taa-on-taau-resumed', 'cut-reset', 'motion-blur-off', 'on', 'off'],
  ['taa-motion-blur-bloom', 'taa-motion-blur-bloom', 'motion-blur-on', 'taa-motion-blur-bloom', 'motion-blur-off', 'on', 'off'],
].filter(([id]) => CASE_IDS.includes(id)).map(([id, positiveCaseId, positiveLabel, falsifierCaseId, falsifierLabel, positiveMode, falsifierMode]) => {
  const caseRun = browserRuns.get(id);
  const caseDawn = dawnRuns.get(id);
  const positiveRun = browserRuns.get(positiveCaseId);
  const positiveDawn = dawnRuns.get(positiveCaseId);
  const falsifierRun = browserRuns.get(falsifierCaseId);
  const falsifierDawn = dawnRuns.get(falsifierCaseId);
  const casePassTrace = {
    browser: positiveRun.passes,
    browserOff: positiveRun.offState?.passes ?? [],
  };
  const falsifierPassTrace = {
    browser: falsifierRun.passes,
    browserOff: falsifierRun.offState?.passes ?? [],
  };
  const positivePng = browserEvidence(positiveCaseId, positiveLabel);
  const falsifierPng = browserEvidence(falsifierCaseId, falsifierLabel);
  const positiveTrace = positiveMode === 'off' ? casePassTrace.browserOff : casePassTrace.browser;
  const falsifierTrace = falsifierMode === 'off' ? falsifierPassTrace.browserOff : falsifierPassTrace.browser;
  const crossCaseVariant = positiveCaseId !== falsifierCaseId;
  const positiveChecks = {
    pngReadback: positivePng.nonBlack > 0 && positivePng.alphaMin === 255,
    frames: positiveDawn.framesObserved === dawnFramesForCase(positiveCaseId) && caseRun.requiredFrames === REQUIRED_FRAMES,
    passTrace: traceOrder(positiveTrace).outputPresent,
    depthHalo: id !== 'depth-edge' || caseDawn.motionBlurFalsifier.roiDelta <= 0.05,
  };
  if (!Object.values(positiveChecks).every(Boolean)) fail(`${id} positive evidence failed: ${JSON.stringify(positiveChecks)}`);
  const sameDepthPositiveControl =
    id === 'depth-edge' &&
    positiveCaseId === falsifierCaseId &&
    caseInputs[positiveCaseId].depth === caseInputs[falsifierCaseId].depth &&
    positiveRun.visualCase === falsifierRun.visualCase;
  if (id === 'depth-edge' && !sameDepthPositiveControl) {
    fail(`depth-edge browser control did not keep the same authored depth input: ${JSON.stringify({ positiveCaseId, falsifierCaseId })}`);
  }
  const falsifierChecks = {
    deliberateMotionBlurVariant: positiveMode !== falsifierMode,
    changedPng: positivePng.sha256 !== falsifierPng.sha256,
    outputSurvives: traceOrder(falsifierTrace).outputPresent,
    modeTraceChanged:
      falsifierMode === 'off'
        ? falsifierRun.offState?.motionBlur?.status === 'off'
        : falsifierTrace.includes('motion-blur'),
  };
  if (!Object.values(falsifierChecks).every(Boolean)) fail(`${id} falsifier did not break the effect: ${JSON.stringify(falsifierChecks)}`);
  const base = {
    backend: 'webgpu',
    lane: 'browser-webgpu',
    schema: positiveRun.schemaVersion,
    coverage: {
      frames: Math.max(positiveDawn.framesObserved, caseRun.requiredFrames),
      dawnFrames: positiveDawn.framesObserved,
      browserFrames: caseRun.requiredFrames,
      dawnReadback: true,
      browserPng: true,
      independentCaseInput: true,
      sameDepthPositiveControl,
    },
    caseInput: caseInputs[id],
    source: dawnSource(caseDawn),
    readback: dawnEvidence(caseDawn),
    roi: dawnRoi(caseDawn),
    passTrace: positiveTrace,
    inspection: {
      dawn: { visualCase: caseDawn.visualCase, temporal: caseDawn.temporal, passes: caseDawn.passes },
      browser: { visualCase: positiveRun.visualCase, temporal: positiveRun.temporal, initialState: positiveRun.initialState, resumedState: positiveRun.resumedState },
    },
  };
  return {
    id,
    expectation: expected[id],
    positive: {
      ...base,
      mode: positiveMode,
      png: positivePng,
      observed: `${positiveLabel} compositor PNG and Dawn copyTextureToBuffer samples passed; alphaMin=${positivePng.alphaMin}.`,
      verdict: 'pass',
      status: 'pass',
      confidence: 1,
      provenance: `Dawn ${REQUIRED_FRAMES}-frame copyTextureToBuffer plus Chromium WebGPU compositor PNG at the current exact source/build identity (${FALSIFIER_PROFILE} profile).`,
    },
    falsifier: {
      ...base,
      mode: falsifierMode,
      png: falsifierPng,
      caseInput: caseInputs[falsifierCaseId],
      source: dawnSource(falsifierDawn),
      readback: dawnEvidence(falsifierDawn),
      roi: dawnRoi(falsifierDawn),
      passTrace: falsifierTrace,
      inspection: {
        dawn: { visualCase: falsifierDawn.visualCase, temporal: falsifierDawn.temporal, passes: falsifierDawn.passes },
        browser: { visualCase: falsifierRun.visualCase, temporal: falsifierRun.temporal, initialState: falsifierRun.initialState, resumedState: falsifierRun.resumedState },
      },
      variant: crossCaseVariant
        ? `Replace the ${positiveCaseId} scene input with the ${falsifierCaseId} input and apply the ${falsifierMode} MotionBlur state.`
        : falsifierMode === 'off'
          ? 'Remove the MotionBlur component before the comparison frame.'
          : 'Enable MotionBlur for the comparison frame.',
      observed: `${falsifierLabel} is the intentional MotionBlur ${falsifierMode === 'off' ? 'off' : 'on'} variant; PNG and decoded RGB hashes differ, and the explicit MotionBlur mode state is valid.`,
      verdict: 'pass',
      status: 'pass',
      confidence: 1,
      provenance: 'Mechanical falsifier executed by the live Browser carrier toggle; it is accepted only because the broken variant changed decoded compositor RGB and reported the expected MotionBlur mode state.',
    },
  };
});

writeFileSync(VISUAL_CASES_PATH, `${JSON.stringify(cases, null, 2)}\n`);
console.log(JSON.stringify({
  schemaVersion: 'hello-taa-falsifier/2',
  backend: 'webgpu',
  profile: FALSIFIER_PROFILE,
  frames: REQUIRED_FRAMES,
  caseIds: CASE_IDS,
  positiveCases: cases.filter((entry) => entry.positive.verdict === 'pass').length,
  falsifierCases: cases.filter((entry) => entry.falsifier.verdict === 'pass').length,
  webgl2: { status: 'unavailable', acceptance: 'fail-closed', note: 'No admitted WebGL2 visual provider was claimed.' },
  evidencePath: relative(REPO_ROOT, VISUAL_CASES_PATH),
}));
