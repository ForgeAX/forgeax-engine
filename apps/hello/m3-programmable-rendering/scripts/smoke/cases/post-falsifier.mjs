import {
  compareDawnReadbacks,
  comparePngs,
  failSmoke,
  repoRoot,
  readRepeatabilitySnapshot,
  repeatabilityDiff,
  run,
} from '../lib/runtime.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const customRhiArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'custom-pipeline-rhi');

const browserRhiArgs = ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'];
const doubleResizeHistory = '640x360>480x270>720x405>640x360>480x270>720x405>640x360';

function runBrowserRhi(label, env, artifactDir) {
  return run(label, browserRhiArgs, { ...env, FORGEAX_M3_ARTIFACT_DIR: artifactDir });
}

// One normal leg and one falsifier leg that differs only by `falsifierEnv`.
function runFalsifierPair(label, artifactRoot, env, falsifierEnv) {
  return {
    normal: runBrowserRhi(`${label} normal`, env, resolve(artifactRoot, 'normal')),
    falsifier: runBrowserRhi(`${label} falsifier`, { ...env, ...falsifierEnv }, resolve(artifactRoot, 'falsifier')),
  };
}

function readArtifactJson(artifactRoot, leg, name) {
  return JSON.parse(readFileSync(resolve(artifactRoot, leg, name), 'utf8'));
}

function readPairArtifacts(artifactRoot) {
  return {
    normalCapture: readArtifactJson(artifactRoot, 'normal', 'capture.json'),
    falsifierCapture: readArtifactJson(artifactRoot, 'falsifier', 'capture.json'),
    normalSummary: readArtifactJson(artifactRoot, 'normal', 'rhi-summary.json'),
    falsifierSummary: readArtifactJson(artifactRoot, 'falsifier', 'rhi-summary.json'),
  };
}

function passedWith(result, markers) {
  return result.status === 0 && markers.every((marker) => result.output.includes(marker));
}

// Strict equality of each named field against its expected value.
function hasFields(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function deltaUnchanged(delta) {
  return delta.changedPixels === 0 || delta.meanRgbDelta <= 0.01;
}

function comparePairPngs(label, artifactRoot) {
  try {
    return comparePngs(
      resolve(artifactRoot, 'normal', 'custom-live.png'),
      resolve(artifactRoot, 'falsifier', 'custom-live.png'),
    );
  } catch (error) {
    console.error(`[m3-programmable] ${label} PNG delta: FAIL - ${error}`);
    failSmoke();
  }
}

function comparePairDawnReadbacks(label, artifactRoot) {
  try {
    return compareDawnReadbacks(
      resolve(artifactRoot, 'normal', 'dawn-readback.rgba'),
      resolve(artifactRoot, 'normal', 'dawn-readback.json'),
      resolve(artifactRoot, 'falsifier', 'dawn-readback.rgba'),
      resolve(artifactRoot, 'falsifier', 'dawn-readback.json'),
    );
  } catch (error) {
    console.error(`[m3-programmable] ${label} Dawn delta: FAIL - ${error}`);
    failSmoke();
  }
}

function requireChangedDelta(failLabel, delta) {
  if (deltaUnchanged(delta)) {
    console.error(
      `[m3-programmable] ${failLabel}: FAIL - changedPixels=${delta.changedPixels} meanRgbDelta=${delta.meanRgbDelta.toFixed(4)}`,
    );
    failSmoke();
  }
}

function requireChangedPairPixels(label, artifactRoot) {
  const pixelDelta = comparePairPngs(label, artifactRoot);
  requireChangedDelta(`${label} PNG delta`, pixelDelta);
  const dawnDelta = comparePairDawnReadbacks(label, artifactRoot);
  requireChangedDelta(`${label} Dawn delta`, dawnDelta);
  return { pixelDelta, dawnDelta };
}

function formatPairDeltas({ pixelDelta, dawnDelta }) {
  return `changedPixels=${pixelDelta.changedPixels} changedFraction=${pixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${pixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${dawnDelta.changedPixels} dawnMeanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)} normalSha256=${dawnDelta.normalSha256} falsifierSha256=${dawnDelta.falsifierSha256}`;
}

// Two identical passes of a normal/falsifier pair; `falsifierSuffix` keeps each
// falsifier leg's historical run label.
function runRepeatPasses(label, falsifierSuffix, artifactRoot, env, falsifierEnv) {
  const runs = [];
  for (const pass of ['first', 'second']) {
    const passRoot = resolve(artifactRoot, pass);
    runs.push({
      normal: runBrowserRhi(`${label} repeat ${pass} normal`, env, resolve(passRoot, 'normal')),
      falsifier: runBrowserRhi(
        `${label} repeat ${pass} ${falsifierSuffix}`,
        { ...env, ...falsifierEnv },
        resolve(passRoot, 'falsifier'),
      ),
    });
  }
  return runs;
}

function readRepeatEvidence(artifactRoot, runs) {
  const [first, second] = ['first', 'second'].map((pass, index) => ({
    normal: { result: runs[index].normal, snapshot: readRepeatabilitySnapshot(resolve(artifactRoot, pass, 'normal')) },
    falsifier: {
      result: runs[index].falsifier,
      snapshot: readRepeatabilitySnapshot(resolve(artifactRoot, pass, 'falsifier')),
    },
  }));
  return {
    first,
    second,
    normalDiff: repeatabilityDiff(first.normal.snapshot, second.normal.snapshot),
    falsifierDiff: repeatabilityDiff(first.falsifier.snapshot, second.falsifier.snapshot),
  };
}

function runRepeatEvidence(label, falsifierSuffix, artifactRoot, env, falsifierEnv) {
  return readRepeatEvidence(artifactRoot, runRepeatPasses(label, falsifierSuffix, artifactRoot, env, falsifierEnv));
}

function passExited(pass) {
  return pass.normal.result.status === 0 && pass.falsifier.result.status === 0;
}

function snapshotsRepeat(repeat) {
  return repeat.normalDiff === undefined && repeat.falsifierDiff === undefined;
}

function secondPassRepeats(repeat) {
  return passExited(repeat.second) && snapshotsRepeat(repeat);
}

function failRepeatability(label, repeat) {
  const { first, second } = repeat;
  console.error(
    `[m3-programmable] ${label} repeatability: FAIL - ${JSON.stringify({ normalStatus: [first.normal.result.status, second.normal.result.status], falsifierStatus: [first.falsifier.result.status, second.falsifier.result.status], normalDiff: repeat.normalDiff, falsifierDiff: repeat.falsifierDiff })}`,
  );
  failSmoke();
}

function logRepeatabilityPass(label, { first }) {
  console.log(
    `[m3-programmable] ${label} repeatability: PASS normalSha256=${first.normal.snapshot.dawn.sha256} falsifierSha256=${first.falsifier.snapshot.dawn.sha256} normalPngSha256=${first.normal.snapshot.screenshotSha256} falsifierPngSha256=${first.falsifier.snapshot.screenshotSha256}`,
  );
}

function compareDoubleResizeDeltas(failLabel, artifactRoot) {
  try {
    return {
      firstPng: comparePngs(
        resolve(artifactRoot, 'first', 'normal', 'custom-live.png'),
        resolve(artifactRoot, 'first', 'falsifier', 'custom-live.png'),
      ),
      secondPng: comparePngs(
        resolve(artifactRoot, 'second', 'normal', 'custom-live.png'),
        resolve(artifactRoot, 'second', 'falsifier', 'custom-live.png'),
      ),
      firstDawn: compareDawnReadbacks(
        resolve(artifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
        resolve(artifactRoot, 'first', 'normal', 'dawn-readback.json'),
        resolve(artifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
        resolve(artifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
      ),
      secondDawn: compareDawnReadbacks(
        resolve(artifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
        resolve(artifactRoot, 'second', 'normal', 'dawn-readback.json'),
        resolve(artifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
        resolve(artifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
      ),
    };
  } catch (error) {
    console.error(`[m3-programmable] ${failLabel}: FAIL - ${error}`);
    failSmoke();
  }
}

function doubleResizeDeltasUnchanged(deltas) {
  return (
    deltaUnchanged(deltas.firstPng) ||
    deltaUnchanged(deltas.secondPng) ||
    deltaUnchanged(deltas.firstDawn) ||
    deltaUnchanged(deltas.secondDawn)
  );
}

function failDoubleResize(label, repeat, deltas) {
  const { first, second } = repeat;
  console.error(
    `[m3-programmable] ${label}: FAIL - ${JSON.stringify({ statuses: { firstNormal: first.normal.result.status, firstFalsifier: first.falsifier.result.status, secondNormal: second.normal.result.status, secondFalsifier: second.falsifier.result.status }, normalDiff: repeat.normalDiff, falsifierDiff: repeat.falsifierDiff, firstPng: deltas.firstPng, secondPng: deltas.secondPng, firstDawn: deltas.firstDawn, secondDawn: deltas.secondDawn })}`,
  );
  failSmoke();
}

function logDoubleResizePass(label, deltas) {
  console.log(
    `[m3-programmable] ${label}: PASS normalSha256=${deltas.firstDawn.normalSha256} falsifierSha256=${deltas.firstDawn.falsifierSha256} dawnChangedPixels=${deltas.firstDawn.changedPixels} pngChangedPixels=${deltas.firstPng.changedPixels}`,
  );
}

const msaaRhiMarkers = ['antialias=M3_ANTIALIAS=msaa', 'msaaTextureResourceCount=2', 'resolveTargetCount=1'];
const falsifyResolveMarkers = ['[m3-browser-rhi] PASS_FALSIFY', 'resolveTargetCount=1'];

function runMsaaInversionPostCase() {
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-postfx-falsifier');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'inversion', FORGEAX_M3_VARIANT: 'true', FORGEAX_M3_SWITCH_VARIANT: '1' };
  const legs = runFalsifierPair('custom pipeline MSAA inversion post', artifactRoot, env, { FORGEAX_M3_FALSIFY: '1' });
  const artifacts = readPairArtifacts(artifactRoot);
  if (
    !passedWith(legs.normal, ['post=M3_POST_EFFECT=inversion', ...msaaRhiMarkers, 'draws=3', 'variantSwitch=true']) ||
    !passedWith(legs.falsifier, ['post=M3_POST_EFFECT=inversion', ...msaaRhiMarkers, 'draws=2']) ||
    !hasFields(artifacts.normalCapture, { post: 'M3_POST_EFFECT=inversion', falsifyPipeline: false }) ||
    !hasFields(artifacts.falsifierCapture, { post: 'M3_POST_EFFECT=inversion', falsifyPipeline: true }) ||
    !hasFields(artifacts.normalSummary, { resolveTargetCount: 1, drawCount: 3 }) ||
    !hasFields(artifacts.falsifierSummary, { resolveTargetCount: 1, drawCount: 2 })
  ) {
    console.error('[m3-programmable] custom pipeline MSAA inversion post: FAIL - non-default post effect did not preserve the adjacent-pipeline oracle');
    failSmoke();
  }
  const deltas = requireChangedPairPixels('custom pipeline MSAA inversion post', artifactRoot);
  console.log(
    `[m3-programmable] custom pipeline MSAA inversion post: PASS normalResolve=1 falsifierResolve=1 normalDraws=3 falsifierDraws=2 ${formatPairDeltas(deltas)}`,
  );
}

const livePostEnv = {
  FORGEAX_M3_MSAA: '1',
  FORGEAX_M3_POST: 'passthrough',
  FORGEAX_M3_VARIANT: 'true',
  FORGEAX_M3_SWITCH_VARIANT: '1',
  FORGEAX_M3_SWITCH_POST: '1',
};
const livePostCapture = {
  selectedPost: 'M3_POST_EFFECT=passthrough',
  post: 'M3_POST_EFFECT=inversion',
  postSwitchedAfterPipeline: true,
};
const livePostNormalMarkers = ['post=M3_POST_EFFECT=inversion', ...msaaRhiMarkers, 'draws=3', 'variantSwitch=true', 'postSwitch=true'];
const livePostPipelineFalsifierMarkers = [
  'post=M3_POST_EFFECT=inversion',
  ...msaaRhiMarkers,
  'draws=2',
  'variantSwitch=true',
  'postSwitch=true',
];

function runMsaaLivePostCase() {
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-falsifier');
  const legs = runFalsifierPair('custom pipeline MSAA live post', artifactRoot, livePostEnv, { FORGEAX_M3_FALSIFY: '1' });
  const artifacts = readPairArtifacts(artifactRoot);
  if (
    !passedWith(legs.normal, livePostNormalMarkers) ||
    !passedWith(legs.falsifier, livePostPipelineFalsifierMarkers) ||
    !hasFields(artifacts.normalCapture, livePostCapture) ||
    !hasFields(artifacts.falsifierCapture, livePostCapture) ||
    !hasFields(artifacts.normalSummary, { resolveTargetCount: 1, drawCount: 3 }) ||
    !hasFields(artifacts.falsifierSummary, { resolveTargetCount: 1, drawCount: 2 })
  ) {
    console.error('[m3-programmable] custom pipeline MSAA live post: FAIL - live post selection did not preserve the MSAA adjacent-pipeline oracle');
    failSmoke();
  }
  const deltas = requireChangedPairPixels('custom pipeline MSAA live post', artifactRoot);
  console.log(
    `[m3-programmable] custom pipeline MSAA live post: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=1 normalDraws=3 falsifierDraws=2 ${formatPairDeltas(deltas)}`,
  );
}

function runMsaaLivePostPipelineCase() {
  const label = 'custom pipeline MSAA live post adjacent pipeline';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-pipeline-falsifier');
  const legs = runFalsifierPair(label, artifactRoot, livePostEnv, { FORGEAX_M3_FALSIFY: '1' });
  const artifacts = readPairArtifacts(artifactRoot);
  if (
    !passedWith(legs.normal, livePostNormalMarkers) ||
    !passedWith(legs.falsifier, livePostPipelineFalsifierMarkers) ||
    !hasFields(artifacts.normalCapture, { ...livePostCapture, falsifyPipeline: false }) ||
    !hasFields(artifacts.falsifierCapture, { ...livePostCapture, falsifyPipeline: true }) ||
    !hasFields(artifacts.normalSummary, { resolveTargetCount: 1, drawCount: 3 }) ||
    !hasFields(artifacts.falsifierSummary, { resolveTargetCount: 1, drawCount: 2 })
  ) {
    console.error('[m3-programmable] custom pipeline MSAA live post adjacent pipeline falsifier: FAIL - live post switching did not survive the adjacent pipeline fault');
    failSmoke();
  }
  const pixelDelta = comparePairPngs(label, artifactRoot);
  requireChangedDelta(`${label} PNG delta`, pixelDelta);
  const dawnDelta = comparePairDawnReadbacks(label, artifactRoot);
  if (dawnDelta.width !== 640 || dawnDelta.height !== 360) {
    console.error(
      `[m3-programmable] custom pipeline MSAA live post adjacent pipeline Dawn readback: FAIL - dimensions=${dawnDelta.width}x${dawnDelta.height}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=1 normalDraws=3 falsifierDraws=2 ${formatPairDeltas({ pixelDelta, dawnDelta })}`,
  );
}

function runMsaaLivePostPipelineRepeatCase() {
  const label = 'custom pipeline MSAA live post adjacent pipeline';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-pipeline-repeatability');
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, livePostEnv, { FORGEAX_M3_FALSIFY: '1' });
  const { first } = repeat;
  const switchMarkers = ['msaaTextureResourceCount=2', 'resolveTargetCount=1', 'variantSwitch=true', 'postSwitch=true'];
  if (
    !passedWith(first.normal.result, ['post=M3_POST_EFFECT=inversion', ...switchMarkers, 'draws=3']) ||
    !passedWith(first.falsifier.result, ['post=M3_POST_EFFECT=inversion', ...switchMarkers, 'draws=2']) ||
    !secondPassRepeats(repeat) ||
    first.normal.snapshot.capture.falsifyPipeline !== false ||
    first.falsifier.snapshot.capture.falsifyPipeline !== true
  ) {
    failRepeatability(label, repeat);
  }
  logRepeatabilityPass(label, repeat);
}

const resolveFalsifierEnv = { FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1' };

function runMsaaLivePostResolveCase() {
  const label = 'custom pipeline MSAA live post resolve';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-resolve-falsifier');
  const legs = runFalsifierPair(label, artifactRoot, livePostEnv, resolveFalsifierEnv);
  const artifacts = readPairArtifacts(artifactRoot);
  if (
    !passedWith(legs.normal, livePostNormalMarkers) ||
    !passedWith(legs.falsifier, [...falsifyResolveMarkers, 'dawnReadbackSha256=']) ||
    !hasFields(artifacts.normalCapture, livePostCapture) ||
    !hasFields(artifacts.falsifierCapture, livePostCapture) ||
    !hasFields(artifacts.normalSummary, { resolveTargetCount: 1, drawCount: 3 }) ||
    !hasFields(artifacts.falsifierSummary, { resolveTargetCount: 1, drawCount: 3 })
  ) {
    console.error('[m3-programmable] custom pipeline MSAA live post resolve falsifier: FAIL - post switch did not survive the no-resolve topology falsifier');
    failSmoke();
  }
  const deltas = requireChangedPairPixels(label, artifactRoot);
  console.log(
    `[m3-programmable] custom pipeline MSAA live post resolve falsifier: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 ${formatPairDeltas(deltas)}`,
  );
}

const msaaRepeatRhi = { msaaTextureResourceCount: 2, resolveTargetCount: 1, drawCount: 3 };

function runMsaaLivePostResolveRepeatCase() {
  const label = 'custom pipeline MSAA live post resolve';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-resolve-repeatability');
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, livePostEnv, resolveFalsifierEnv);
  const { first } = repeat;
  const capture = {
    selectedVariant: 'true',
    selectedPost: 'M3_POST_EFFECT=passthrough',
    variantSwitchedAfterPipeline: true,
    postSwitchedAfterPipeline: true,
  };
  if (
    !passedWith(first.normal.result, livePostNormalMarkers) ||
    !passedWith(first.falsifier.result, falsifyResolveMarkers) ||
    !secondPassRepeats(repeat) ||
    !hasFields(first.normal.snapshot.capture, capture) ||
    !hasFields(first.falsifier.snapshot.capture, capture) ||
    !hasFields(first.normal.snapshot.rhi, msaaRepeatRhi) ||
    !hasFields(first.falsifier.snapshot.rhi, msaaRepeatRhi)
  ) {
    failRepeatability(label, repeat);
  }
  logRepeatabilityPass(label, repeat);
}

const doubleResizeChurnEnv = { FORGEAX_M3_RESIZE_CHURN: '1', FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1' };

function runMsaaLivePostDoubleResizeRepeatCase() {
  const reportLabel = 'MSAA live post double resize repeatability';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-double-resize-repeatability');
  const repeat = runRepeatEvidence(
    'custom pipeline MSAA live post double resize',
    'falsifier',
    artifactRoot,
    { ...livePostEnv, ...doubleResizeChurnEnv },
    resolveFalsifierEnv,
  );
  const deltas = compareDoubleResizeDeltas(`${reportLabel} delta`, artifactRoot);
  const normal = repeat.first.normal.snapshot;
  const falsifier = repeat.first.falsifier.snapshot;
  const capture = {
    post: 'M3_POST_EFFECT=inversion',
    antialias: 'M3_ANTIALIAS=msaa',
    variantSwitchedAfterPipeline: true,
    postSwitchedAfterPipeline: true,
  };
  if (
    !passExited(repeat.first) ||
    !passExited(repeat.second) ||
    !hasFields(normal.capture, capture) ||
    normal.capture.resizeHistory.join('>') !== doubleResizeHistory ||
    !hasFields(normal.rhi, msaaRepeatRhi) ||
    !hasFields(falsifier.capture, capture) ||
    falsifier.capture.resizeHistory.join('>') !== doubleResizeHistory ||
    !hasFields(falsifier.rhi, msaaRepeatRhi) ||
    !snapshotsRepeat(repeat) ||
    doubleResizeDeltasUnchanged(deltas)
  ) {
    failDoubleResize(reportLabel, repeat, deltas);
  }
  logDoubleResizePass(reportLabel, deltas);
}

const liveVariantSwitchNormalMarkers = [
  ...msaaRhiMarkers,
  'draws=3',
  'variantSwitch=true',
  'postSwitch=false',
];

function liveVariantRepeatHolds(repeat, selectedPost, extraCapture) {
  const { first } = repeat;
  const capture = {
    selectedVariant: 'false',
    selectedPost,
    variantSwitchedAfterPipeline: true,
    postSwitchedAfterPipeline: false,
    ...extraCapture,
  };
  return (
    passedWith(first.normal.result, [
      'variant=M3_MULTI_UV_VARIANT=true',
      `post=${selectedPost}`,
      ...liveVariantSwitchNormalMarkers,
    ]) &&
    passedWith(first.falsifier.result, falsifyResolveMarkers) &&
    secondPassRepeats(repeat) &&
    hasFields(first.normal.snapshot.capture, capture) &&
    hasFields(first.falsifier.snapshot.capture, capture) &&
    hasFields(first.normal.snapshot.rhi, msaaRepeatRhi) &&
    hasFields(first.falsifier.snapshot.rhi, msaaRepeatRhi)
  );
}

function runMsaaLiveVariantRepeatCase() {
  const label = 'custom pipeline MSAA live variant';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-variant-repeatability');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'passthrough', FORGEAX_M3_VARIANT: 'false', FORGEAX_M3_SWITCH_VARIANT: '1' };
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, env, resolveFalsifierEnv);
  if (!liveVariantRepeatHolds(repeat, 'M3_POST_EFFECT=passthrough', {})) failRepeatability(label, repeat);
  logRepeatabilityPass(label, repeat);
}

function runMsaaLiveVariantInversionRepeatCase() {
  const label = 'custom pipeline MSAA live variant inversion';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-variant-inversion-repeatability');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'inversion', FORGEAX_M3_VARIANT: 'false', FORGEAX_M3_SWITCH_VARIANT: '1' };
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, env, resolveFalsifierEnv);
  if (!liveVariantRepeatHolds(repeat, 'M3_POST_EFFECT=inversion', { falsifyPipeline: false })) {
    failRepeatability(label, repeat);
  }
  logRepeatabilityPass(label, repeat);
}

const noMsaaRhiMarkers = ['antialias=M3_ANTIALIAS=none', 'msaaTextureResourceCount=0', 'resolveTargetCount=0'];

function runNoMsaaLiveVariantInversionPipelineRepeatCase() {
  const label = 'custom pipeline no-MSAA live variant inversion adjacent pipeline';
  const artifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-variant-inversion-pipeline-repeatability');
  const env = { FORGEAX_M3_MSAA: '0', FORGEAX_M3_POST: 'inversion', FORGEAX_M3_VARIANT: 'false', FORGEAX_M3_SWITCH_VARIANT: '1' };
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, env, { FORGEAX_M3_FALSIFY: '1' });
  const { first } = repeat;
  const variantMarkers = ['variant=M3_MULTI_UV_VARIANT=true', 'post=M3_POST_EFFECT=inversion', ...noMsaaRhiMarkers];
  const capture = {
    selectedVariant: 'false',
    selectedPost: 'M3_POST_EFFECT=inversion',
    variantSwitchedAfterPipeline: true,
    postSwitchedAfterPipeline: false,
  };
  if (
    !passedWith(first.normal.result, [...variantMarkers, 'draws=3', 'variantSwitch=true', 'postSwitch=false']) ||
    !passedWith(first.falsifier.result, [
      '[m3-browser-rhi] PASS -',
      ...variantMarkers,
      'draws=2',
      'variantSwitch=true',
      'postSwitch=false',
    ]) ||
    !secondPassRepeats(repeat) ||
    !hasFields(first.normal.snapshot.capture, { ...capture, falsifyPipeline: false }) ||
    !hasFields(first.falsifier.snapshot.capture, { ...capture, falsifyPipeline: true }) ||
    !hasFields(first.normal.snapshot.rhi, { msaaTextureResourceCount: 0, resolveTargetCount: 0, drawCount: 3 }) ||
    !hasFields(first.falsifier.snapshot.rhi, { msaaTextureResourceCount: 0, resolveTargetCount: 0, drawCount: 2 })
  ) {
    failRepeatability(label, repeat);
  }
  logRepeatabilityPass(label, repeat);
}

function steadyCapture(selectedVariant) {
  return {
    falsifyPipeline: false,
    selectedVariant,
    selectedPost: 'M3_POST_EFFECT=inversion',
    variantSwitchedAfterPipeline: false,
    postSwitchedAfterPipeline: false,
  };
}

// Steady-state MSAA inversion against the no-resolve falsifier for one variant.
function steadyInversionOracleHolds(legs, artifacts, selectedVariant) {
  const capture = steadyCapture(selectedVariant);
  return (
    passedWith(legs.normal, [
      'post=M3_POST_EFFECT=inversion',
      `variant=M3_MULTI_UV_VARIANT=${selectedVariant}`,
      ...msaaRhiMarkers,
      'draws=3',
      'variantSwitch=false',
      'postSwitch=false',
    ]) &&
    passedWith(legs.falsifier, falsifyResolveMarkers) &&
    hasFields(artifacts.normalCapture, capture) &&
    hasFields(artifacts.falsifierCapture, capture) &&
    hasFields(artifacts.normalSummary, { resolveTargetCount: 1, drawCount: 3 }) &&
    hasFields(artifacts.falsifierSummary, { resolveTargetCount: 1, drawCount: 3 })
  );
}

function runMsaaSteadyInversionCase() {
  const label = 'custom pipeline MSAA steady inversion';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-inversion');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'inversion', FORGEAX_M3_VARIANT: 'false' };
  const legs = runFalsifierPair(label, artifactRoot, env, resolveFalsifierEnv);
  if (!steadyInversionOracleHolds(legs, readPairArtifacts(artifactRoot), 'false')) {
    console.error('[m3-programmable] custom pipeline MSAA steady inversion: FAIL - steady-state variant/post or no-resolve evidence did not pass');
    failSmoke();
  }
  const deltas = requireChangedPairPixels(label, artifactRoot);
  console.log(
    `[m3-programmable] custom pipeline MSAA steady inversion: PASS normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 ${formatPairDeltas(deltas)}`,
  );
}

function runMsaaSteadyTrueInversionCase() {
  const label = 'custom pipeline MSAA steady true inversion';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-inversion');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'inversion', FORGEAX_M3_VARIANT: 'true' };
  const legs = runFalsifierPair(label, artifactRoot, env, resolveFalsifierEnv);
  if (!steadyInversionOracleHolds(legs, readPairArtifacts(artifactRoot), 'true')) {
    console.error('[m3-programmable] custom pipeline MSAA steady true inversion: FAIL - steady-state true variant/post or no-resolve evidence did not pass');
    failSmoke();
  }
  const deltas = requireChangedPairPixels(label, artifactRoot);
  console.log(
    `[m3-programmable] custom pipeline MSAA steady true inversion: PASS normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 ${formatPairDeltas(deltas)}`,
  );
}

// Steady-state MSAA repeatability for one variant/post selection; `switchMarkers`
// are the extra switch markers the normal leg must print.
function steadyRepeatHolds(repeat, selectedVariant, selectedPost, switchMarkers) {
  const { first } = repeat;
  const capture = {
    selectedVariant,
    selectedPost,
    variantSwitchedAfterPipeline: false,
    postSwitchedAfterPipeline: false,
    falsifyPipeline: false,
  };
  const rhi = { resolveTargetCount: 1, drawCount: 3 };
  return (
    passedWith(first.normal.result, [
      `variant=M3_MULTI_UV_VARIANT=${selectedVariant}`,
      `post=${selectedPost}`,
      'msaaTextureResourceCount=2',
      'resolveTargetCount=1',
      'draws=3',
      ...switchMarkers,
    ]) &&
    passedWith(first.falsifier.result, falsifyResolveMarkers) &&
    secondPassRepeats(repeat) &&
    hasFields(first.normal.snapshot.capture, capture) &&
    hasFields(first.falsifier.snapshot.capture, capture) &&
    hasFields(first.normal.snapshot.rhi, rhi) &&
    hasFields(first.falsifier.snapshot.rhi, rhi)
  );
}

const steadySwitchMarkers = ['variantSwitch=false', 'postSwitch=false'];

function runMsaaSteadyTrueInversionRepeatCase() {
  const label = 'custom pipeline MSAA steady true inversion';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-inversion-repeatability');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'inversion', FORGEAX_M3_VARIANT: 'true' };
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, env, resolveFalsifierEnv);
  if (!steadyRepeatHolds(repeat, 'true', 'M3_POST_EFFECT=inversion', [])) failRepeatability(label, repeat);
  logRepeatabilityPass(label, repeat);
}

function runMsaaSteadyTruePassthroughRepeatCase() {
  const label = 'custom pipeline MSAA steady true passthrough';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-passthrough-repeatability');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'passthrough', FORGEAX_M3_VARIANT: 'true' };
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, env, resolveFalsifierEnv);
  if (!steadyRepeatHolds(repeat, 'true', 'M3_POST_EFFECT=passthrough', steadySwitchMarkers)) {
    failRepeatability(label, repeat);
  }
  logRepeatabilityPass(label, repeat);
}

function runMsaaSteadyFalsePassthroughRepeatCase() {
  const label = 'custom pipeline MSAA steady false passthrough';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-false-passthrough-repeatability');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'passthrough', FORGEAX_M3_VARIANT: 'false' };
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, env, resolveFalsifierEnv);
  if (!steadyRepeatHolds(repeat, 'false', 'M3_POST_EFFECT=passthrough', steadySwitchMarkers)) {
    failRepeatability(label, repeat);
  }
  logRepeatabilityPass(label, repeat);
}

function runMsaaSteadyFalseInversionRepeatCase() {
  const label = 'custom pipeline MSAA steady false inversion';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-false-inversion-repeatability');
  const env = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_POST: 'inversion', FORGEAX_M3_VARIANT: 'false' };
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, env, resolveFalsifierEnv);
  if (!steadyRepeatHolds(repeat, 'false', 'M3_POST_EFFECT=inversion', [])) failRepeatability(label, repeat);
  logRepeatabilityPass(label, repeat);
}

const noMsaaLivePostEnv = { ...livePostEnv, FORGEAX_M3_MSAA: '0' };

function runNoMsaaLivePostResolveRepeatCase() {
  const label = 'custom pipeline no-MSAA live post resolve';
  const artifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-post-resolve-repeatability');
  const repeat = runRepeatEvidence(label, 'falsifier', artifactRoot, noMsaaLivePostEnv, resolveFalsifierEnv);
  const { first } = repeat;
  const markers = [...noMsaaRhiMarkers, 'draws=3', 'variantSwitch=true', 'postSwitch=true'];
  const capture = {
    selectedVariant: 'true',
    selectedPost: 'M3_POST_EFFECT=passthrough',
    variantSwitchedAfterPipeline: true,
    postSwitchedAfterPipeline: true,
  };
  const rhi = { msaaTextureResourceCount: 0, resolveTargetCount: 0, drawCount: 3 };
  if (
    !passedWith(first.normal.result, markers) ||
    !passedWith(first.falsifier.result, markers) ||
    first.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
    !secondPassRepeats(repeat) ||
    !hasFields(first.normal.snapshot.capture, capture) ||
    !hasFields(first.falsifier.snapshot.capture, capture) ||
    !hasFields(first.normal.snapshot.rhi, rhi) ||
    !hasFields(first.falsifier.snapshot.rhi, rhi)
  ) {
    failRepeatability(label, repeat);
  }
  logRepeatabilityPass(label, repeat);
}

// Double-resize churn against the adjacent-pipeline falsifier; the normal leg
// keeps three draws and the falsifier leg drops to two.
function pipelineDoubleResizeHolds(repeat, deltas, capture, rhi) {
  const normal = repeat.first.normal.snapshot;
  const falsifier = repeat.first.falsifier.snapshot;
  return (
    passExited(repeat.first) &&
    passExited(repeat.second) &&
    hasFields(normal.capture, { ...capture, falsifyPipeline: false }) &&
    normal.capture.resizeHistory.join('>') === doubleResizeHistory &&
    hasFields(normal.rhi, { ...rhi, drawCount: 3 }) &&
    hasFields(falsifier.capture, { ...capture, falsifyPipeline: true }) &&
    falsifier.capture.resizeHistory.join('>') === doubleResizeHistory &&
    hasFields(falsifier.rhi, { ...rhi, drawCount: 2 }) &&
    snapshotsRepeat(repeat) &&
    !doubleResizeDeltasUnchanged(deltas)
  );
}

const noMsaaDoubleResizeRhi = { msaaTextureResourceCount: 0, resolveTargetCount: 0 };

function runNoMsaaLivePostDoubleResizeRepeatCase() {
  const reportLabel = 'no-MSAA live post double resize repeatability';
  const artifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-post-double-resize-repeatability');
  const repeat = runRepeatEvidence(
    'custom pipeline no-MSAA live post double resize',
    'adjacent pipeline falsifier',
    artifactRoot,
    { ...noMsaaLivePostEnv, ...doubleResizeChurnEnv },
    { FORGEAX_M3_FALSIFY: '1' },
  );
  const deltas = compareDoubleResizeDeltas(`${reportLabel} delta`, artifactRoot);
  const capture = {
    post: 'M3_POST_EFFECT=inversion',
    antialias: 'M3_ANTIALIAS=none',
    selectedVariant: 'true',
    selectedPost: 'M3_POST_EFFECT=passthrough',
    variantSwitchedAfterPipeline: true,
    postSwitchedAfterPipeline: true,
  };
  if (!pipelineDoubleResizeHolds(repeat, deltas, capture, noMsaaDoubleResizeRhi)) {
    failDoubleResize(reportLabel, repeat, deltas);
  }
  logDoubleResizePass(reportLabel, deltas);
}

function falseStartDoubleResizeCapture(antialias) {
  return {
    variant: 'M3_MULTI_UV_VARIANT=true',
    post: 'M3_POST_EFFECT=inversion',
    selectedVariant: 'false',
    selectedPost: 'M3_POST_EFFECT=passthrough',
    antialias,
    variantSwitchedAfterPipeline: true,
    postSwitchedAfterPipeline: true,
  };
}

const falseStartLivePostEnv = { ...livePostEnv, FORGEAX_M3_VARIANT: 'false', ...doubleResizeChurnEnv };

function runNoMsaaFalseVariantLivePostDoubleResizeCase() {
  const reportLabel = 'no-MSAA false-variant live post double resize repeatability';
  const artifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-post-false-variant-double-resize-repeatability');
  const repeat = runRepeatEvidence(
    'custom pipeline no-MSAA false-variant live post double resize',
    'adjacent pipeline falsifier',
    artifactRoot,
    { ...falseStartLivePostEnv, FORGEAX_M3_MSAA: '0' },
    { FORGEAX_M3_FALSIFY: '1' },
  );
  const deltas = compareDoubleResizeDeltas(`${reportLabel} delta`, artifactRoot);
  const capture = falseStartDoubleResizeCapture('M3_ANTIALIAS=none');
  if (!pipelineDoubleResizeHolds(repeat, deltas, capture, noMsaaDoubleResizeRhi)) {
    failDoubleResize(reportLabel, repeat, deltas);
  }
  logDoubleResizePass(reportLabel, deltas);
}

function runMsaaFalseStartLivePostDoubleResizeCase() {
  const reportLabel = 'MSAA false-start live post double resize repeatability';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-false-start-double-resize-repeatability');
  const repeat = runRepeatEvidence(
    'custom pipeline MSAA false-start live post double resize',
    'falsifier',
    artifactRoot,
    falseStartLivePostEnv,
    resolveFalsifierEnv,
  );
  const deltas = compareDoubleResizeDeltas(`${reportLabel} delta`, artifactRoot);
  const capture = { ...falseStartDoubleResizeCapture('M3_ANTIALIAS=msaa'), falsifyPipeline: false };
  const normal = repeat.first.normal.snapshot;
  const falsifier = repeat.first.falsifier.snapshot;
  if (
    !passExited(repeat.first) ||
    !passExited(repeat.second) ||
    !hasFields(normal.capture, capture) ||
    normal.capture.resizeHistory.join('>') !== doubleResizeHistory ||
    !hasFields(normal.rhi, msaaRepeatRhi) ||
    !hasFields(falsifier.capture, capture) ||
    falsifier.capture.resizeHistory.join('>') !== doubleResizeHistory ||
    !hasFields(falsifier.rhi, msaaRepeatRhi) ||
    !snapshotsRepeat(repeat) ||
    doubleResizeDeltasUnchanged(deltas)
  ) {
    failDoubleResize(reportLabel, repeat, deltas);
  }
  logDoubleResizePass(reportLabel, deltas);
}

function runMsaaFalseStartLivePostPipelineDoubleResizeCase() {
  const reportLabel = 'MSAA false-start live post adjacent pipeline double resize repeatability';
  const artifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-false-start-pipeline-double-resize-repeatability');
  const repeat = runRepeatEvidence(
    'custom pipeline MSAA false-start live post adjacent pipeline double resize',
    'falsifier',
    artifactRoot,
    falseStartLivePostEnv,
    { FORGEAX_M3_FALSIFY: '1' },
  );
  const deltas = compareDoubleResizeDeltas(
    'MSAA false-start live post adjacent pipeline double resize delta',
    artifactRoot,
  );
  const capture = falseStartDoubleResizeCapture('M3_ANTIALIAS=msaa');
  if (!pipelineDoubleResizeHolds(repeat, deltas, capture, { msaaTextureResourceCount: 2, resolveTargetCount: 1 })) {
    failDoubleResize(reportLabel, repeat, deltas);
  }
  logDoubleResizePass(reportLabel, deltas);
}

function runLiveVariantSwitchCase() {
  const artifactRoot = resolve(customRhiArtifactRoot, 'live-variant-switch');
  const env = { FORGEAX_M3_VARIANT: 'true', FORGEAX_M3_SWITCH_VARIANT: '1' };
  const liveVariant = runBrowserRhi('custom pipeline live variant switch', env, resolve(artifactRoot, 'normal'));
  const liveVariantFalsifier = runBrowserRhi(
    'custom pipeline live variant switch falsifier',
    { ...env, FORGEAX_M3_FALSIFY: '1' },
    resolve(artifactRoot, 'falsifier'),
  );
  const customVariantMarker = 'pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false';
  if (
    !passedWith(liveVariant, [customVariantMarker, 'draws=3', 'variantSwitch=true']) ||
    !passedWith(liveVariantFalsifier, [customVariantMarker, 'draws=2', 'variantSwitch=true'])
  ) {
    console.error('[m3-programmable] custom pipeline live variant switch: FAIL - post-resize custom variant mutation did not pass');
    failSmoke();
  }
  console.log('[m3-programmable] custom pipeline live variant switch: PASS');
}

export function runPostFalsifierCases() {
  runMsaaInversionPostCase();
  runMsaaLivePostCase();
  runMsaaLivePostPipelineCase();
  runMsaaLivePostPipelineRepeatCase();
  runMsaaLivePostResolveCase();
  runMsaaLivePostResolveRepeatCase();
  runMsaaLivePostDoubleResizeRepeatCase();
  runMsaaLiveVariantRepeatCase();
  runMsaaLiveVariantInversionRepeatCase();
  runNoMsaaLiveVariantInversionPipelineRepeatCase();
  runMsaaSteadyInversionCase();
  runMsaaSteadyTrueInversionCase();
  runMsaaSteadyTrueInversionRepeatCase();
  runMsaaSteadyTruePassthroughRepeatCase();
  runMsaaSteadyFalsePassthroughRepeatCase();
  runMsaaSteadyFalseInversionRepeatCase();
  runNoMsaaLivePostResolveRepeatCase();
  runNoMsaaLivePostDoubleResizeRepeatCase();
  runNoMsaaFalseVariantLivePostDoubleResizeCase();
  runMsaaFalseStartLivePostDoubleResizeCase();
  runMsaaFalseStartLivePostPipelineDoubleResizeCase();
  runLiveVariantSwitchCase();
  console.log('[m3-programmable] PASS - M3 programmable rendering gates GREEN');
}
