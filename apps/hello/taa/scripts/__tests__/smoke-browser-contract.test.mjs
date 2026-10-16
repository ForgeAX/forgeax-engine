import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareDecodedRgb, validateMotionBlurTrace } from '../smoke-browser-observations.mjs';

const script = readFileSync(fileURLToPath(new URL('../smoke-browser.mjs', import.meta.url)), 'utf8');
const dawnScript = readFileSync(fileURLToPath(new URL('../smoke-dawn.mjs', import.meta.url)), 'utf8');
const mainScript = readFileSync(fileURLToPath(new URL('../../src/main.ts', import.meta.url)), 'utf8');

test('browser smoke keeps the 60-frame floor and bounded 180-second wait', () => {
  assert.match(script, /const FRAME_FLOOR = 60;/);
  assert.match(script, /SMOKE_BROWSER_WAIT_MS \?\? '180000'/);
  assert.match(script, /state\.workload\?\.frameIdentity\?\.count >= targetFrames/);
  assert.match(script, /frameIdentity\?\.sequenceSha256/);
  assert.match(script, /state\.workload\?\.resourceGrowth\?\.stableFrames >= targetFrames/);
});

test('browser smoke waits for the scoped Pack producer before opening the page', () => {
  assert.match(script, /const PACK_CATALOG_PATH = '\/__pack\/scopes\/hello-taa\/1\/catalog\.json';/);
  assert.match(script, /const MAX_VITE_READINESS_TIMEOUT_MS = 180_000;/);
  assert.match(script, /FORGEAX_TAA_VITE_READINESS_TIMEOUT_MS \?\? '180000'/);
  assert.match(script, /const waitForScopedPackCatalog = async \(baseUrl\)/);
  assert.match(script, /snapshot\?\.authority !== 'authoritative'/);
  assert.match(script, /await waitForScopedPackCatalog\(appUrl\);/);
});

test('feature observation uses the App browser signal instead of the Renderer event', () => {
  assert.match(mainScript, /canvas\.addEventListener\(FORGEAX_FRAME_SUBMITTED_EVENT/);
  assert.match(mainScript, /enqueueSubmittedReceipt\(detail\.receipt\)/);
  assert.doesNotMatch(mainScript, /event\.kind === 'frame-submitted'[\s\S]*observeSubmittedReceipt/);
});

test('hello-taa passes the scoped dev catalog before App assembly starts', () => {
  assert.match(mainScript, /const runtimeDevBinding = import\.meta\.env\.DEV \? runtimeBinding : undefined/);
  assert.match(mainScript, /assetRuntimeBinding: runtimeDevBinding/);
  assert.match(mainScript, /createRuntimeAssetImportTransport\(runtimeDevBinding\)/);
  assert.match(mainScript, /if \(runtimeDevBinding === undefined\) configureRuntimeAssetCatalog\(assets, runtimeBinding\);/);
  assert.doesNotMatch(mainScript, /^configureRuntimeAssetCatalog\(assets, runtimeBinding\);$/m);
});

test('feature observations use the explicit timing off state', () => {
  assert.match(mainScript, /timingMode === 'off' &&[\s\S]*workloadKind === 'auto'/);
  assert.match(mainScript, /timingMode === 'off' &&[\s\S]*finalObservationRequested/);
  assert.doesNotMatch(mainScript, /!timingMode &&[\s\S]*workloadKind === '(?:auto|positive-lut)'/);
});

test('software Browser/Dawn feature captures share one bounded extent and identity source', () => {
  assert.match(mainScript, /timingMode === 'off' && workloadKind !== 'none'/);
  assert.match(mainScript, /canvas\.width = 200/);
  assert.match(mainScript, /canvas\.height = 150/);
  assert.match(script, /initial\.observations\?\.\[0\]\?\.metadata\?\.width/);
  assert.match(script, /initial\.observations\?\.\[0\]\?\.metadata\?\.height/);
  assert.match(script, /featureCanvasExtent\.width/);
  assert.match(script, /featureCanvasExtent\.height/);
  assert.match(dawnScript, /const width = timingMode \? timingResolution\.width : performanceAdmissionMode \? 1920 : falsifierLightweight \? 128 : 200/);
  assert.match(dawnScript, /const height = timingMode \? timingResolution\.height : performanceAdmissionMode \? 1080 : falsifierLightweight \? 72 : 150/);
  assert.match(script, /FORGEAX_TAA_VITE_READINESS_TIMEOUT_MS \?\? '180000'/);
  assert.match(script, /const MAX_VITE_READINESS_TIMEOUT_MS = 180_000;/);
});

test('browser smoke exercises the TAA-only and fixed TAAU controls', () => {
  assert.match(script, /page\.locator\('#dynamic-resolution-toggle'\)\.click\(\)/);
  assert.match(script, /page\.locator\('#taa-toggle'\)\.click\(\)/);
  assert.match(script, /captureLabel\('taa-on-taa-only'\)/);
  assert.match(script, /captureLabel\('taa-on-taau-restored'\)/);
  assert.match(script, /taaResolutionComparison: \{/);
  assert.match(script, /toggleTrace: \{/);
  assert.match(mainScript, /const dynamicResolutionToggle = document\.querySelector/);
  assert.match(mainScript, /const taaToggle = document\.querySelector/);
});

test('CI falsifier browser carrier lowers its viewport and opts into the app profile', () => {
  assert.match(script, /FORGEAX_TAA_FALSIFIER_PROFILE === 'ci'/);
  assert.match(script, /const viewport = falsifierLightweight \? \{ width: 320, height: 180 \}/);
  assert.match(script, /taa-profile=ci/);
  assert.match(script, /requiredFrames}-frame inspection/);
  assert.match(mainScript, /taa-profile/);
  assert.match(mainScript, /canvas\.width = 256/);
  assert.match(mainScript, /canvas\.height = 144/);
  assert.match(mainScript, /castShadow: true/);
  assert.match(mainScript, /cascadeCount: 1, mapSize: 64/);
  assert.match(mainScript, /sampleCount: lightweightSmoke \? 4 : 12/);
});

test('camera-pan requires a real on/off ROI difference in both carriers', () => {
  assert.match(script, /'camera-pan'/);
  assert.match(dawnScript, /\['moving-rigid', 'camera-pan'\]\.includes\(visualCase\)/);
});

test('camera-pan uses dense static stripes and moves only the camera transform', () => {
  assert.match(mainScript, /const cameraPanBarLayout = \[/);
  assert.match(mainScript, /scaleX: 0\.12/);
  assert.match(mainScript, /const barLayout = isCameraPanCase\s*\?\s*cameraPanBarLayout/);
  assert.match(mainScript, /if \(isCameraPanCase\) \{[\s\S]*app\.world\.set\(cameraEntity, Transform/);
});

test('motion difference compares decoded RGB when coarse aggregates collide', () => {
  const left = {
    sha256: 'png-left',
    pixels: { width: 2, height: 2, rgbHash: 'rgb-left', nonBlack: 4, bottomStddevLuma: 0.5 },
  };
  const right = {
    sha256: 'png-right',
    pixels: { width: 2, height: 2, rgbHash: 'rgb-right', nonBlack: 4, bottomStddevLuma: 0.5 },
  };
  assert.equal(compareDecodedRgb(left, right).ok, true);
});

test('metadata-only PNG differences do not pass a decoded RGB comparison', () => {
  const left = { sha256: 'png-metadata-left', pixels: { width: 2, height: 2, rgbHash: 'same-rgb' } };
  const right = { sha256: 'png-metadata-right', pixels: { width: 2, height: 2, rgbHash: 'same-rgb' } };
  assert.deepEqual(compareDecodedRgb(left, right), {
    ok: false,
    reason: 'decoded-rgb-identical',
    dimensionsMatch: true,
    hashesPresent: true,
    decodedRgbEqual: true,
    pngHashesEqual: false,
  });
});

test('motion blur trace requires on semantics and accepts either legal off pass shape', () => {
  const onState = {
    motionBlur: { enabled: true, status: 'active', temporalDemand: 'scene-data-temporal-v1' },
    passes: ['motion-blur', 'output-transform'],
  };
  const offState = { motionBlur: { enabled: false, status: 'off', temporalDemand: null }, passes: ['output-transform'] };
  const offStateWithStablePassIdentity = {
    ...offState,
    passes: ['motion-blur', 'output-transform'],
  };
  assert.equal(validateMotionBlurTrace(onState, 'on').ok, true);
  assert.equal(validateMotionBlurTrace({ ...onState, passes: ['output-transform'] }, 'on').ok, false);
  assert.equal(validateMotionBlurTrace(offState, 'off').ok, true);
  assert.equal(validateMotionBlurTrace(offStateWithStablePassIdentity, 'off').ok, true);
  assert.equal(
    validateMotionBlurTrace(
      { ...offState, motionBlur: { ...offState.motionBlur, temporalDemand: 'scene-data-temporal-v1' } },
      'off',
    ).ok,
    false,
  );
});

test('motion blur trace accepts the split LUT output encoding writer', () => {
  const state = {
    motionBlur: { enabled: true, status: 'active', temporalDemand: 'scene-data-temporal-v1' },
    passes: ['motion-blur', 'standard-tone', 'standard-color-lut', 'standard-output-encoding'],
  };
  assert.equal(validateMotionBlurTrace(state, 'on').ok, true);
});

test('physical Browser lane does not force software and records launch adapter provenance', () => {
  assert.doesNotMatch(script, /--use-vulkan=swiftshader/i);
  assert.doesNotMatch(script, /--use-angle=swiftshader/i);
  assert.match(script, /FORGEAX_BROWSER_LAUNCH_ARGS/);
  assert.match(script, /\.\.\.explicitLaunchArgs/);
  assert.match(script, /ignoreDefaultArgs:\s*\[\s*['"]--enable-unsafe-swiftshader['"]\s*\]/);
  assert.match(script, /SystemInfo\.getInfo/);
  assert.match(script, /physicalGpu/);
  assert.match(script, /info\?\.isFallbackAdapter/);
  assert.match(script, /fallbackAdapter|isFallbackAdapter/);
  assert.match(script, /browserVersion|browser\.version\(\)/);
  assert.match(script, /launchArgs|commandLine/);
  assert.match(script, /headless/);
});
