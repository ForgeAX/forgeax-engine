import {
  compareDawnReadbacks,
  comparePngs,
  failSmoke,
  readLastJsonLine,
  readLiveMaterialSnapshotIfAvailable,
  repeatabilityDiff,
  repoRoot,
  run,
  sha256File,
  stableCustomMaterialBrowserEvidence,
  visualCausalityRepeatabilityDiff,
} from '../lib/runtime.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function runInheritanceCases() {
const m10ArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'm10-render-feature-stage-fault-recovery',
);
const m10Dawn = run(
  'M10 render feature Dawn fault recovery',
  ['--filter', '@forgeax/hello-m3-programmable-rendering', 'run', 'smoke:m10:dawn'],
  { FORGEAX_M10_ARTIFACT_DIR: resolve(m10ArtifactRoot, 'dawn') },
);
const m10Browser = run(
  'M10 render feature browser fault recovery',
  ['--filter', '@forgeax/hello-m3-programmable-rendering', 'run', 'smoke:m10:browser'],
  { FORGEAX_M10_ARTIFACT_DIR: resolve(m10ArtifactRoot, 'browser') },
);
if (
  m10Dawn.status !== 0 ||
  !m10Dawn.output.includes('[m10-render-feature] Dawn PASS') ||
  m10Browser.status !== 0 ||
  !m10Browser.output.includes('[m10-render-feature] Browser PASS')
) {
  console.error(
    `[m3-programmable] M10 render feature fault recovery: FAIL - ${JSON.stringify({ dawnStatus: m10Dawn.status, browserStatus: m10Browser.status })}`,
  );
  failSmoke();
}
console.log('[m3-programmable] M10 render feature Dawn fault recovery: PASS');
console.log('[m3-programmable] M10 render feature browser fault recovery: PASS');

function runCustomMaterialBrowser(label, extraEnv = {}) {
  return run(
    label,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:browser'],
    extraEnv,
  );
}

const customMaterial = run('custom material', [
  '--filter',
  '@forgeax/hello-custom-shader',
  'smoke',
]);
const customMaterialEvidence = customMaterial.status === 0 ? readLastJsonLine(customMaterial.output) : undefined;
if (
  customMaterial.status !== 0 ||
  customMaterialEvidence?.status !== 'pass' ||
  !(customMaterialEvidence?.frames >= Math.max(60, Number(process.env.SMOKE_MIN_FRAMES ?? 60))) ||
  customMaterialEvidence?.rootArtifactDigest !== customMaterialEvidence?.derivedArtifactDigest ||
  customMaterialEvidence?.pixel?.[0] < 240 ||
  customMaterialEvidence?.pixel?.[3] !== 255
) {
  console.error('[m3-programmable] custom material: FAIL - Dawn material gate did not pass');
  failSmoke();
}
console.log('[m3-programmable] custom material pixel: PASS');

const customMaterialBrowserRuns = ['first', 'second'].map((repeat) => {
  const result = runCustomMaterialBrowser(`custom material browser ${repeat}`);
  const evidence = result.status === 0 ? readLastJsonLine(result.output) : undefined;
  if (
    result.status !== 0 ||
    evidence?.browserPath !== true ||
    evidence.rootArtifactDigest !== evidence.derivedArtifactDigest ||
    typeof evidence.rootCookInputDigest !== 'string' ||
    evidence.textureHandlesDistinct !== true
  ) {
    console.error(`[m3-programmable] custom material browser ${repeat}: FAIL - semantic browser evidence missing`);
    failSmoke();
  }
  return evidence;
});
if (
  repeatabilityDiff(
    stableCustomMaterialBrowserEvidence(customMaterialBrowserRuns[0]),
    stableCustomMaterialBrowserEvidence(customMaterialBrowserRuns[1]),
  ) !== undefined
) {
  console.error(
    `[m3-programmable] custom material browser repeatability: FAIL - ${JSON.stringify({ first: customMaterialBrowserRuns[0], second: customMaterialBrowserRuns[1] })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom material browser: PASS repeats=2 rootArtifactDigest=${customMaterialBrowserRuns[0].rootArtifactDigest}`,
);
console.log('[m3-programmable] custom material texture binding: PASS');

const customMaterialBrowserFalsifiers = [
  ['missing-parent', 'missing-derived-parent', 'FORGEAX_FALSIFY_MISSING_PARENT'],
  ['uv-transform', 'uv0-transform-loss', 'FORGEAX_FALSIFY_UV0_TRANSFORM'],
  ['missing-normal-resource', 'missing-normal-resource', 'FORGEAX_FALSIFY_MISSING_NORMAL_RESOURCE'],
  ['swapped-normal-binding', 'swapped-normal-binding', 'FORGEAX_FALSIFY_SWAPPED_NORMAL_BINDING'],
];
for (const [label, expected, envKey] of customMaterialBrowserFalsifiers) {
  for (const repeat of ['first', 'second']) {
    const result = runCustomMaterialBrowser(`custom material browser ${label} falsifier ${repeat}`, {
      [envKey]: '1',
    });
    if (result.status === 0 || !result.output.includes(`FALSIFY_EXPECTED_FAILURE:${expected}`)) {
      console.error(
        `[m3-programmable] custom material browser ${label} falsifier ${repeat}: FAIL - expected attributed failure missing`,
      );
      failSmoke();
    }
  }
  console.log(`[m3-programmable] custom material browser ${label} falsifier: PASS repeats=2`);
}

const normalSlotVisualArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-normal-slot-visual-causality',
);
mkdirSync(normalSlotVisualArtifactRoot, { recursive: true });
const normalSlotVisualRuns = [];
for (const repeat of ['first', 'second']) {
  const normalArtifactDir = resolve(normalSlotVisualArtifactRoot, repeat, 'normal');
  const swapArtifactDir = resolve(normalSlotVisualArtifactRoot, repeat, 'normal-slot-swap');
  const normalBrowser = runCustomMaterialBrowser(`custom material normal-slot visual ${repeat} normal`, {
    FORGEAX_MATERIAL_ARTIFACT_DIR: normalArtifactDir,
  });
  const swappedBrowser = runCustomMaterialBrowser(`custom material normal-slot visual ${repeat} swap`, {
    FORGEAX_FALSIFY_NORMAL_SLOT_SWAP: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: swapArtifactDir,
  });
  const normalBrowserEvidence = normalBrowser.status === 0 ? readLastJsonLine(normalBrowser.output) : undefined;
  const normalScreenshotPath = resolve(normalArtifactDir, 'custom-material.png');
  const swappedScreenshotPath = resolve(swapArtifactDir, 'custom-material.png');
  if (
    normalBrowser.status !== 0 ||
    normalBrowserEvidence?.browserPath !== true ||
    normalBrowserEvidence?.renderedTextureHandles?.[0] !== normalBrowserEvidence?.resolvedTextureHandles?.[0] ||
    normalBrowserEvidence?.renderedTextureHandles?.[1] !== normalBrowserEvidence?.resolvedTextureHandles?.[1] ||
    swappedBrowser.status === 0 ||
    !swappedBrowser.output.includes('FALSIFY_EXPECTED_FAILURE:normal-slot-swap')
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot visual ${repeat}: FAIL - ${JSON.stringify({ normalStatus: normalBrowser.status, swapStatus: swappedBrowser.status })}`,
    );
    failSmoke();
  }
  const browserDelta = comparePngs(normalScreenshotPath, swappedScreenshotPath);
  const normalDawn = run(
    `custom material normal-slot Dawn ${repeat} normal`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-dawn'],
  );
  const swappedDawn = run(
    `custom material normal-slot Dawn ${repeat} swap`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-dawn'],
    { FORGEAX_MATERIAL_DAWN_VARIANT: 'normal-slot-swap' },
  );
  const normalDawnEvidence = normalDawn.status === 0 ? readLastJsonLine(normalDawn.output) : undefined;
  const swappedDawnEvidence = swappedDawn.status === 0 ? readLastJsonLine(swappedDawn.output) : undefined;
  if (
    browserDelta.meanRgbDelta <= 0.01 ||
    normalDawn.status !== 0 ||
    swappedDawn.status !== 0 ||
    normalDawnEvidence?.variant !== 'normal' ||
    swappedDawnEvidence?.variant !== 'normal-slot-swap' ||
    JSON.stringify(normalDawnEvidence?.pixel) === JSON.stringify(swappedDawnEvidence?.pixel)
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot visual ${repeat}: FAIL - ${JSON.stringify({ browserDelta, normalDawn: normalDawnEvidence, swappedDawn: swappedDawnEvidence })}`,
    );
    failSmoke();
  }
  const snapshot = {
    rootArtifactDigest: normalBrowserEvidence.rootArtifactDigest,
    normalTextureSlot: normalDawnEvidence.normalTextureSlot,
    browser: {
      normalSha256: sha256File(normalScreenshotPath),
      swappedSha256: sha256File(swappedScreenshotPath),
      delta: browserDelta,
    },
    dawn: {
      normal: normalDawnEvidence.pixel,
      swapped: swappedDawnEvidence.pixel,
    },
  };
  writeFileSync(resolve(normalSlotVisualArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  normalSlotVisualRuns.push(snapshot);
}
if (visualCausalityRepeatabilityDiff(normalSlotVisualRuns[0], normalSlotVisualRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material normal-slot visual repeatability: FAIL - ${JSON.stringify({ first: normalSlotVisualRuns[0], second: normalSlotVisualRuns[1] })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom material normal-slot visual causality: PASS repeats=2 changedPixels=${normalSlotVisualRuns[0].browser.delta.changedPixels} meanRgbDelta=${normalSlotVisualRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnPixels=${normalSlotVisualRuns[0].dawn.normal.join(',')}/${normalSlotVisualRuns[0].dawn.swapped.join(',')}`,
);

const normalSlotLiveArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-normal-slot-live-mutation',
);
mkdirSync(normalSlotLiveArtifactRoot, { recursive: true });
const normalSlotLiveRuns = [];
for (const repeat of ['first', 'second']) {
  const artifactDir = resolve(normalSlotLiveArtifactRoot, repeat);
  const browser = runCustomMaterialBrowser(`custom material normal-slot live mutation ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir,
  });
  const browserEvidence = browser.status === 0 ? readLastJsonLine(browser.output) : undefined;
  const browserBeforePath = resolve(artifactDir, 'live-normal-slot-before.png');
  const browserAfterPath = resolve(artifactDir, 'live-normal-slot-after.png');
  const browserDelta =
    browser.status === 0 && existsSync(browserBeforePath) && existsSync(browserAfterPath)
      ? comparePngs(browserBeforePath, browserAfterPath)
      : undefined;
  const dawn = run(
    `custom material normal-slot live Dawn ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir },
  );
  const dawnEvidence = dawn.status === 0 ? readLastJsonLine(dawn.output) : undefined;
  if (
    browser.status !== 0 ||
    browserEvidence?.liveMutation?.enabled !== true ||
    browserEvidence?.liveMutation?.applied !== true ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[0] !==
      browserEvidence?.liveMutation?.afterTextureHandles?.[0] ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[1] ===
      browserEvidence?.liveMutation?.afterTextureHandles?.[1] ||
    browserEvidence?.liveVisual?.beforePath === undefined ||
    browserEvidence?.liveVisual?.afterPath === undefined ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    dawn.status !== 0 ||
    dawnEvidence?.frontDoor !== 'engine-renderer-world-draw' ||
    dawnEvidence?.material?.baseColorPreserved !== true ||
    dawnEvidence?.material?.normalSlotChanged !== true ||
    dawnEvidence?.delta?.meanRgbDelta <= 0.001
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot live mutation: FAIL - ${JSON.stringify({ browserStatus: browser.status, browserEvidence, browserDelta, dawnStatus: dawn.status, dawnEvidence })}`,
    );
    failSmoke();
  }
  const snapshot = {
    browser: {
      mutation: browserEvidence.liveMutation,
      beforeSha256: sha256File(browserBeforePath),
      afterSha256: sha256File(browserAfterPath),
      delta: browserDelta,
    },
    dawn: {
      material: dawnEvidence.material,
      before: dawnEvidence.before,
      after: dawnEvidence.after,
      delta: dawnEvidence.delta,
    },
  };
  writeFileSync(resolve(normalSlotLiveArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  normalSlotLiveRuns.push(snapshot);
}
if (repeatabilityDiff(normalSlotLiveRuns[0], normalSlotLiveRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material normal-slot live mutation repeatability: FAIL - ${JSON.stringify({ first: normalSlotLiveRuns[0], second: normalSlotLiveRuns[1] })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom material normal-slot live mutation: PASS repeats=2 changedPixels=${normalSlotLiveRuns[0].browser.delta.changedPixels} meanRgbDelta=${normalSlotLiveRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${normalSlotLiveRuns[0].dawn.delta.changedPixels}`,
);

const inheritanceLiveArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-inheritance-live-rebind',
);
mkdirSync(inheritanceLiveArtifactRoot, { recursive: true });
const inheritanceLiveRuns = [];
for (const repeat of ['first', 'second']) {
  const artifactDir = resolve(inheritanceLiveArtifactRoot, repeat);
  const browser = runCustomMaterialBrowser(`custom material inheritance live rebind ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir,
  });
  const browserEvidence = browser.status === 0 ? readLastJsonLine(browser.output) : undefined;
  const browserBeforePath = resolve(artifactDir, 'live-inheritance-before.png');
  const browserAfterPath = resolve(artifactDir, 'live-inheritance-after.png');
  const browserDelta =
    browser.status === 0 && existsSync(browserBeforePath) && existsSync(browserAfterPath)
      ? comparePngs(browserBeforePath, browserAfterPath)
      : undefined;
  const falsifier = runCustomMaterialBrowser(`custom material inheritance live rebind falsifier ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1',
    FORGEAX_FALSIFY_LIVE_INHERITANCE_REBIND: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: resolve(artifactDir, 'falsifier'),
  });
  const dawn = run(
    `custom material inheritance live Dawn ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1', FORGEAX_MATERIAL_ARTIFACT_DIR: artifactDir },
  );
  const dawnEvidence = dawn.status === 0 ? readLastJsonLine(dawn.output) : undefined;
  const dawnFalsifier = run(
    `custom material inheritance live Dawn falsifier ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    {
      FORGEAX_MATERIAL_LIVE_INHERITANCE_REBIND: '1',
      FORGEAX_FALSIFY_LIVE_INHERITANCE_REBIND: '1',
      FORGEAX_MATERIAL_ARTIFACT_DIR: resolve(artifactDir, 'falsifier-dawn'),
    },
  );
  if (
    browser.status !== 0 ||
    browserEvidence?.liveMutation?.inheritanceBacked !== true ||
    browserEvidence?.liveMutation?.applied !== true ||
    browserEvidence?.liveMutation?.sourceDerivedGuid !== browserEvidence?.derivedGuid ||
    browserEvidence?.liveMutation?.sourceArtifactDigest !== browserEvidence?.derivedArtifactDigest ||
    browserEvidence?.liveMutation?.sourceCookInputDigest !== browserEvidence?.derivedCookInputDigest ||
    browserEvidence?.liveMutation?.beforeMaterialHandle === browserEvidence?.liveMutation?.afterMaterialHandle ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[0] === browserEvidence?.liveMutation?.afterTextureHandles?.[0] ||
    browserEvidence?.liveMutation?.beforeTextureHandles?.[1] === browserEvidence?.liveMutation?.afterTextureHandles?.[1] ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    falsifier.status === 0 ||
    !falsifier.output.includes('FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind') ||
    dawn.status !== 0 ||
    dawnEvidence?.material?.inheritanceBacked !== true ||
    dawnEvidence?.material?.sourceArtifactDigest !== dawnEvidence?.derivedArtifactDigest ||
    dawnEvidence?.material?.sourceCookInputDigest !== dawnEvidence?.derivedCookInputDigest ||
    dawnEvidence?.material?.beforeTextureHandles?.[0] === dawnEvidence?.material?.afterTextureHandles?.[0] ||
    dawnEvidence?.material?.beforeTextureHandles?.[1] === dawnEvidence?.material?.afterTextureHandles?.[1] ||
    dawnEvidence?.delta?.meanRgbDelta <= 0.001 ||
    dawnFalsifier.status === 0 ||
    !dawnFalsifier.output.includes('FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind')
  ) {
    console.error(
      `[m3-programmable] custom material inheritance live rebind ${repeat}: FAIL - ${JSON.stringify({ browserStatus: browser.status, browserEvidence, browserDelta, falsifierStatus: falsifier.status, dawnStatus: dawn.status, dawnEvidence, dawnFalsifierStatus: dawnFalsifier.status })}`,
    );
    failSmoke();
  }
  const snapshot = {
    browser: {
      rootArtifactDigest: browserEvidence.rootArtifactDigest,
      derivedArtifactDigest: browserEvidence.derivedArtifactDigest,
      rootCookInputDigest: browserEvidence.rootCookInputDigest,
      derivedCookInputDigest: browserEvidence.derivedCookInputDigest,
      mutation: browserEvidence.liveMutation,
      beforeSha256: sha256File(browserBeforePath),
      afterSha256: sha256File(browserAfterPath),
      delta: browserDelta,
    },
    dawn: {
      rootArtifactDigest: dawnEvidence.rootArtifactDigest,
      derivedArtifactDigest: dawnEvidence.derivedArtifactDigest,
      rootCookInputDigest: dawnEvidence.rootCookInputDigest,
      derivedCookInputDigest: dawnEvidence.derivedCookInputDigest,
      material: dawnEvidence.material,
      before: dawnEvidence.before,
      after: dawnEvidence.after,
      delta: dawnEvidence.delta,
    },
  };
  writeFileSync(resolve(inheritanceLiveArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  inheritanceLiveRuns.push(snapshot);
}
if (repeatabilityDiff(inheritanceLiveRuns[0], inheritanceLiveRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material inheritance live rebind repeatability: FAIL - ${JSON.stringify({ first: inheritanceLiveRuns[0], second: inheritanceLiveRuns[1] })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom material inheritance live rebind: PASS repeats=2 changedPixels=${inheritanceLiveRuns[0].browser.delta.changedPixels} meanRgbDelta=${inheritanceLiveRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${inheritanceLiveRuns[0].dawn.delta.changedPixels}`,
);

const materialResizeArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-normal-slot-live-resize-rebuild',
);
mkdirSync(materialResizeArtifactRoot, { recursive: true });
const materialResizeRuns = [];
for (const repeat of ['first', 'second']) {
  const normalDir = resolve(materialResizeArtifactRoot, `normal-${repeat}`);
  const swapDir = resolve(materialResizeArtifactRoot, `swap-${repeat}`);
  const normalBrowser = runCustomMaterialBrowser(`custom material normal-slot resize normal ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_RESIZE: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir,
  });
  const swapBrowser = runCustomMaterialBrowser(`custom material normal-slot resize swap ${repeat}`, {
    FORGEAX_MATERIAL_LIVE_NORMAL_SLOT_SWAP_RESIZE: '1',
    FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir,
  });
  const normalBrowserEvidence = normalBrowser.status === 0 ? readLastJsonLine(normalBrowser.output) : undefined;
  const swapBrowserEvidence = swapBrowser.status === 0 ? readLastJsonLine(swapBrowser.output) : undefined;
  const normalAfterPath = resolve(normalDir, 'live-normal-slot-resize-after.png');
  const swapAfterPath = resolve(swapDir, 'live-normal-slot-resize-after.png');
  const browserDelta =
    normalBrowser.status === 0 && swapBrowser.status === 0 && existsSync(normalAfterPath) && existsSync(swapAfterPath)
      ? comparePngs(normalAfterPath, swapAfterPath)
      : undefined;
  const normalDawn = run(
    `custom material normal-slot resize Dawn normal ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_RESIZE_VARIANT: 'normal', FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir },
  );
  const swapDawn = run(
    `custom material normal-slot resize Dawn swap ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_RESIZE_VARIANT: 'swap', FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir },
  );
  const normalDawnEvidence = normalDawn.status === 0 ? readLastJsonLine(normalDawn.output) : undefined;
  const swapDawnEvidence = swapDawn.status === 0 ? readLastJsonLine(swapDawn.output) : undefined;
  const dawnDelta =
    normalDawn.status === 0 && swapDawn.status === 0
      ? compareDawnReadbacks(
          resolve(normalDir, 'live-normal-slot-after-resize.rgba'),
          resolve(normalDir, 'live-normal-slot-after-resize.json'),
          resolve(swapDir, 'live-normal-slot-after-resize.rgba'),
          resolve(swapDir, 'live-normal-slot-after-resize.json'),
        )
      : undefined;
  if (
    normalBrowser.status !== 0 ||
    swapBrowser.status !== 0 ||
    normalBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    swapBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    swapBrowserEvidence?.liveMutation?.afterComponentMaterialHandle !== swapBrowserEvidence?.liveMutation?.afterMaterialHandle ||
    swapBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== swapBrowserEvidence?.liveMutation?.afterMaterialHandle ||
    normalBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== normalBrowserEvidence?.liveMutation?.beforeMaterialHandle ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    normalDawn.status !== 0 ||
    swapDawn.status !== 0 ||
    normalDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    swapDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    swapDawnEvidence?.material?.normalSlotChanged !== true ||
    dawnDelta?.meanRgbDelta <= 0.001
  ) {
    console.error(
      `[m3-programmable] custom material normal-slot resize/rebuild: FAIL - ${JSON.stringify({ normalBrowser: normalBrowserEvidence, swapBrowser: swapBrowserEvidence, browserDelta, normalDawn: normalDawnEvidence, swapDawn: swapDawnEvidence, dawnDelta })}`,
    );
    failSmoke();
  }
  const snapshot = {
    browser: {
      normal: { resize: normalBrowserEvidence.resizeRebuild, sha256: sha256File(normalAfterPath) },
      swap: { mutation: swapBrowserEvidence.liveMutation, resize: swapBrowserEvidence.resizeRebuild, sha256: sha256File(swapAfterPath) },
      delta: browserDelta,
    },
    dawn: {
      normal: { material: normalDawnEvidence.material, resize: normalDawnEvidence.resize, sha256: normalDawnEvidence.after.sha256 },
      swap: { material: swapDawnEvidence.material, resize: swapDawnEvidence.resize, sha256: swapDawnEvidence.after.sha256 },
      delta: dawnDelta,
    },
  };
  writeFileSync(resolve(materialResizeArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  materialResizeRuns.push(snapshot);
}
if (repeatabilityDiff(materialResizeRuns[0], materialResizeRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material normal-slot resize/rebuild repeatability: FAIL - ${JSON.stringify({ first: materialResizeRuns[0], second: materialResizeRuns[1] })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom material normal-slot resize/rebuild: PASS repeats=2 browserChangedPixels=${materialResizeRuns[0].browser.delta.changedPixels} browserMeanRgbDelta=${materialResizeRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${materialResizeRuns[0].dawn.delta.changedPixels}`,
);

const twoSlotResizeArtifactRoot = resolve(
  process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
  'custom-material-two-slot-live-resize-rebuild',
);
mkdirSync(twoSlotResizeArtifactRoot, { recursive: true });
const twoSlotResizeRuns = [];
for (const repeat of ['first', 'second']) {
  const normalDir = resolve(twoSlotResizeArtifactRoot, `normal-${repeat}`);
  const swapDir = resolve(twoSlotResizeArtifactRoot, `swap-${repeat}`);
  const normalBrowser = run(
    `custom material two-slot resize normal ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:browser'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE: '1', FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir },
  );
  const swapBrowser = run(
    `custom material two-slot resize swap ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:browser'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_SWAP_RESIZE: '1', FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir },
  );
  const normalBrowserEvidence = normalBrowser.status === 0 ? readLastJsonLine(normalBrowser.output) : undefined;
  const swapBrowserEvidence = swapBrowser.status === 0 ? readLastJsonLine(swapBrowser.output) : undefined;
  const normalAfterPath = resolve(normalDir, 'live-two-slot-resize-after.png');
  const swapAfterPath = resolve(swapDir, 'live-two-slot-resize-after.png');
  const browserDelta =
    normalBrowser.status === 0 && swapBrowser.status === 0 && existsSync(normalAfterPath) && existsSync(swapAfterPath)
      ? comparePngs(normalAfterPath, swapAfterPath)
      : undefined;
  const normalDawn = run(
    `custom material two-slot resize Dawn normal ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE_VARIANT: 'normal', FORGEAX_MATERIAL_ARTIFACT_DIR: normalDir },
  );
  const swapDawn = run(
    `custom material two-slot resize Dawn swap ${repeat}`,
    ['--filter', '@forgeax/hello-custom-shader', 'run', 'smoke:normal-slot-live-dawn'],
    { FORGEAX_MATERIAL_LIVE_TWO_SLOT_RESIZE_VARIANT: 'swap', FORGEAX_MATERIAL_ARTIFACT_DIR: swapDir },
  );
  const normalDawnEvidence = normalDawn.status === 0 ? readLastJsonLine(normalDawn.output) : undefined;
  const swapDawnEvidence = swapDawn.status === 0 ? readLastJsonLine(swapDawn.output) : undefined;
  const dawnDelta =
    normalDawn.status === 0 && swapDawn.status === 0
      ? compareDawnReadbacks(
          resolve(normalDir, 'live-normal-slot-after-resize.rgba'),
          resolve(normalDir, 'live-normal-slot-after-resize.json'),
          resolve(swapDir, 'live-normal-slot-after-resize.rgba'),
          resolve(swapDir, 'live-normal-slot-after-resize.json'),
        )
      : undefined;
  if (
    normalBrowser.status !== 0 ||
    swapBrowser.status !== 0 ||
    normalBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    swapBrowserEvidence?.resizeRebuild?.afterCanvas?.join('x') !== '384x192' ||
    normalBrowserEvidence?.liveMutation?.baseColorSlotChanged !== false ||
    normalBrowserEvidence?.liveMutation?.normalSlotChanged !== false ||
    swapBrowserEvidence?.liveMutation?.baseColorSlotChanged !== true ||
    swapBrowserEvidence?.liveMutation?.normalSlotChanged !== true ||
    swapBrowserEvidence?.liveMutation?.beforeTextureHandles?.[0] === swapBrowserEvidence?.liveMutation?.afterTextureHandles?.[0] ||
    swapBrowserEvidence?.liveMutation?.beforeTextureHandles?.[1] === swapBrowserEvidence?.liveMutation?.afterTextureHandles?.[1] ||
    swapBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== swapBrowserEvidence?.liveMutation?.afterMaterialHandle ||
    normalBrowserEvidence?.resizeRebuild?.postResizeMaterialHandle !== normalBrowserEvidence?.liveMutation?.beforeMaterialHandle ||
    browserDelta?.meanRgbDelta <= 0.01 ||
    normalDawn.status !== 0 ||
    swapDawn.status !== 0 ||
    normalDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    swapDawnEvidence?.resize?.after?.join('x') !== '256x192' ||
    normalDawnEvidence?.material?.baseColorChanged !== false ||
    normalDawnEvidence?.material?.afterHandle !== normalDawnEvidence?.material?.beforeHandle ||
    swapDawnEvidence?.material?.baseColorChanged !== true ||
    swapDawnEvidence?.material?.afterHandle === swapDawnEvidence?.material?.beforeHandle ||
    swapDawnEvidence?.material?.normalSlotChanged !== true ||
    swapDawnEvidence?.material?.beforeTextureHandles?.[0] === swapDawnEvidence?.material?.afterTextureHandles?.[0] ||
    swapDawnEvidence?.material?.beforeTextureHandles?.[1] === swapDawnEvidence?.material?.afterTextureHandles?.[1] ||
    dawnDelta?.meanRgbDelta <= 0.001
  ) {
    console.error(
      `[m3-programmable] custom material two-slot resize/rebuild: FAIL - ${JSON.stringify({ normalBrowser: normalBrowserEvidence, swapBrowser: swapBrowserEvidence, browserDelta, normalDawn: normalDawnEvidence, swapDawn: swapDawnEvidence, dawnDelta })}`,
    );
    failSmoke();
  }
  const snapshot = {
    browser: {
      normal: { resize: normalBrowserEvidence.resizeRebuild, sha256: sha256File(normalAfterPath) },
      swap: { mutation: swapBrowserEvidence.liveMutation, resize: swapBrowserEvidence.resizeRebuild, sha256: sha256File(swapAfterPath) },
      delta: browserDelta,
    },
    dawn: {
      normal: { material: normalDawnEvidence.material, resize: normalDawnEvidence.resize, sha256: normalDawnEvidence.after.sha256 },
      swap: { material: swapDawnEvidence.material, resize: swapDawnEvidence.resize, sha256: swapDawnEvidence.after.sha256 },
      delta: dawnDelta,
    },
  };
  writeFileSync(resolve(twoSlotResizeArtifactRoot, `repeat-${repeat}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  twoSlotResizeRuns.push(snapshot);
}
if (repeatabilityDiff(twoSlotResizeRuns[0], twoSlotResizeRuns[1]) !== undefined) {
  console.error(
    `[m3-programmable] custom material two-slot resize/rebuild repeatability: FAIL - ${JSON.stringify({ first: twoSlotResizeRuns[0], second: twoSlotResizeRuns[1] })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom material two-slot live resize/rebuild: PASS repeats=2 browserChangedPixels=${twoSlotResizeRuns[0].browser.delta.changedPixels} browserMeanRgbDelta=${twoSlotResizeRuns[0].browser.delta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${twoSlotResizeRuns[0].dawn.delta.changedPixels}`,
);

const depthOverlay = run('depth-aware overlay', [
  '--filter',
  '@forgeax/app-learn-render-5-advanced-lighting-3-3-csm',
  'smoke',
]);
if (
  depthOverlay.status !== 0 ||
  !depthOverlay.output.includes('[smoke] PASS - criteria GREEN') ||
  !depthOverlay.output.includes('depth-banding-top/bottom-RG=') ||
  !depthOverlay.output.includes('requestedShadowCascades=4')
) {
  console.error('[m3-programmable] depth-aware URP overlay: FAIL - depth/pixel gate did not pass');
  failSmoke();
}
console.log('[m3-programmable] depth-aware URP overlay: PASS');

const fakeDepth = run(
  'fake-depth falsifier',
  ['--filter', '@forgeax/app-learn-render-5-advanced-lighting-3-3-csm', 'smoke'],
  { FALSIFY: 'force-fake-depth' },
);
const fakeDepthPixelOracleFailed =
  fakeDepth.output.includes('R/G stddev=') || fakeDepth.output.includes('no depth banding gradient --');
const fakeDepthExpectedFailure =
  fakeDepth.output.includes('expected spatial diversity from cascade bands') ||
  fakeDepth.output.includes('no depth banding gradient --');
if (
  fakeDepth.status === 0 ||
  !fakeDepth.output.includes('FALSIFY force-fake-depth') ||
  !fakeDepthPixelOracleFailed ||
  !fakeDepthExpectedFailure
) {
  console.error('[m3-programmable] fake-depth falsifier: FAIL - bad depth did not flip the pixel oracle');
  failSmoke();
}
console.log('[m3-programmable] fake-depth falsifier: PASS');

const multiUvRoot = resolve(repoRoot, 'apps', 'hello-multi-uv');
const multiUvBuild = run('multi-UV build', ['--filter', '@forgeax/hello-multi-uv', 'build']);
if (multiUvBuild.status !== 0) {
  console.error('[m3-programmable] multi-UV build: FAIL - shader manifest build did not pass');
  failSmoke();
}
console.log('[m3-programmable] multi-UV build: PASS');
const multiUv = run('multi-UV Dawn', ['--filter', '@forgeax/hello-multi-uv', 'smoke']);
if (
  multiUv.status !== 0 ||
  !multiUv.output.includes('[smoke] PASS - 5 criteria GREEN') ||
  !multiUv.output.includes('quadSampleMaxDiff=') ||
  !multiUv.output.includes('[smoke] texture binding: PASS schema=baseColorTexture+detailTexture textureSample=true')
) {
  console.error('[m3-programmable] multi-UV Dawn: FAIL - 2-UV public rendering gate did not pass');
  failSmoke();
}
console.log('[m3-programmable] multi-UV Dawn: PASS');

const multiUvFalsify = run(
  'multi-UV falsifier',
  ['exec', 'node', 'scripts/smoke-falsify.mjs'],
  {},
  multiUvRoot,
);
if (
  multiUvFalsify.status !== 0 ||
  // The child owns the original maxDiff < 0.03 oracle. Final-output dither
  // can contribute one UNORM8 step; requiring an exact zero log is not that oracle.
  !multiUvFalsify.output.includes('PASS_FALSIFY') ||
  !/\[falsify-smoke\] maxDiff=\d+\.\d+/.test(multiUvFalsify.output)
) {
  console.error('[m3-programmable] multi-UV falsifier: FAIL - constant-uv1 control did not kill the oracle');
  failSmoke();
}
console.log('[m3-programmable] multi-UV falsifier: PASS');

let multiUvManifest;
try {
  multiUvManifest = JSON.parse(
    readFileSync(resolve(multiUvRoot, 'dist', 'shaders', 'manifest.json'), 'utf8'),
  );
} catch (error) {
  console.error(`[m3-programmable] multi-UV variant: FAIL - manifest unreadable: ${error}`);
  failSmoke();
}
const multiUvShader = (multiUvManifest.materialShaders ?? []).find(
  (entry) => entry?.identifier === 'hello-multi-uv::multi-uv-demo',
);
const variants = multiUvShader?.variants ?? [];
const falseVariant = variants.find((variant) => variant.defines?.M3_MULTI_UV_VARIANT === false);
if (
  multiUvShader?.uvSetCount !== 2 ||
  variants.length < 4 ||
  falseVariant === undefined ||
  falseVariant.composedWgsl === multiUvShader.composedWgsl
) {
  console.error(
    `[m3-programmable] multi-UV variant: FAIL - uvSetCount=${multiUvShader?.uvSetCount ?? 'missing'} variants=${variants.length}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] multi-UV variant: PASS uvSetCount=${multiUvShader.uvSetCount} variants=${variants.length} falseVariantBytesDiffer=true`,
);

const browserVariant = run(
  'multi-UV browser variant',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-variant'],
  {
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'browser-variant'),
  },
);
if (
  browserVariant.status !== 0 ||
  !browserVariant.output.includes('[m3-browser-variant] PASS -') ||
  !browserVariant.output.includes('falsifiedDelta=0.000')
) {
  console.error('[m3-programmable] multi-UV browser variant: FAIL - live compiled variant selection did not pass');
  failSmoke();
}
console.log('[m3-programmable] multi-UV browser variant: PASS');

const browserLive = run(
  'browser live pipeline',
  ['--filter', '@forgeax/app-learn-render-4-advanced-opengl-5-framebuffers', 'run', 'smoke:browser-live'],
  {
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'browser-live'),
  },
);
if (browserLive.status !== 0 || !browserLive.output.includes('[m3-programmable] browser live pipeline: PASS')) {
  console.error('[m3-programmable] browser live pipeline: FAIL - public browser switch/resize/RHI evidence did not pass');
  failSmoke();
}
console.log('[m3-programmable] browser live pipeline: PASS');

const browserComposed = run(
  'browser custom pipeline + post composition',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
  {
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'browser-composed'),
  },
);
if (
  browserComposed.status !== 0 ||
  !browserComposed.output.includes('[m3-composed] PASS pipeline=custom') ||
  !browserComposed.output.includes('secondTextureChanged=')
) {
  console.error('[m3-programmable] browser custom pipeline + post composition: FAIL - combined selector journey did not pass');
  failSmoke();
}
console.log('[m3-programmable] browser custom pipeline + post composition: PASS');
console.log('[m3-programmable] browser multi-texture falsifier: PASS');

const liveMaterialArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'live-material-two-slot-composed-repeatability');
const liveMaterialRuns = [];
for (const pass of ['first', 'second']) {
  liveMaterialRuns.push({
    pass,
    result: run(
      `browser composed two-slot material rebind ${pass}`,
      ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-composed'],
      {
        FORGEAX_M3_LIVE_MATERIAL: '1',
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(liveMaterialArtifactRoot, pass),
      },
    ),
  });
}
const liveMaterialSnapshots = liveMaterialRuns.map((runResult) => ({
  pass: runResult.pass,
  snapshot: readLiveMaterialSnapshotIfAvailable(resolve(liveMaterialArtifactRoot, runResult.pass)),
}));
for (const runResult of liveMaterialRuns) {
  if (
    runResult.result.status !== 0 ||
    !runResult.result.output.includes('[m3-live-material] PASS pipeline=custom post=inversion msaa=true') ||
    !runResult.result.output.includes('normalSlots=true/true') ||
    !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
  ) {
    console.error(`[m3-programmable] composed two-slot material rebind ${runResult.pass}: FAIL`);
    failSmoke();
  }
}
const firstLiveMaterial = liveMaterialSnapshots[0].snapshot;
const secondLiveMaterial = liveMaterialSnapshots[1].snapshot;
if (repeatabilityDiff(firstLiveMaterial, secondLiveMaterial) !== undefined) {
  console.error(`[m3-programmable] composed two-slot material rebind repeatability: FAIL - ${JSON.stringify({ first: firstLiveMaterial, second: secondLiveMaterial })}`);
  failSmoke();
}
for (const leg of ['normal', 'falsifier']) {
  const value = firstLiveMaterial[leg];
  if (
    value.after.pipeline !== 'M3_PIPELINE=custom' ||
    value.after.post !== 'M3_POST_EFFECT=inversion' ||
    value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
    value.draws !== 3 ||
    value.inspectedWork === undefined ||
    value.dawn.nonBlackPixelCount === 0
  ) {
    console.error(`[m3-programmable] composed two-slot material RHI/Dawn evidence: FAIL - ${JSON.stringify({ leg, value })}`);
    failSmoke();
  }
}
if (
  firstLiveMaterial.normal.afterEvidence.baseColorSlotChanged !== true ||
  firstLiveMaterial.normal.afterEvidence.detailSlotChanged !== true ||
  firstLiveMaterial.normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
  firstLiveMaterial.falsifier.afterEvidence.baseColorSlotChanged === true && firstLiveMaterial.falsifier.afterEvidence.detailSlotChanged === true ||
  firstLiveMaterial.normal.delta.changed < 1000 ||
  firstLiveMaterial.falsifier.delta.changed < 100
) {
  console.error(`[m3-programmable] composed two-slot material oracle: FAIL - ${JSON.stringify(firstLiveMaterial)}`);
  failSmoke();
}
console.log(`[m3-programmable] composed two-slot material rebind repeatability: PASS normalChanged=${firstLiveMaterial.normal.delta.changed} falsifierChanged=${firstLiveMaterial.falsifier.delta.changed} normalDawnSha=${firstLiveMaterial.normal.dawn.sha256} falsifierDawnSha=${firstLiveMaterial.falsifier.dawn.sha256}`);

const noMsaaLiveMaterialArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'live-material-two-slot-composed-no-msaa-repeatability');
function runNoMsaaLiveMaterialRepeatability(startVariant) {
  const scenarioRoot = resolve(noMsaaLiveMaterialArtifactRoot, `start-${startVariant}`);
  const noMsaaLiveMaterialRuns = [];
  for (const pass of ['first', 'second']) {
    noMsaaLiveMaterialRuns.push({
      pass,
      result: run(
        `browser composed two-slot material rebind no-MSAA start=${startVariant} ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'smoke:browser-composed'],
        {
          FORGEAX_M3_LIVE_MATERIAL: '1',
          FORGEAX_M3_MSAA: '0',
          FORGEAX_M3_START_VARIANT: startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: resolve(scenarioRoot, pass),
        },
      ),
    });
  }
  const noMsaaLiveMaterialSnapshots = noMsaaLiveMaterialRuns.map((runResult) => ({
    pass: runResult.pass,
    snapshot: readLiveMaterialSnapshotIfAvailable(resolve(scenarioRoot, runResult.pass)),
  }));
  const expectedVariant = `M3_MULTI_UV_VARIANT=${startVariant}`;
  for (const runResult of noMsaaLiveMaterialRuns) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(`[m3-live-material] PASS pipeline=custom post=inversion msaa=false startVariant=${startVariant}`) ||
      !runResult.result.output.includes('normalSlots=true/true') ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] composed two-slot material rebind no-MSAA start=${startVariant} ${runResult.pass}: FAIL`);
      failSmoke();
    }
  }
  const firstNoMsaaLiveMaterial = noMsaaLiveMaterialSnapshots[0].snapshot;
  const secondNoMsaaLiveMaterial = noMsaaLiveMaterialSnapshots[1].snapshot;
  if (repeatabilityDiff(firstNoMsaaLiveMaterial, secondNoMsaaLiveMaterial) !== undefined) {
    console.error(`[m3-programmable] composed two-slot material rebind no-MSAA start=${startVariant} repeatability: FAIL - ${JSON.stringify({ first: firstNoMsaaLiveMaterial, second: secondNoMsaaLiveMaterial })}`);
    failSmoke();
  }
  for (const leg of ['normal', 'falsifier']) {
    const value = firstNoMsaaLiveMaterial[leg];
    if (
      value.before.variant !== expectedVariant ||
      value.after.variant !== expectedVariant ||
      value.after.pipeline !== 'M3_PIPELINE=custom' ||
      value.after.post !== 'M3_POST_EFFECT=inversion' ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.draws !== 3 ||
      value.inspectedWork === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] composed two-slot material no-MSAA start=${startVariant} RHI/Dawn evidence: FAIL - ${JSON.stringify({ leg, value })}`);
      failSmoke();
    }
  }
  if (
    firstNoMsaaLiveMaterial.normal.afterEvidence.baseColorSlotChanged !== true ||
    firstNoMsaaLiveMaterial.normal.afterEvidence.detailSlotChanged !== true ||
    firstNoMsaaLiveMaterial.normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    (firstNoMsaaLiveMaterial.falsifier.afterEvidence.baseColorSlotChanged === true &&
      firstNoMsaaLiveMaterial.falsifier.afterEvidence.detailSlotChanged === true) ||
    firstNoMsaaLiveMaterial.normal.delta.changed < 1000 ||
    firstNoMsaaLiveMaterial.falsifier.delta.changed < 100
  ) {
    console.error(`[m3-programmable] composed two-slot material no-MSAA start=${startVariant} oracle: FAIL - ${JSON.stringify(firstNoMsaaLiveMaterial)}`);
    failSmoke();
  }
  console.log(`[m3-programmable] composed two-slot material no-MSAA start=${startVariant} rebind repeatability: PASS normalChanged=${firstNoMsaaLiveMaterial.normal.delta.changed} falsifierChanged=${firstNoMsaaLiveMaterial.falsifier.delta.changed} normalDawnSha=${firstNoMsaaLiveMaterial.normal.dawn.sha256} falsifierDawnSha=${firstNoMsaaLiveMaterial.falsifier.dawn.sha256}`);
}
runNoMsaaLiveMaterialRepeatability('true');
runNoMsaaLiveMaterialRepeatability('false');

const composedInheritanceLiveArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'inheritance-live-material-composed-repeatability');
const composedInheritanceLiveRuns = [];
for (const pass of ['first', 'second']) {
  const result = run(
    `browser composed inherited material rebind ${pass}`,
    ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
    {
      FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
      FORGEAX_M3_MSAA: '1',
      FORGEAX_M3_START_VARIANT: 'true',
      FORGEAX_M3_RESIZE_CHURN: '1',
      FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
      FORGEAX_M3_ARTIFACT_DIR: resolve(composedInheritanceLiveArtifactRoot, pass),
    },
  );
  composedInheritanceLiveRuns.push({
    pass,
    result,
    snapshot: readLiveMaterialSnapshotIfAvailable(resolve(composedInheritanceLiveArtifactRoot, pass)),
  });
}
for (const runResult of composedInheritanceLiveRuns) {
  if (
    runResult.result.status !== 0 ||
    runResult.snapshot === undefined ||
    !runResult.result.output.includes('[m3-live-material] PASS pipeline=custom post=inversion msaa=true startVariant=true') ||
    !runResult.result.output.includes('normalSlots=true/true') ||
    !runResult.result.output.includes('falsifierSlots=false/false') ||
    !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
  ) {
    console.error(`[m3-programmable] composed inherited material rebind ${runResult.pass}: FAIL`);
    failSmoke();
  }
}
const firstComposedInheritanceLive = composedInheritanceLiveRuns[0].snapshot;
const secondComposedInheritanceLive = composedInheritanceLiveRuns[1].snapshot;
if (repeatabilityDiff(firstComposedInheritanceLive, secondComposedInheritanceLive) !== undefined) {
  console.error(
    `[m3-programmable] composed inherited material rebind repeatability: FAIL - ${JSON.stringify({ first: firstComposedInheritanceLive, second: secondComposedInheritanceLive })}`,
  );
  failSmoke();
}
for (const leg of ['normal', 'falsifier']) {
  const value = firstComposedInheritanceLive[leg];
  if (
    value.before.variant !== 'M3_MULTI_UV_VARIANT=true' ||
    value.after.variant !== 'M3_MULTI_UV_VARIANT=true' ||
    value.after.pipeline !== 'M3_PIPELINE=custom' ||
    value.after.post !== 'M3_POST_EFFECT=inversion' ||
    value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
    value.draws !== 3 ||
    value.inspectedWork === undefined ||
    value.dawn.nonBlackPixelCount === 0
  ) {
    console.error(`[m3-programmable] composed inherited material RHI/Dawn evidence: FAIL - ${JSON.stringify({ leg, value })}`);
    failSmoke();
  }
}
const normalInheritedEvidence = firstComposedInheritanceLive.normal.afterEvidence;
const falsifierInheritedEvidence = firstComposedInheritanceLive.falsifier.afterEvidence;
if (
  normalInheritedEvidence.inheritanceBacked !== true ||
  normalInheritedEvidence.sourceRootGuid === null ||
  normalInheritedEvidence.sourceDerivedGuid === null ||
  normalInheritedEvidence.sourceRootGuid === normalInheritedEvidence.sourceDerivedGuid ||
  normalInheritedEvidence.sourceRootArtifactDigest !== normalInheritedEvidence.sourceArtifactDigest ||
  normalInheritedEvidence.sourceRootCookInputDigest !== normalInheritedEvidence.sourceCookInputDigest ||
  normalInheritedEvidence.beforeMaterialHandle === normalInheritedEvidence.afterMaterialHandle ||
  normalInheritedEvidence.beforeTextureHandles[0] === normalInheritedEvidence.afterTextureHandles[0] ||
  normalInheritedEvidence.beforeTextureHandles[1] === normalInheritedEvidence.afterTextureHandles[1] ||
  normalInheritedEvidence.afterComponentMaterialMatchesAfter !== true ||
  firstComposedInheritanceLive.normal.delta.changed < 1000 ||
  falsifierInheritedEvidence.inheritanceBacked !== true ||
  falsifierInheritedEvidence.beforeMaterialHandle === falsifierInheritedEvidence.afterMaterialHandle ||
  falsifierInheritedEvidence.beforeTextureHandles[0] !== falsifierInheritedEvidence.afterTextureHandles[0] ||
  falsifierInheritedEvidence.beforeTextureHandles[1] !== falsifierInheritedEvidence.afterTextureHandles[1] ||
  falsifierInheritedEvidence.falsifierMarker !== 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' ||
  firstComposedInheritanceLive.falsifier.delta.changed !== 0
) {
  console.error(
    `[m3-programmable] composed inherited material oracle: FAIL - ${JSON.stringify(firstComposedInheritanceLive)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] composed inherited material rebind repeatability: PASS normalChanged=${firstComposedInheritanceLive.normal.delta.changed} falsifierChanged=${firstComposedInheritanceLive.falsifier.delta.changed} dawnSha=${firstComposedInheritanceLive.normal.dawn.sha256}`,
);
}
