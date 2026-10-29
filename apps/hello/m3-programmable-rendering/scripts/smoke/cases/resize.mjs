import {
  compareDawnReadbacks,
  comparePngs,
  failSmoke,
  readComposedSnapshot,
  readDawnReadbackMetadata,
  readDepthSnapshotIfAvailable,
  readRenderPassTopology,
  readRepeatabilitySnapshot,
  repeatabilityDiff,
  repoRoot,
  run,
} from '../lib/runtime.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function runResizeCases() {
const resizeChurnComposed = run(
  'browser custom pipeline + multi-texture resize churn',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
  {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR:
      process.env.FORGEAX_M3_ARTIFACT_DIR ??
      resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'resize-churn', 'browser-composed'),
  },
);
if (
  resizeChurnComposed.status !== 0 ||
  !resizeChurnComposed.output.includes('[m3-composed] PASS pipeline=custom') ||
  !resizeChurnComposed.output.includes('secondTextureChanged=') ||
  !resizeChurnComposed.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] multi-texture resize churn: FAIL - composed resize/falsifier journey did not pass');
  failSmoke();
}
console.log('[m3-programmable] multi-texture resize churn: PASS');

const msaaMultiTextureArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'msaa-multi-texture-double-resize-repeatability');
const msaaMultiTextureRuns = [];
for (const pass of ['first', 'second']) {
  msaaMultiTextureRuns.push({
    pass,
    normal: run(
      `browser MSAA multi-texture double resize ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(msaaMultiTextureArtifactRoot, pass, 'normal'),
      },
    ),
    falsifier: run(
      `browser MSAA multi-texture double resize ${pass} second-texture falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(msaaMultiTextureArtifactRoot, pass, 'falsifier'),
      },
    ),
  });
}
const msaaMultiTextureSnapshots = msaaMultiTextureRuns.map((runPair) => ({
  pass: runPair.pass,
  normal: readComposedSnapshot(resolve(msaaMultiTextureArtifactRoot, runPair.pass, 'normal')),
  falsifier: readComposedSnapshot(resolve(msaaMultiTextureArtifactRoot, runPair.pass, 'falsifier')),
}));
const msaaMultiTextureExpectedHistory = '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
for (const runPair of msaaMultiTextureRuns) {
  for (const leg of ['normal', 'falsifier']) {
    if (
      runPair[leg].status !== 0 ||
      !runPair[leg].output.includes('[m3-composed] PASS pipeline=custom msaa=true') ||
      !runPair[leg].output.includes(`resizeHistory=${msaaMultiTextureExpectedHistory}`)
    ) {
      console.error(`[m3-programmable] MSAA multi-texture double resize ${runPair.pass} ${leg}: FAIL`);
      failSmoke();
    }
  }
}
const normalRepeatabilityDiff = repeatabilityDiff(
  msaaMultiTextureSnapshots[0].normal,
  msaaMultiTextureSnapshots[1].normal,
);
const falsifierRepeatabilityDiff = repeatabilityDiff(
  msaaMultiTextureSnapshots[0].falsifier,
  msaaMultiTextureSnapshots[1].falsifier,
);
if (normalRepeatabilityDiff !== undefined || falsifierRepeatabilityDiff !== undefined) {
  console.error(
    `[m3-programmable] MSAA multi-texture double resize repeatability: FAIL - ${JSON.stringify({ normalRepeatabilityDiff, falsifierRepeatabilityDiff })}`,
  );
  failSmoke();
}
for (const snapshot of msaaMultiTextureSnapshots) {
  for (const leg of ['normal', 'falsifier']) {
    const value = snapshot[leg];
    const minimumTextureResources = leg === 'normal' ? 2 : 1;
    if (
      value.live.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.falsifier.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.rhi[leg].textureResourceCount < minimumTextureResources ||
      value.rhi[leg].msaaTextureResourceCount !== 2 ||
      value.rhi[leg].resolveTargetCount !== 1 ||
      value.rhi[leg].drawCount < 2 ||
      value.rhi[leg].dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] MSAA multi-texture topology/replay: FAIL - ${JSON.stringify({ pass: snapshot.pass, leg, value })}`);
      failSmoke();
    }
  }
  if (snapshot.falsifier.falsifier.secondTextureDelta.changed < 1000) {
    console.error(`[m3-programmable] MSAA multi-texture falsifier: FAIL - ${JSON.stringify(snapshot.falsifier.falsifier.secondTextureDelta)}`);
    failSmoke();
  }
}
console.log(
  `[m3-programmable] MSAA multi-texture double resize repeatability: PASS normalDawnSha=${msaaMultiTextureSnapshots[0].normal.rhi.normal.dawn.sha256} falsifierDawnSha=${msaaMultiTextureSnapshots[0].falsifier.rhi.falsifier.dawn.sha256} secondTextureChanged=${msaaMultiTextureSnapshots[0].falsifier.falsifier.secondTextureDelta.changed}`,
);

const dualFalsifierArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'msaa-multi-texture-dual-falsifier-double-resize');
const dualFalsifierFamilies = [
  {
    kind: 'pipeline',
    label: 'adjacent-pipeline falsifier',
    expected: { textureResourceCount: 2, msaaTextureResourceCount: 2, resolveTargetCount: 1, drawCount: 2 },
  },
  {
    kind: 'texture',
    label: 'missing-detail-texture falsifier',
    expected: { textureResourceCount: 1, msaaTextureResourceCount: 2, resolveTargetCount: 1, drawCount: 3 },
  },
];
function runMsaaDualFalsifierMatrix({ artifactRoot, startVariant, label }) {
  const runs = [];
  for (const family of dualFalsifierFamilies) {
    for (const pass of ['first', 'second']) {
      runs.push({
        family,
        pass,
        result: run(
          `browser ${label} ${family.label} ${pass}`,
          ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
          {
            FORGEAX_M3_MSAA: '1',
            FORGEAX_M3_START_VARIANT: startVariant,
            FORGEAX_M3_RESIZE_CHURN: '1',
            FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
            FORGEAX_M3_FALSIFIER_KIND: family.kind,
            FORGEAX_M3_ARTIFACT_DIR: resolve(artifactRoot, family.kind, pass),
          },
        ),
      });
    }
  }
  const snapshots = new Map(
    dualFalsifierFamilies.map((family) => [
      family.kind,
      ['first', 'second'].map((pass) => ({
        pass,
        snapshot: readComposedSnapshot(
          resolve(artifactRoot, family.kind, pass),
          family.kind === 'pipeline' ? 'falsified-pipeline-inversion' : 'falsified-second-texture-inversion',
        ),
      })),
    ]),
  );
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(
        `[m3-composed] PASS pipeline=custom msaa=true startVariant=${startVariant} falsifier=${runResult.family.kind}`,
      ) ||
      !runResult.result.output.includes(`resizeHistory=${msaaMultiTextureExpectedHistory}`)
    ) {
      console.error(`[m3-programmable] ${label} ${runResult.family.label} ${runResult.pass}: FAIL`);
      failSmoke();
    }
  }
  for (const family of dualFalsifierFamilies) {
    const familySnapshots = snapshots.get(family.kind);
    const first = familySnapshots[0].snapshot;
    const second = familySnapshots[1].snapshot;
    const falsifierRepeatabilityDiff = repeatabilityDiff(first.falsifier, second.falsifier);
    const normalRepeatabilityDiff = repeatabilityDiff(first.live, second.live);
    const rhiRepeatabilityDiff = repeatabilityDiff(first.rhi.falsifier, second.rhi.falsifier);
    const value = first.rhi.falsifier;
    if (
      normalRepeatabilityDiff !== undefined ||
      falsifierRepeatabilityDiff !== undefined ||
      rhiRepeatabilityDiff !== undefined ||
      first.live.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      first.falsifier.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.textureResourceCount !== family.expected.textureResourceCount ||
      value.msaaTextureResourceCount !== family.expected.msaaTextureResourceCount ||
      value.resolveTargetCount !== family.expected.resolveTargetCount ||
      value.drawCount !== family.expected.drawCount ||
      value.dawn.nonBlackPixelCount === 0 ||
      first.falsifier.secondTextureDelta.changed < 1000
    ) {
      console.error(
        `[m3-programmable] ${label} ${family.label}: FAIL - ${JSON.stringify({ family: family.kind, normalRepeatabilityDiff, falsifierRepeatabilityDiff, value, delta: first.falsifier.secondTextureDelta })}`,
      );
      failSmoke();
    }
  }
  console.log(
    `[m3-programmable] ${label}: PASS families=${dualFalsifierFamilies.map((family) => family.kind).join('+')} legs=${runs.length} pipelineDraws=${snapshots.get('pipeline')[0].snapshot.rhi.falsifier.drawCount} textureDraws=${snapshots.get('texture')[0].snapshot.rhi.falsifier.drawCount}`,
  );
}

runMsaaDualFalsifierMatrix({
  artifactRoot: dualFalsifierArtifactRoot,
  startVariant: 'true',
  label: 'MSAA multi-texture dual falsifier double resize',
});
runMsaaDualFalsifierMatrix({
  artifactRoot: resolve(dualFalsifierArtifactRoot, 'false-start'),
  startVariant: 'false',
  label: 'MSAA false-start multi-texture dual falsifier double resize',
});

const noMsaaDualFalsifierFamilies = [
  {
    kind: 'pipeline',
    label: 'adjacent-pipeline falsifier',
    expected: { textureResourceCount: 2, msaaTextureResourceCount: 0, resolveTargetCount: 0, drawCount: 2 },
  },
  {
    kind: 'texture',
    label: 'missing-detail-texture falsifier',
    expected: { textureResourceCount: 1, msaaTextureResourceCount: 0, resolveTargetCount: 0, drawCount: 3 },
  },
];
function runNoMsaaDualFalsifierMatrix({ artifactRoot, startVariant, label }) {
  const runs = [];
  for (const family of noMsaaDualFalsifierFamilies) {
    for (const pass of ['first', 'second']) {
      runs.push({
        family,
        pass,
        result: run(
          `browser ${label} ${family.label} ${pass}`,
          ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
          {
            FORGEAX_M3_MSAA: '0',
            FORGEAX_M3_START_VARIANT: startVariant,
            FORGEAX_M3_RESIZE_CHURN: '1',
            FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
            FORGEAX_M3_FALSIFIER_KIND: family.kind,
            FORGEAX_M3_ARTIFACT_DIR: resolve(artifactRoot, family.kind, pass),
          },
        ),
      });
    }
  }
  const snapshots = new Map(
    noMsaaDualFalsifierFamilies.map((family) => [
      family.kind,
      ['first', 'second'].map((pass) => ({
        pass,
        snapshot: readComposedSnapshot(
          resolve(artifactRoot, family.kind, pass),
          family.kind === 'pipeline' ? 'falsified-pipeline-inversion' : 'falsified-second-texture-inversion',
        ),
      })),
    ]),
  );
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      !runResult.result.output.includes(`[m3-composed] PASS pipeline=custom msaa=false startVariant=${startVariant} falsifier=${runResult.family.kind}`) ||
      !runResult.result.output.includes(`resizeHistory=${msaaMultiTextureExpectedHistory}`)
    ) {
      console.error(`[m3-programmable] ${label} ${runResult.family.label} ${runResult.pass}: FAIL`);
      failSmoke();
    }
  }
  for (const family of noMsaaDualFalsifierFamilies) {
    const familySnapshots = snapshots.get(family.kind);
    const first = familySnapshots[0].snapshot;
    const second = familySnapshots[1].snapshot;
    const falsifierRepeatabilityDiff = repeatabilityDiff(first.falsifier, second.falsifier);
    const normalRepeatabilityDiff = repeatabilityDiff(first.live, second.live);
    const rhiRepeatabilityDiff = repeatabilityDiff(first.rhi.falsifier, second.rhi.falsifier);
    const value = first.rhi.falsifier;
    if (
      normalRepeatabilityDiff !== undefined ||
      falsifierRepeatabilityDiff !== undefined ||
      rhiRepeatabilityDiff !== undefined ||
      first.live.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      first.falsifier.resizeHistory.join('>') !== msaaMultiTextureExpectedHistory ||
      value.textureResourceCount !== family.expected.textureResourceCount ||
      value.msaaTextureResourceCount !== family.expected.msaaTextureResourceCount ||
      value.resolveTargetCount !== family.expected.resolveTargetCount ||
      value.drawCount !== family.expected.drawCount ||
      value.dawn.nonBlackPixelCount === 0 ||
      first.falsifier.secondTextureDelta.changed < 1000
    ) {
      console.error(
        `[m3-programmable] ${label} ${family.label}: FAIL - ${JSON.stringify({ family: family.kind, normalRepeatabilityDiff, falsifierRepeatabilityDiff, value, delta: first.falsifier.secondTextureDelta })}`,
      );
      failSmoke();
    }
  }
  console.log(
    `[m3-programmable] ${label}: PASS families=${noMsaaDualFalsifierFamilies.map((family) => family.kind).join('+')} legs=${runs.length} pipelineDraws=${snapshots.get('pipeline')[0].snapshot.rhi.falsifier.drawCount} textureDraws=${snapshots.get('texture')[0].snapshot.rhi.falsifier.drawCount}`,
  );
}

const noMsaaDualFalsifierArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'no-msaa-multi-texture-dual-falsifier-double-resize');
runNoMsaaDualFalsifierMatrix({
  artifactRoot: noMsaaDualFalsifierArtifactRoot,
  startVariant: 'true',
  label: 'no-MSAA multi-texture dual falsifier double resize',
});
runNoMsaaDualFalsifierMatrix({
  artifactRoot: resolve(noMsaaDualFalsifierArtifactRoot, 'false-start'),
  startVariant: 'false',
  label: 'no-MSAA false-start multi-texture dual falsifier double resize',
});

const depthPostArtifactRoot =
  process.env.FORGEAX_M3_ARTIFACT_DIR ??
  resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'depth-post-repeatability');
function runDepthPostChild(label, msaa, artifactDir) {
  const args = ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'];
  const extraEnv = {
    FORGEAX_M3_DEPTH_POST: '1',
    FORGEAX_M3_MSAA: msaa,
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: artifactDir,
  };
  let result = run(label, args, extraEnv);
  for (let retry = 0; retry < 2 && !existsSync(resolve(artifactDir, 'depth-browser.json')); retry++) {
    console.error(`[m3-programmable] ${label}: expected depth artifact missing; retrying`);
    result = run(`${label} artifact retry ${retry + 1}`, args, extraEnv);
  }
  return { result, snapshot: readDepthSnapshotIfAvailable(artifactDir) };
}
for (const [label, msaa] of [
  ['no-MSAA', '0'],
  ['MSAA', '1'],
]) {
  const first = runDepthPostChild(
    `browser depth post ${label} first`,
    msaa,
    resolve(depthPostArtifactRoot, label, 'first'),
  );
  const second = runDepthPostChild(
    `browser depth post ${label} second`,
    msaa,
    resolve(depthPostArtifactRoot, label, 'second'),
  );
  const firstSnapshot = first.snapshot;
  const secondSnapshot = second.snapshot;
  if (
    first.result.status !== 0 || second.result.status !== 0 ||
    !first.result.output.includes('[m3-depth-post] PASS') ||
    !second.result.output.includes('[m3-depth-post] PASS') ||
    firstSnapshot === undefined ||
    secondSnapshot === undefined ||
    repeatabilityDiff(firstSnapshot, secondSnapshot) !== undefined ||
    firstSnapshot.normal.hasDepthBinding !== true ||
    firstSnapshot.falsifier.hasDepthBinding !== false ||
    firstSnapshot.delta.changed < 1000 ||
    firstSnapshot.normal.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
    firstSnapshot.normal.dawn.nonBlackPixelCount === 0 ||
    firstSnapshot.falsifier.dawn.nonBlackPixelCount === 0
  ) {
    console.error(`[m3-programmable] depth post ${label}: FAIL - ${JSON.stringify({ first: firstSnapshot, second: secondSnapshot })}`);
    failSmoke();
  }
  console.log(`[m3-programmable] depth post ${label}: PASS changedPixels=${firstSnapshot.delta.changed} depthBinding=true falsifierDepthBinding=false dawnSha=${firstSnapshot.normal.dawn.sha256}/${firstSnapshot.falsifier.dawn.sha256}`);
}

  runResizeRhiCases();
}

// Keep the capture/replay cases independently rerunnable after a carrier fix.
// The full smoke still executes this entire section after composed/depth cases.
export function runResizeRhiCases() {
  const customRhiArtifactRoot =
    process.env.FORGEAX_M3_ARTIFACT_DIR ??
    resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering', 'custom-pipeline-rhi');
  runCustomPipelineRhiCase(customRhiArtifactRoot);
  runCustomPipelineRhiTrueVariantCase(customRhiArtifactRoot);
  runMultiTextureResizeChurnRhiCase(customRhiArtifactRoot);
  runMsaaResizeChurnCase(customRhiArtifactRoot);
  runMsaaResizeChurnRepeatabilityCase(customRhiArtifactRoot);
  runMsaaDoubleResizeChurnCase(customRhiArtifactRoot);
  runMsaaDoubleResizeChurnRepeatabilityCase(customRhiArtifactRoot);
  runNoMsaaDoubleResizeChurnRepeatabilityCase(customRhiArtifactRoot);
  runMsaaCustomGraphCase(customRhiArtifactRoot);
  runMsaaRepeatabilityCase(customRhiArtifactRoot);
  runMsaaTrueVariantCase(customRhiArtifactRoot);
  runMsaaTrueVariantSwitchCase(customRhiArtifactRoot);
  runMsaaAdjacentPipelineCase(customRhiArtifactRoot);
  runMsaaTrueVariantPipelineRepeatability(customRhiArtifactRoot);
  runMsaaTrueInversionPipelineRepeatability(customRhiArtifactRoot);
  runMsaaFalsePassthroughPipelineRepeatability(customRhiArtifactRoot);
  runMsaaFalseInversionPipelineRepeatability(customRhiArtifactRoot);
  runNoMsaaFalseInversionPipelineRepeatability(customRhiArtifactRoot);
  runNoMsaaTrueInversionPipelineRepeatability(customRhiArtifactRoot);
  runNoMsaaTruePassthroughPipelineRepeatability(customRhiArtifactRoot);
  runNoMsaaFalsePassthroughPipelineRepeatability(customRhiArtifactRoot);
  runNoMsaaSteadyFalsePassthroughRepeatability(customRhiArtifactRoot);
  runNoMsaaSteadyFalseInversionRepeatability(customRhiArtifactRoot);
  runNoMsaaSteadyTruePassthroughRepeatability(customRhiArtifactRoot);
  runNoMsaaSteadyTrueInversionRepeatability(customRhiArtifactRoot);
}

const MULTI_UV_BROWSER_RHI_SMOKE = ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'];
const SINGLE_RESIZE_HISTORY = 'resizeHistory=640x360>480x270>720x405>640x360';
const DOUBLE_RESIZE_HISTORY = 'resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360';

function runMultiUvRhi(label, env) {
  return run(label, MULTI_UV_BROWSER_RHI_SMOKE, env);
}

function includesAll(output, markers) {
  return markers.every((marker) => output.includes(marker));
}

function legPassed(result, markers) {
  return result.status === 0 && includesAll(result.output, markers);
}

function fieldsMatch(actual, expected) {
  return Object.entries(expected).every(([field, value]) => actual[field] === value);
}

function lacksVisibleDelta(delta) {
  return delta.changedPixels === 0 || delta.meanRgbDelta <= 0.01;
}

function readArtifactJson(caseRoot, leg, file) {
  return JSON.parse(readFileSync(resolve(caseRoot, leg, file), 'utf8'));
}

function requireDawnDelta(failLabel, caseRoot, normalLeg, falsifierLeg) {
  try {
    return compareDawnReadbacks(
      resolve(caseRoot, normalLeg, 'dawn-readback.rgba'),
      resolve(caseRoot, normalLeg, 'dawn-readback.json'),
      resolve(caseRoot, falsifierLeg, 'dawn-readback.rgba'),
      resolve(caseRoot, falsifierLeg, 'dawn-readback.json'),
    );
  } catch (error) {
    console.error(`[m3-programmable] ${failLabel}: FAIL - ${error}`);
    failSmoke();
  }
}

function requirePngDelta(failLabel, caseRoot, normalLeg, falsifierLeg) {
  try {
    return comparePngs(
      resolve(caseRoot, normalLeg, 'custom-live.png'),
      resolve(caseRoot, falsifierLeg, 'custom-live.png'),
    );
  } catch (error) {
    console.error(`[m3-programmable] ${failLabel}: FAIL - ${error}`);
    failSmoke();
  }
}

function runCustomPipelineRhiCase(customRhiArtifactRoot) {
  const pipelineMarker =
    'pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture';
  const normal = runMultiUvRhi('custom pipeline RHI', {
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiArtifactRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline RHI falsifier', {
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiArtifactRoot, 'falsifier'),
  });
  if (
    !legPassed(normal, [pipelineMarker, 'textureResourceCount=2', 'draws=3']) ||
    !legPassed(falsifier, [pipelineMarker, 'textureResourceCount=2', 'draws=2'])
  ) {
    console.error('[m3-programmable] custom pipeline RHI: FAIL - normal/falsifier capture-replay leg did not pass');
    failSmoke();
  }
  console.log('[m3-programmable] custom pipeline RHI: PASS');
}

function runCustomPipelineRhiTrueVariantCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'true-variant');
  const pipelineMarker =
    'pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=true texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture';
  const normal = runMultiUvRhi('custom pipeline RHI true variant', {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline RHI true variant falsifier', {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  if (
    !legPassed(normal, [pipelineMarker, 'textureResourceCount=2', 'draws=3']) ||
    !legPassed(falsifier, [pipelineMarker, 'textureResourceCount=2', 'draws=2'])
  ) {
    console.error('[m3-programmable] custom pipeline RHI true variant: FAIL - custom/variant normal-falsifier leg did not pass');
    failSmoke();
  }
  console.log('[m3-programmable] custom pipeline RHI true variant: PASS');
  console.log('[m3-programmable] custom pipeline RHI texture binding: PASS');
}

function runMultiTextureResizeChurnRhiCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'resize-churn');
  const normal = runMultiUvRhi('custom pipeline RHI resize churn', {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline RHI resize churn falsifier', {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  if (
    !legPassed(normal, ['textureResourceCount=2', 'draws=3', SINGLE_RESIZE_HISTORY]) ||
    !legPassed(falsifier, ['textureResourceCount=2', 'draws=2', SINGLE_RESIZE_HISTORY])
  ) {
    console.error('[m3-programmable] multi-texture resize churn RHI: FAIL - normal/falsifier resource topology did not pass');
    failSmoke();
  }
  console.log('[m3-programmable] multi-texture resize churn RHI: PASS');
}

const MSAA_RESIZE_NORMAL_MARKERS = [
  'antialias=M3_ANTIALIAS=msaa',
  'textureResourceCount=2',
  'msaaTextureResourceCount=2',
  'resolveTargetCount=1',
  'draws=3',
];
const MSAA_RESIZE_FALSIFIER_MARKERS = [
  '[m3-browser-rhi] PASS_FALSIFY',
  'textureResourceCount=2',
  'msaaTextureResourceCount=2',
  'resolveTargetCount=1',
];

function runMsaaResizeChurnCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-resize-churn');
  const normal = runMultiUvRhi('custom pipeline MSAA resize churn', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline MSAA resize churn falsifier', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  if (
    !legPassed(normal, [...MSAA_RESIZE_NORMAL_MARKERS, SINGLE_RESIZE_HISTORY]) ||
    !legPassed(falsifier, [...MSAA_RESIZE_FALSIFIER_MARKERS, SINGLE_RESIZE_HISTORY])
  ) {
    console.error('[m3-programmable] multi-texture MSAA resize churn: FAIL - normal/falsifier resolve topology did not pass');
    failSmoke();
  }
  const dawnDelta = requireDawnDelta('multi-texture MSAA resize churn pixel delta', caseRoot, 'normal', 'falsifier');
  if (lacksVisibleDelta(dawnDelta)) {
    console.error(
      `[m3-programmable] multi-texture MSAA resize churn pixel delta: FAIL - changedPixels=${dawnDelta.changedPixels} meanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] multi-texture MSAA resize churn: PASS dawnChanged=${dawnDelta.changedPixels} meanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)}`,
  );
}

// Compares the `normal-N`/`falsifier-N` legs: each leg repeats exactly and the falsifier stays visible.
function checkNumberedLegRepeatability(label, caseRoot) {
  const normalDiff = repeatabilityDiff(
    readRepeatabilitySnapshot(resolve(caseRoot, 'normal-1')),
    readRepeatabilitySnapshot(resolve(caseRoot, 'normal-2')),
  );
  const falsifierDiff = repeatabilityDiff(
    readRepeatabilitySnapshot(resolve(caseRoot, 'falsifier-1')),
    readRepeatabilitySnapshot(resolve(caseRoot, 'falsifier-2')),
  );
  const firstDelta = requireDawnDelta(`${label} pixel delta`, caseRoot, 'normal-1', 'falsifier-1');
  const secondDelta = requireDawnDelta(`${label} pixel delta`, caseRoot, 'normal-2', 'falsifier-2');
  if (
    normalDiff !== undefined ||
    falsifierDiff !== undefined ||
    lacksVisibleDelta(firstDelta) ||
    JSON.stringify(firstDelta) !== JSON.stringify(secondDelta)
  ) {
    console.error(
      `[m3-programmable] ${label}: FAIL - ${JSON.stringify({ normalDiff, falsifierDiff, firstDelta, secondDelta })}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] ${label}: PASS normalSha256=${firstDelta.normalSha256} falsifierSha256=${firstDelta.falsifierSha256} changedPixels=${firstDelta.changedPixels} meanRgbDelta=${firstDelta.meanRgbDelta.toFixed(4)}`,
  );
}

function runMsaaResizeChurnRepeatabilityCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-resize-churn-repeatability');
  const normalEnv = { FORGEAX_M3_MSAA: '1', FORGEAX_M3_RESIZE_CHURN: '1' };
  const falsifierEnv = { ...normalEnv, FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1' };
  const prefix = 'custom pipeline MSAA resize churn repeatability';
  const normalFirst = runMultiUvRhi(`${prefix} normal first`, {
    ...normalEnv,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal-1'),
  });
  const normalSecond = runMultiUvRhi(`${prefix} normal second`, {
    ...normalEnv,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal-2'),
  });
  const falsifierFirst = runMultiUvRhi(`${prefix} falsifier first`, {
    ...falsifierEnv,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier-1'),
  });
  const falsifierSecond = runMultiUvRhi(`${prefix} falsifier second`, {
    ...falsifierEnv,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier-2'),
  });
  const normalMarkers = [...MSAA_RESIZE_NORMAL_MARKERS, SINGLE_RESIZE_HISTORY];
  const falsifierMarkers = [...MSAA_RESIZE_FALSIFIER_MARKERS, SINGLE_RESIZE_HISTORY];
  if (
    !legPassed(normalFirst, normalMarkers) ||
    !legPassed(normalSecond, normalMarkers) ||
    !legPassed(falsifierFirst, falsifierMarkers) ||
    !legPassed(falsifierSecond, falsifierMarkers)
  ) {
    console.error('[m3-programmable] MSAA resize churn repeatability: FAIL - one or more independent legs did not pass');
    failSmoke();
  }
  checkNumberedLegRepeatability('MSAA resize churn repeatability', caseRoot);
}

const MSAA_DOUBLE_RESIZE_ENV = {
  FORGEAX_M3_MSAA: '1',
  FORGEAX_M3_RESIZE_CHURN: '1',
  FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
};
const MSAA_DOUBLE_RESIZE_FALSIFIER_ENV = { ...MSAA_DOUBLE_RESIZE_ENV, FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1' };
const MSAA_DOUBLE_RESIZE_NORMAL_MARKERS = [...MSAA_RESIZE_NORMAL_MARKERS, DOUBLE_RESIZE_HISTORY];
const MSAA_DOUBLE_RESIZE_FALSIFIER_MARKERS = [...MSAA_RESIZE_FALSIFIER_MARKERS, 'draws=3', DOUBLE_RESIZE_HISTORY];

function runMsaaDoubleResizeChurnCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-double-resize-churn');
  const normal = runMultiUvRhi('custom pipeline MSAA double resize churn normal', {
    ...MSAA_DOUBLE_RESIZE_ENV,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline MSAA double resize churn falsifier', {
    ...MSAA_DOUBLE_RESIZE_FALSIFIER_ENV,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  if (
    !legPassed(normal, MSAA_DOUBLE_RESIZE_NORMAL_MARKERS) ||
    !legPassed(falsifier, MSAA_DOUBLE_RESIZE_FALSIFIER_MARKERS)
  ) {
    console.error('[m3-programmable] MSAA double resize churn: FAIL - normal/falsifier lifecycle legs did not pass');
    failSmoke();
  }
  const dawnDelta = requireDawnDelta('MSAA double resize churn pixel delta', caseRoot, 'normal', 'falsifier');
  if (lacksVisibleDelta(dawnDelta)) {
    console.error(`[m3-programmable] MSAA double resize churn: FAIL - ${JSON.stringify(dawnDelta)}`);
    failSmoke();
  }
  console.log(
    `[m3-programmable] MSAA double resize churn: PASS changedPixels=${dawnDelta.changedPixels} meanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)}`,
  );
}

function runMsaaDoubleResizeChurnRepeatabilityCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-double-resize-churn-repeatability');
  const prefix = 'custom pipeline MSAA double resize churn repeatability';
  const normalFirst = runMultiUvRhi(`${prefix} normal first`, {
    ...MSAA_DOUBLE_RESIZE_ENV,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal-1'),
  });
  const normalSecond = runMultiUvRhi(`${prefix} normal second`, {
    ...MSAA_DOUBLE_RESIZE_ENV,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal-2'),
  });
  const falsifierFirst = runMultiUvRhi(`${prefix} falsifier first`, {
    ...MSAA_DOUBLE_RESIZE_FALSIFIER_ENV,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier-1'),
  });
  const falsifierSecond = runMultiUvRhi(`${prefix} falsifier second`, {
    ...MSAA_DOUBLE_RESIZE_FALSIFIER_ENV,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier-2'),
  });
  if (
    !legPassed(normalFirst, MSAA_DOUBLE_RESIZE_NORMAL_MARKERS) ||
    !legPassed(normalSecond, MSAA_DOUBLE_RESIZE_NORMAL_MARKERS) ||
    !legPassed(falsifierFirst, MSAA_DOUBLE_RESIZE_FALSIFIER_MARKERS) ||
    !legPassed(falsifierSecond, MSAA_DOUBLE_RESIZE_FALSIFIER_MARKERS)
  ) {
    console.error('[m3-programmable] MSAA double resize churn repeatability: FAIL - one or more independent legs did not pass');
    failSmoke();
  }
  checkNumberedLegRepeatability('MSAA double resize churn repeatability', caseRoot);
}

// Runs the normal and FORGEAX_M3_FALSIFY legs twice under `<caseRoot>/{first,second}/{normal,falsifier}`.
function runRepeatPasses(labelPrefix, caseRoot, env) {
  const passes = [];
  for (const pass of ['first', 'second']) {
    const passRoot = resolve(caseRoot, pass);
    passes.push({
      normal: runMultiUvRhi(`${labelPrefix} ${pass} normal`, {
        ...env,
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      }),
      falsifier: runMultiUvRhi(`${labelPrefix} ${pass} falsifier`, {
        ...env,
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      }),
    });
  }
  return passes;
}

function noMsaaDoubleResizeOutputOk(output, draws) {
  return includesAll(output, [
    'antialias=M3_ANTIALIAS=none',
    'post=M3_POST_EFFECT=inversion',
    'textureResourceCount=2',
    'msaaTextureResourceCount=0',
    'resolveTargetCount=0',
    `draws=${draws}`,
    DOUBLE_RESIZE_HISTORY,
  ]);
}

function runNoMsaaDoubleResizeChurnRepeatabilityCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-double-resize-churn-repeatability');
  const passes = runRepeatPasses('custom pipeline no-MSAA double resize churn repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
  });
  if (
    passes.some(
      ({ normal, falsifier }) =>
        normal.status !== 0 ||
        falsifier.status !== 0 ||
        !noMsaaDoubleResizeOutputOk(normal.output, 3) ||
        !noMsaaDoubleResizeOutputOk(falsifier.output, 2),
    )
  ) {
    console.error(
      '[m3-programmable] no-MSAA double resize churn repeatability: FAIL - one or more independent lifecycle legs did not pass',
    );
    failSmoke();
  }
  const normalDiff = repeatabilityDiff(
    readRepeatabilitySnapshot(resolve(caseRoot, 'first', 'normal')),
    readRepeatabilitySnapshot(resolve(caseRoot, 'second', 'normal')),
  );
  const falsifierDiff = repeatabilityDiff(
    readRepeatabilitySnapshot(resolve(caseRoot, 'first', 'falsifier')),
    readRepeatabilitySnapshot(resolve(caseRoot, 'second', 'falsifier')),
  );
  const failLabel = 'no-MSAA double resize churn repeatability delta';
  const dawnFirst = requireDawnDelta(failLabel, caseRoot, 'first/normal', 'first/falsifier');
  const dawnSecond = requireDawnDelta(failLabel, caseRoot, 'second/normal', 'second/falsifier');
  const pngFirst = requirePngDelta(failLabel, caseRoot, 'first/normal', 'first/falsifier');
  const pngSecond = requirePngDelta(failLabel, caseRoot, 'second/normal', 'second/falsifier');
  if (
    normalDiff !== undefined ||
    falsifierDiff !== undefined ||
    lacksVisibleDelta(dawnFirst) ||
    lacksVisibleDelta(pngFirst) ||
    JSON.stringify(dawnFirst) !== JSON.stringify(dawnSecond) ||
    JSON.stringify(pngFirst) !== JSON.stringify(pngSecond)
  ) {
    console.error(
      `[m3-programmable] no-MSAA double resize churn repeatability: FAIL - ${JSON.stringify({ normalDiff, falsifierDiff, dawnFirst, dawnSecond, pngFirst, pngSecond })}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] no-MSAA double resize churn repeatability: PASS normalSha256=${dawnFirst.normalSha256} falsifierSha256=${dawnFirst.falsifierSha256} dawnChangedPixels=${dawnFirst.changedPixels} pngChangedPixels=${pngFirst.changedPixels}`,
  );
}

function runMsaaCustomGraphCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-custom-graph');
  const normal = runMultiUvRhi('custom pipeline MSAA graph', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline MSAA graph falsifier', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  if (
    !legPassed(normal, [
      'antialias=M3_ANTIALIAS=msaa',
      'msaaTextureResourceCount=2',
      'resolveTargetCount=',
      'draws=3',
      'variantSwitch=true',
      'dawnReadbackSha256=',
    ]) ||
    !legPassed(falsifier, ['[m3-browser-rhi] PASS_FALSIFY', 'resolveTargetCount=1', 'dawnReadbackSha256='])
  ) {
    console.error('[m3-programmable] custom pipeline MSAA graph: FAIL - MSAA resolve/replay falsifier leg did not pass');
    failSmoke();
  }
  const pixelDelta = requirePngDelta('custom pipeline MSAA pixel delta', caseRoot, 'normal', 'falsifier');
  if (lacksVisibleDelta(pixelDelta)) {
    console.error(
      `[m3-programmable] custom pipeline MSAA pixel delta: FAIL - changedPixels=${pixelDelta.changedPixels} meanRgbDelta=${pixelDelta.meanRgbDelta.toFixed(4)}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] custom pipeline MSAA graph: PASS changedPixels=${pixelDelta.changedPixels} changedFraction=${pixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${pixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  const dawnDelta = requireDawnDelta('custom pipeline MSAA Dawn readback delta', caseRoot, 'normal', 'falsifier');
  if (lacksVisibleDelta(dawnDelta)) {
    console.error(
      `[m3-programmable] custom pipeline MSAA Dawn readback delta: FAIL - changedPixels=${dawnDelta.changedPixels} meanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] custom pipeline MSAA Dawn readback: PASS changedPixels=${dawnDelta.changedPixels} changedFraction=${dawnDelta.changedFraction.toFixed(3)} meanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)} normalSha256=${dawnDelta.normalSha256} falsifierSha256=${dawnDelta.falsifierSha256}`,
  );
}

function runMsaaRepeatabilityCase(customRhiArtifactRoot) {
  const graphRoot = resolve(customRhiArtifactRoot, 'msaa-custom-graph');
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-repeatability');
  const normal = runMultiUvRhi('custom pipeline MSAA repeatability normal', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline MSAA repeatability falsifier', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  if (normal.status !== 0 || falsifier.status !== 0) {
    console.error('[m3-programmable] custom pipeline MSAA repeatability: FAIL - repeated normal/falsifier leg did not pass');
    failSmoke();
  }
  const firstNormalReadback = readDawnReadbackMetadata(resolve(graphRoot, 'normal', 'dawn-readback.json'));
  const repeatNormalReadback = readDawnReadbackMetadata(resolve(caseRoot, 'normal', 'dawn-readback.json'));
  const firstFalsifierReadback = readDawnReadbackMetadata(resolve(graphRoot, 'falsifier', 'dawn-readback.json'));
  const repeatFalsifierReadback = readDawnReadbackMetadata(resolve(caseRoot, 'falsifier', 'dawn-readback.json'));
  if (JSON.stringify(firstNormalReadback) !== JSON.stringify(repeatNormalReadback)) {
    console.error(
      `[m3-programmable] custom pipeline MSAA repeatability: FAIL - normal readback drifted first=${JSON.stringify(firstNormalReadback)} repeat=${JSON.stringify(repeatNormalReadback)}`,
    );
    failSmoke();
  }
  if (JSON.stringify(firstFalsifierReadback) !== JSON.stringify(repeatFalsifierReadback)) {
    console.error(
      `[m3-programmable] custom pipeline MSAA repeatability: FAIL - falsifier readback drifted first=${JSON.stringify(firstFalsifierReadback)} repeat=${JSON.stringify(repeatFalsifierReadback)}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] custom pipeline MSAA repeatability: PASS normalSha256=${repeatNormalReadback.sha256} falsifierSha256=${repeatFalsifierReadback.sha256} normalNonBlack=${repeatNormalReadback.nonBlackPixelCount} falsifierNonBlack=${repeatFalsifierReadback.nonBlackPixelCount}`,
  );
}

// Browser PNG and fresh-device Dawn replay must both separate the normal and falsifier legs.
function requireVisibleBrowserAndDawnDeltas(label, caseRoot) {
  const pixelDelta = requirePngDelta(`${label} pixel delta`, caseRoot, 'normal', 'falsifier');
  if (lacksVisibleDelta(pixelDelta)) {
    console.error(
      `[m3-programmable] ${label} pixel delta: FAIL - changedPixels=${pixelDelta.changedPixels} meanRgbDelta=${pixelDelta.meanRgbDelta.toFixed(4)}`,
    );
    failSmoke();
  }
  const dawnDelta = requireDawnDelta(`${label} Dawn readback delta`, caseRoot, 'normal', 'falsifier');
  if (lacksVisibleDelta(dawnDelta)) {
    console.error(
      `[m3-programmable] ${label} Dawn readback delta: FAIL - changedPixels=${dawnDelta.changedPixels} meanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] ${label}: PASS changedPixels=${pixelDelta.changedPixels} changedFraction=${pixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${pixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${dawnDelta.changedPixels} dawnMeanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)} normalSha256=${dawnDelta.normalSha256} falsifierSha256=${dawnDelta.falsifierSha256}`,
  );
}

function runMsaaTrueVariantCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant');
  const normal = runMultiUvRhi('custom pipeline MSAA true variant', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline MSAA true variant falsifier', {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  const expectedCapture = { variant: 'M3_MULTI_UV_VARIANT=true', antialias: 'M3_ANTIALIAS=msaa' };
  const normalCapture = readArtifactJson(caseRoot, 'normal', 'capture.json');
  const falsifierCapture = readArtifactJson(caseRoot, 'falsifier', 'capture.json');
  if (
    !legPassed(normal, [
      'variant=M3_MULTI_UV_VARIANT=true',
      'antialias=M3_ANTIALIAS=msaa',
      'resolveTargetCount=1',
      'draws=3',
      'dawnReadbackSha256=',
    ]) ||
    !legPassed(falsifier, ['[m3-browser-rhi] PASS_FALSIFY', 'resolveTargetCount=1', 'dawnReadbackSha256=']) ||
    !fieldsMatch(normalCapture, expectedCapture) ||
    !fieldsMatch(falsifierCapture, expectedCapture)
  ) {
    console.error('[m3-programmable] custom pipeline MSAA true variant: FAIL - initial true-variant MSAA combination did not pass');
    failSmoke();
  }
  requireVisibleBrowserAndDawnDeltas('custom pipeline MSAA true variant', caseRoot);
}

const MSAA_TRUE_VARIANT_SWITCH_ENV = {
  FORGEAX_M3_MSAA: '1',
  FORGEAX_M3_VARIANT: 'true',
  FORGEAX_M3_SWITCH_VARIANT: '1',
};
// The true variant selected at startup switches to false after the custom pipeline exists.
const SWITCHED_TRUE_VARIANT_CAPTURE = {
  selectedVariant: 'true',
  variant: 'M3_MULTI_UV_VARIANT=false',
  antialias: 'M3_ANTIALIAS=msaa',
  variantSwitchedAfterPipeline: true,
};

function runMsaaTrueVariantSwitchCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant-switch');
  const normal = runMultiUvRhi('custom pipeline MSAA true variant live switch', {
    ...MSAA_TRUE_VARIANT_SWITCH_ENV,
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline MSAA true variant live switch falsifier', {
    ...MSAA_TRUE_VARIANT_SWITCH_ENV,
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  const normalCapture = readArtifactJson(caseRoot, 'normal', 'capture.json');
  const falsifierCapture = readArtifactJson(caseRoot, 'falsifier', 'capture.json');
  if (
    !legPassed(normal, [
      'variant=M3_MULTI_UV_VARIANT=false',
      'antialias=M3_ANTIALIAS=msaa',
      'resolveTargetCount=1',
      'draws=3',
      'variantSwitch=true',
      'dawnReadbackSha256=',
    ]) ||
    !legPassed(falsifier, ['[m3-browser-rhi] PASS_FALSIFY', 'resolveTargetCount=1', 'dawnReadbackSha256=']) ||
    !fieldsMatch(normalCapture, SWITCHED_TRUE_VARIANT_CAPTURE) ||
    !fieldsMatch(falsifierCapture, SWITCHED_TRUE_VARIANT_CAPTURE)
  ) {
    console.error(
      '[m3-programmable] custom pipeline MSAA true variant live switch: FAIL - initial true variant did not switch through the MSAA graph',
    );
    failSmoke();
  }
  requireVisibleBrowserAndDawnDeltas('custom pipeline MSAA true variant live switch', caseRoot);
}

function msaaAdjacentPipelineLegsPassed(normal, falsifier) {
  const sharedMarkers = [
    'antialias=M3_ANTIALIAS=msaa',
    'msaaTextureResourceCount=2',
    'resolveTargetCount=1',
  ];
  return (
    legPassed(normal, [...sharedMarkers, 'draws=3', 'variantSwitch=true', 'dawnReadbackSha256=']) &&
    legPassed(falsifier, [...sharedMarkers, 'draws=2', 'variantSwitch=true', 'dawnReadbackSha256='])
  );
}

function runMsaaAdjacentPipelineCase(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-pipeline-falsifier');
  const normal = runMultiUvRhi('custom pipeline MSAA adjacent pipeline normal', {
    ...MSAA_TRUE_VARIANT_SWITCH_ENV,
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'normal'),
  });
  const falsifier = runMultiUvRhi('custom pipeline MSAA adjacent pipeline falsifier', {
    ...MSAA_TRUE_VARIANT_SWITCH_ENV,
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_ARTIFACT_DIR: resolve(caseRoot, 'falsifier'),
  });
  const normalCapture = readArtifactJson(caseRoot, 'normal', 'capture.json');
  const falsifierCapture = readArtifactJson(caseRoot, 'falsifier', 'capture.json');
  const normalSummary = readArtifactJson(caseRoot, 'normal', 'rhi-summary.json');
  const falsifierSummary = readArtifactJson(caseRoot, 'falsifier', 'rhi-summary.json');
  const normalTopology = readRenderPassTopology(resolve(caseRoot, 'normal'));
  const falsifierTopology = readRenderPassTopology(resolve(caseRoot, 'falsifier'));
  if (
    !msaaAdjacentPipelineLegsPassed(normal, falsifier) ||
    !fieldsMatch(normalCapture, { ...SWITCHED_TRUE_VARIANT_CAPTURE, falsifyPipeline: false }) ||
    !fieldsMatch(falsifierCapture, { ...SWITCHED_TRUE_VARIANT_CAPTURE, falsifyPipeline: true }) ||
    !fieldsMatch(normalSummary, { resolveTargetCount: 1, drawCount: 3 }) ||
    !fieldsMatch(falsifierSummary, { resolveTargetCount: 1, drawCount: 2 })
  ) {
    console.error(
      `[m3-programmable] custom pipeline MSAA adjacent pipeline falsifier: FAIL - pipeline-selection fault did not preserve MSAA resolve while changing topology: ${JSON.stringify({ normal: normalTopology, falsifier: falsifierTopology })}`,
    );
    failSmoke();
  }
  const pixelDelta = requirePngDelta('custom pipeline MSAA adjacent pipeline PNG delta', caseRoot, 'normal', 'falsifier');
  const dawnDelta = requireDawnDelta('custom pipeline MSAA adjacent pipeline Dawn delta', caseRoot, 'normal', 'falsifier');
  if (dawnDelta.width !== 640 || dawnDelta.height !== 360) {
    console.error(
      `[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn readback: FAIL - dimensions=${dawnDelta.width}x${dawnDelta.height}`,
    );
    failSmoke();
  }
  // Use inversion for this adjacent-pipeline probe so suppressing the feature-host
  // stage is observable in both the live screenshot and fresh-device replay.
  if (dawnDelta.changedPixels === 0 || dawnDelta.normalSha256 === dawnDelta.falsifierSha256) {
    console.error(
      `[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn delta: FAIL - changedPixels=${dawnDelta.changedPixels} normalSha256=${dawnDelta.normalSha256} falsifierSha256=${dawnDelta.falsifierSha256}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] custom pipeline MSAA adjacent pipeline: PASS normalResolve=${normalSummary.resolveTargetCount} falsifierResolve=${falsifierSummary.resolveTargetCount} normalDraws=${normalSummary.drawCount} falsifierDraws=${falsifierSummary.drawCount} browserChangedPixels=${pixelDelta.changedPixels} browserMeanRgbDelta=${pixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${dawnDelta.changedPixels} dawnMeanRgbDelta=${dawnDelta.meanRgbDelta.toFixed(4)} normalSha256=${dawnDelta.normalSha256} falsifierSha256=${dawnDelta.falsifierSha256}`,
  );
}

function readPassSnapshots(caseRoot, passes) {
  return passes.map((pass, index) => ({
    normal: {
      result: pass.normal,
      snapshot: readRepeatabilitySnapshot(resolve(caseRoot, index === 0 ? 'first/normal' : 'second/normal')),
    },
    falsifier: {
      result: pass.falsifier,
      snapshot: readRepeatabilitySnapshot(resolve(caseRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
    },
  }));
}

function runPipelineRepeatPasses(labelPrefix, caseRoot, env) {
  return readPassSnapshots(caseRoot, runRepeatPasses(labelPrefix, caseRoot, env));
}

// `firstPassMatches` carries the case-specific first-pass contract; the second pass
// must succeed and reproduce both legs exactly.
function checkPipelineRepeatability(label, [first, second], firstPassMatches) {
  const normalDiff = repeatabilityDiff(first.normal.snapshot, second.normal.snapshot);
  const falsifierDiff = repeatabilityDiff(first.falsifier.snapshot, second.falsifier.snapshot);
  if (
    !firstPassMatches ||
    second.normal.result.status !== 0 ||
    second.falsifier.result.status !== 0 ||
    normalDiff !== undefined ||
    falsifierDiff !== undefined
  ) {
    console.error(
      `[m3-programmable] ${label}: FAIL - ${JSON.stringify({ normalStatus: [first.normal.result.status, second.normal.result.status], falsifierStatus: [first.falsifier.result.status, second.falsifier.result.status], normalDiff, falsifierDiff })}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] ${label}: PASS normalSha256=${first.normal.snapshot.dawn.sha256} falsifierSha256=${first.falsifier.snapshot.dawn.sha256} normalPngSha256=${first.normal.snapshot.screenshotSha256} falsifierPngSha256=${first.falsifier.snapshot.screenshotSha256}`,
  );
}

function pipelineCapturesMatch(pass, expected) {
  return (
    fieldsMatch(pass.normal.snapshot.capture, { ...expected, falsifyPipeline: false }) &&
    fieldsMatch(pass.falsifier.snapshot.capture, { ...expected, falsifyPipeline: true })
  );
}

function rhiCountsMatch(pass, expected) {
  return (
    fieldsMatch(pass.normal.snapshot.rhi, { ...expected, drawCount: 3 }) &&
    fieldsMatch(pass.falsifier.snapshot.rhi, { ...expected, drawCount: 2 })
  );
}

function runMsaaTrueVariantPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant-pipeline-repeatability');
  const passes = runPipelineRepeatPasses(
    'custom pipeline MSAA true variant pipeline repeat',
    caseRoot,
    MSAA_TRUE_VARIANT_SWITCH_ENV,
  );
  const [first] = passes;
  const switchedMarkers = ['variant=M3_MULTI_UV_VARIANT=false', 'msaaTextureResourceCount=2', 'resolveTargetCount=1'];
  checkPipelineRepeatability(
    'custom pipeline MSAA true variant pipeline repeatability',
    passes,
    legPassed(first.normal.result, [...switchedMarkers, 'antialias=M3_ANTIALIAS=msaa', 'draws=3', 'variantSwitch=true']) &&
      legPassed(first.falsifier.result, [...switchedMarkers, 'draws=2', 'variantSwitch=true']) &&
      pipelineCapturesMatch(first, {
        selectedVariant: 'true',
        variant: 'M3_MULTI_UV_VARIANT=false',
        variantSwitchedAfterPipeline: true,
      }) &&
      rhiCountsMatch(first, { resolveTargetCount: 1 }),
  );
}

function runMsaaTrueInversionPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-true-inversion-pipeline-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline MSAA true inversion pipeline repeat', caseRoot, {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
  });
  const [first] = passes;
  const legMarkers = [
    'variant=M3_MULTI_UV_VARIANT=false',
    'post=M3_POST_EFFECT=inversion',
    'msaaTextureResourceCount=2',
    'resolveTargetCount=1',
  ];
  checkPipelineRepeatability(
    'custom pipeline MSAA true inversion pipeline repeatability',
    passes,
    legPassed(first.normal.result, [...legMarkers, 'draws=3', 'variantSwitch=true']) &&
      legPassed(first.falsifier.result, [...legMarkers, 'draws=2', 'variantSwitch=true']) &&
      pipelineCapturesMatch(first, {
        selectedVariant: 'true',
        selectedPost: 'M3_POST_EFFECT=inversion',
        variant: 'M3_MULTI_UV_VARIANT=false',
        variantSwitchedAfterPipeline: true,
        postSwitchedAfterPipeline: false,
      }) &&
      rhiCountsMatch(first, { resolveTargetCount: 1 }),
  );
}

// Steady MSAA legs keep their startup variant and post effect; the falsifier still renders a PASS frame.
function steadyMsaaPipelineFirstPassMatches(first, variant, post) {
  const legMarkers = [
    `variant=M3_MULTI_UV_VARIANT=${variant}`,
    `post=M3_POST_EFFECT=${post}`,
    'msaaTextureResourceCount=2',
    'resolveTargetCount=1',
  ];
  return (
    legPassed(first.normal.result, [...legMarkers, 'draws=3', 'variantSwitch=false', 'postSwitch=false']) &&
    legPassed(first.falsifier.result, [
      '[m3-browser-rhi] PASS -',
      ...legMarkers,
      'draws=2',
      'variantSwitch=false',
      'postSwitch=false',
    ]) &&
    pipelineCapturesMatch(first, {
      selectedVariant: variant,
      selectedPost: `M3_POST_EFFECT=${post}`,
      variantSwitchedAfterPipeline: false,
      postSwitchedAfterPipeline: false,
    }) &&
    rhiCountsMatch(first, { resolveTargetCount: 1 })
  );
}

function runMsaaFalsePassthroughPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-false-passthrough-pipeline-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline MSAA false passthrough pipeline repeat', caseRoot, {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'false',
  });
  checkPipelineRepeatability(
    'custom pipeline MSAA false passthrough pipeline repeatability',
    passes,
    steadyMsaaPipelineFirstPassMatches(passes[0], 'false', 'passthrough'),
  );
}

function runMsaaFalseInversionPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'msaa-false-inversion-pipeline-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline MSAA false inversion pipeline repeat', caseRoot, {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
  });
  checkPipelineRepeatability(
    'custom pipeline MSAA false inversion pipeline repeatability',
    passes,
    steadyMsaaPipelineFirstPassMatches(passes[0], 'false', 'inversion'),
  );
}

const NO_MSAA_RHI_COUNTS = { msaaTextureResourceCount: 0, resolveTargetCount: 0 };

function noMsaaLegMarkers(variant, post) {
  return [
    `variant=M3_MULTI_UV_VARIANT=${variant}`,
    `post=M3_POST_EFFECT=${post}`,
    'msaaTextureResourceCount=0',
    'resolveTargetCount=0',
  ];
}

// The first falsifier leg is checked by its output markers only, not its exit status.
function noMsaaPipelineFirstPassMatches(first, variant, post) {
  const legMarkers = [...noMsaaLegMarkers(variant, post), 'antialias=M3_ANTIALIAS=none'];
  return (
    legPassed(first.normal.result, [...legMarkers, 'draws=3']) &&
    includesAll(first.falsifier.result.output, [...legMarkers, 'draws=2']) &&
    pipelineCapturesMatch(first, { selectedVariant: variant, selectedPost: `M3_POST_EFFECT=${post}` }) &&
    rhiCountsMatch(first, NO_MSAA_RHI_COUNTS)
  );
}

function runNoMsaaFalseInversionPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-false-inversion-pipeline-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA false inversion pipeline repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
  });
  checkPipelineRepeatability(
    'custom pipeline no-MSAA false inversion pipeline repeatability',
    passes,
    noMsaaPipelineFirstPassMatches(passes[0], 'false', 'inversion'),
  );
}

function runNoMsaaTrueInversionPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-true-inversion-pipeline-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA true inversion pipeline repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
  });
  checkPipelineRepeatability(
    'custom pipeline no-MSAA true inversion pipeline repeatability',
    passes,
    noMsaaPipelineFirstPassMatches(passes[0], 'true', 'inversion'),
  );
}

function runNoMsaaTruePassthroughPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-true-passthrough-pipeline-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA true passthrough pipeline repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
  });
  checkPipelineRepeatability(
    'custom pipeline no-MSAA true passthrough pipeline repeatability',
    passes,
    noMsaaPipelineFirstPassMatches(passes[0], 'true', 'passthrough'),
  );
}

function runNoMsaaFalsePassthroughPipelineRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-false-passthrough-pipeline-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA false passthrough pipeline repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'false',
  });
  checkPipelineRepeatability(
    'custom pipeline no-MSAA false passthrough pipeline repeatability',
    passes,
    noMsaaPipelineFirstPassMatches(passes[0], 'false', 'passthrough'),
  );
}

// Steady no-MSAA legs: only the normal leg must report `antialias=M3_ANTIALIAS=none`.
function steadyNoMsaaLegsPassed(first, variant, post) {
  const legMarkers = noMsaaLegMarkers(variant, post);
  return (
    legPassed(first.normal.result, [...legMarkers, 'antialias=M3_ANTIALIAS=none', 'draws=3']) &&
    legPassed(first.falsifier.result, [...legMarkers, 'draws=2'])
  );
}

function runNoMsaaSteadyFalsePassthroughRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-false-passthrough-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA steady false passthrough repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'false',
  });
  const [first] = passes;
  checkPipelineRepeatability(
    'custom pipeline no-MSAA steady false passthrough repeatability',
    passes,
    steadyNoMsaaLegsPassed(first, 'false', 'passthrough') &&
      pipelineCapturesMatch(first, { selectedVariant: 'false', selectedPost: 'M3_POST_EFFECT=passthrough' }) &&
      rhiCountsMatch(first, NO_MSAA_RHI_COUNTS),
  );
}

// The remaining steady no-MSAA cases do not pin the capture's falsifyPipeline flag.
function steadyNoMsaaCapturesMatch(first, variant, post) {
  const expected = { selectedVariant: variant, selectedPost: `M3_POST_EFFECT=${post}` };
  return fieldsMatch(first.normal.snapshot.capture, expected) && fieldsMatch(first.falsifier.snapshot.capture, expected);
}

function runNoMsaaSteadyFalseInversionRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-false-inversion-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA steady false inversion repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
  });
  const [first] = passes;
  checkPipelineRepeatability(
    'custom pipeline no-MSAA steady false inversion repeatability',
    passes,
    steadyNoMsaaLegsPassed(first, 'false', 'inversion') &&
      steadyNoMsaaCapturesMatch(first, 'false', 'inversion') &&
      rhiCountsMatch(first, NO_MSAA_RHI_COUNTS),
  );
}

function runNoMsaaSteadyTruePassthroughRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-true-passthrough-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA steady true passthrough repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
  });
  const [first] = passes;
  checkPipelineRepeatability(
    'custom pipeline no-MSAA steady true passthrough repeatability',
    passes,
    steadyNoMsaaLegsPassed(first, 'true', 'passthrough') &&
      steadyNoMsaaCapturesMatch(first, 'true', 'passthrough') &&
      rhiCountsMatch(first, NO_MSAA_RHI_COUNTS),
  );
}

function runNoMsaaSteadyTrueInversionRepeatability(customRhiArtifactRoot) {
  const caseRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-true-inversion-repeatability');
  const passes = runPipelineRepeatPasses('custom pipeline no-MSAA steady true inversion repeat', caseRoot, {
    FORGEAX_M3_MSAA: '0',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
  });
  const [first] = passes;
  checkPipelineRepeatability(
    'custom pipeline no-MSAA steady true inversion repeatability',
    passes,
    steadyNoMsaaLegsPassed(first, 'true', 'inversion') &&
      steadyNoMsaaCapturesMatch(first, 'true', 'inversion') &&
      rhiCountsMatch(first, NO_MSAA_RHI_COUNTS),
  );
}
