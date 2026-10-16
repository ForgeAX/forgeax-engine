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
const customRhi = run(
  'custom pipeline RHI',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  { FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiArtifactRoot, 'normal') },
);
const customRhiFalsifier = run(
  'custom pipeline RHI falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiArtifactRoot, 'falsifier'),
  },
);
if (
  customRhi.status !== 0 ||
  !customRhi.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhi.output.includes('textureResourceCount=2') ||
  !customRhi.output.includes('draws=3') ||
  customRhiFalsifier.status !== 0 ||
  !customRhiFalsifier.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhiFalsifier.output.includes('textureResourceCount=2') ||
  !customRhiFalsifier.output.includes('draws=2')
) {
  console.error('[m3-programmable] custom pipeline RHI: FAIL - normal/falsifier capture-replay leg did not pass');
  failSmoke();
}
console.log('[m3-programmable] custom pipeline RHI: PASS');

const customRhiTrueArtifactRoot = resolve(customRhiArtifactRoot, 'true-variant');
const customRhiTrue = run(
  'custom pipeline RHI true variant',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiTrueArtifactRoot, 'normal'),
  },
);
const customRhiTrueFalsifier = run(
  'custom pipeline RHI true variant falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(customRhiTrueArtifactRoot, 'falsifier'),
  },
);
if (
  customRhiTrue.status !== 0 ||
  !customRhiTrue.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=true texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhiTrue.output.includes('textureResourceCount=2') ||
  !customRhiTrue.output.includes('draws=3') ||
  customRhiTrueFalsifier.status !== 0 ||
  !customRhiTrueFalsifier.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=true texture=M3_TEXTURE_BINDING=baseColorTexture+detailTexture') ||
  !customRhiTrueFalsifier.output.includes('textureResourceCount=2') ||
  !customRhiTrueFalsifier.output.includes('draws=2')
) {
  console.error('[m3-programmable] custom pipeline RHI true variant: FAIL - custom/variant normal-falsifier leg did not pass');
  failSmoke();
}
console.log('[m3-programmable] custom pipeline RHI true variant: PASS');
console.log('[m3-programmable] custom pipeline RHI texture binding: PASS');

const resizeChurnRhiArtifactRoot = resolve(customRhiArtifactRoot, 'resize-churn');
const resizeChurnRhi = run(
  'custom pipeline RHI resize churn',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(resizeChurnRhiArtifactRoot, 'normal'),
  },
);
const resizeChurnRhiFalsifier = run(
  'custom pipeline RHI resize churn falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(resizeChurnRhiArtifactRoot, 'falsifier'),
  },
);
if (
  resizeChurnRhi.status !== 0 ||
  !resizeChurnRhi.output.includes('textureResourceCount=2') ||
  !resizeChurnRhi.output.includes('draws=3') ||
  !resizeChurnRhi.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  resizeChurnRhiFalsifier.status !== 0 ||
  !resizeChurnRhiFalsifier.output.includes('textureResourceCount=2') ||
  !resizeChurnRhiFalsifier.output.includes('draws=2') ||
  !resizeChurnRhiFalsifier.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] multi-texture resize churn RHI: FAIL - normal/falsifier resource topology did not pass');
  failSmoke();
}
console.log('[m3-programmable] multi-texture resize churn RHI: PASS');

const msaaResizeChurnArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-resize-churn');
const msaaResizeChurn = run(
  'custom pipeline MSAA resize churn',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnArtifactRoot, 'normal'),
  },
);
const msaaResizeChurnFalsifier = run(
  'custom pipeline MSAA resize churn falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnArtifactRoot, 'falsifier'),
  },
);
if (
  msaaResizeChurn.status !== 0 ||
  !msaaResizeChurn.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaResizeChurn.output.includes('textureResourceCount=2') ||
  !msaaResizeChurn.output.includes('msaaTextureResourceCount=2') ||
  !msaaResizeChurn.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurn.output.includes('draws=3') ||
  !msaaResizeChurn.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  msaaResizeChurnFalsifier.status !== 0 ||
  !msaaResizeChurnFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaResizeChurnFalsifier.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaResizeChurnFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurnFalsifier.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] multi-texture MSAA resize churn: FAIL - normal/falsifier resolve topology did not pass');
  failSmoke();
}
let msaaResizeDawnDelta;
try {
  msaaResizeDawnDelta = compareDawnReadbacks(
    resolve(msaaResizeChurnArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] multi-texture MSAA resize churn pixel delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaResizeDawnDelta.changedPixels === 0 || msaaResizeDawnDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] multi-texture MSAA resize churn pixel delta: FAIL - changedPixels=${msaaResizeDawnDelta.changedPixels} meanRgbDelta=${msaaResizeDawnDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] multi-texture MSAA resize churn: PASS dawnChanged=${msaaResizeDawnDelta.changedPixels} meanRgbDelta=${msaaResizeDawnDelta.meanRgbDelta.toFixed(4)}`,
);

const msaaResizeChurnRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-resize-churn-repeatability');
const msaaResizeChurnRepeatNormalFirst = run(
  'custom pipeline MSAA resize churn repeatability normal first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1'),
  },
);
const msaaResizeChurnRepeatNormalSecond = run(
  'custom pipeline MSAA resize churn repeatability normal second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2'),
  },
);
const msaaResizeChurnRepeatFalsifierFirst = run(
  'custom pipeline MSAA resize churn repeatability falsifier first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1'),
  },
);
const msaaResizeChurnRepeatFalsifierSecond = run(
  'custom pipeline MSAA resize churn repeatability falsifier second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2'),
  },
);
const msaaResizeChurnRepeatRuns = [
  msaaResizeChurnRepeatNormalFirst,
  msaaResizeChurnRepeatNormalSecond,
  msaaResizeChurnRepeatFalsifierFirst,
  msaaResizeChurnRepeatFalsifierSecond,
];
if (
  msaaResizeChurnRepeatRuns.some((result) => result.status !== 0) ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('msaaTextureResourceCount=2') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('draws=3') ||
  !msaaResizeChurnRepeatNormalFirst.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('msaaTextureResourceCount=2') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('draws=3') ||
  !msaaResizeChurnRepeatNormalSecond.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('msaaTextureResourceCount=2') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurnRepeatFalsifierFirst.output.includes('resizeHistory=640x360>480x270>720x405>640x360') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('textureResourceCount=2') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('msaaTextureResourceCount=2') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('resolveTargetCount=1') ||
  !msaaResizeChurnRepeatFalsifierSecond.output.includes('resizeHistory=640x360>480x270>720x405>640x360')
) {
  console.error('[m3-programmable] MSAA resize churn repeatability: FAIL - one or more independent legs did not pass');
  failSmoke();
}
const msaaResizeChurnRepeatNormalDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1')),
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2')),
);
const msaaResizeChurnRepeatFalsifierDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1')),
  readRepeatabilitySnapshot(resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2')),
);
let msaaResizeChurnRepeatDeltaFirst;
let msaaResizeChurnRepeatDeltaSecond;
try {
  msaaResizeChurnRepeatDeltaFirst = compareDawnReadbacks(
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.json'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.json'),
  );
  msaaResizeChurnRepeatDeltaSecond = compareDawnReadbacks(
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.json'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.rgba'),
    resolve(msaaResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA resize churn repeatability pixel delta: FAIL - ${error}`);
  failSmoke();
}
if (
  msaaResizeChurnRepeatNormalDiff !== undefined ||
  msaaResizeChurnRepeatFalsifierDiff !== undefined ||
  msaaResizeChurnRepeatDeltaFirst.changedPixels === 0 ||
  msaaResizeChurnRepeatDeltaFirst.meanRgbDelta <= 0.01 ||
  JSON.stringify(msaaResizeChurnRepeatDeltaFirst) !== JSON.stringify(msaaResizeChurnRepeatDeltaSecond)
) {
  console.error(
    `[m3-programmable] MSAA resize churn repeatability: FAIL - ${JSON.stringify({ normalDiff: msaaResizeChurnRepeatNormalDiff, falsifierDiff: msaaResizeChurnRepeatFalsifierDiff, firstDelta: msaaResizeChurnRepeatDeltaFirst, secondDelta: msaaResizeChurnRepeatDeltaSecond })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] MSAA resize churn repeatability: PASS normalSha256=${msaaResizeChurnRepeatDeltaFirst.normalSha256} falsifierSha256=${msaaResizeChurnRepeatDeltaFirst.falsifierSha256} changedPixels=${msaaResizeChurnRepeatDeltaFirst.changedPixels} meanRgbDelta=${msaaResizeChurnRepeatDeltaFirst.meanRgbDelta.toFixed(4)}`,
);

const msaaDoubleResizeChurnArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-double-resize-churn');
const msaaDoubleResizeChurn = run(
  'custom pipeline MSAA double resize churn normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnArtifactRoot, 'normal'),
  },
);
const msaaDoubleResizeChurnFalsifier = run(
  'custom pipeline MSAA double resize churn falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnArtifactRoot, 'falsifier'),
  },
);
const doubleResizeHistory = 'resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360';
if (
  msaaDoubleResizeChurn.status !== 0 ||
  !msaaDoubleResizeChurn.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaDoubleResizeChurn.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurn.output.includes('msaaTextureResourceCount=2') ||
  !msaaDoubleResizeChurn.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurn.output.includes('draws=3') ||
  !msaaDoubleResizeChurn.output.includes(doubleResizeHistory) ||
  msaaDoubleResizeChurnFalsifier.status !== 0 ||
  !msaaDoubleResizeChurnFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurnFalsifier.output.includes('draws=3') ||
  !msaaDoubleResizeChurnFalsifier.output.includes(doubleResizeHistory)
) {
  console.error('[m3-programmable] MSAA double resize churn: FAIL - normal/falsifier lifecycle legs did not pass');
  failSmoke();
}
let msaaDoubleResizeDawnDelta;
try {
  msaaDoubleResizeDawnDelta = compareDawnReadbacks(
    resolve(msaaDoubleResizeChurnArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaDoubleResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA double resize churn pixel delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaDoubleResizeDawnDelta.changedPixels === 0 || msaaDoubleResizeDawnDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] MSAA double resize churn: FAIL - ${JSON.stringify(msaaDoubleResizeDawnDelta)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] MSAA double resize churn: PASS changedPixels=${msaaDoubleResizeDawnDelta.changedPixels} meanRgbDelta=${msaaDoubleResizeDawnDelta.meanRgbDelta.toFixed(4)}`,
);

const msaaDoubleResizeChurnRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-double-resize-churn-repeatability');
const msaaDoubleResizeChurnRepeatNormalFirst = run(
  'custom pipeline MSAA double resize churn repeatability normal first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1'),
  },
);
const msaaDoubleResizeChurnRepeatNormalSecond = run(
  'custom pipeline MSAA double resize churn repeatability normal second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2'),
  },
);
const msaaDoubleResizeChurnRepeatFalsifierFirst = run(
  'custom pipeline MSAA double resize churn repeatability falsifier first',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1'),
  },
);
const msaaDoubleResizeChurnRepeatFalsifierSecond = run(
  'custom pipeline MSAA double resize churn repeatability falsifier second',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_RESIZE_CHURN: '1',
    FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2'),
  },
);
const msaaDoubleResizeChurnRepeatRuns = [
  msaaDoubleResizeChurnRepeatNormalFirst,
  msaaDoubleResizeChurnRepeatNormalSecond,
  msaaDoubleResizeChurnRepeatFalsifierFirst,
  msaaDoubleResizeChurnRepeatFalsifierSecond,
];
if (
  msaaDoubleResizeChurnRepeatRuns.some((result) => result.status !== 0) ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('msaaTextureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes('draws=3') ||
  !msaaDoubleResizeChurnRepeatNormalFirst.output.includes(doubleResizeHistory) ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('msaaTextureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes('draws=3') ||
  !msaaDoubleResizeChurnRepeatNormalSecond.output.includes(doubleResizeHistory) ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('msaaTextureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes('draws=3') ||
  !msaaDoubleResizeChurnRepeatFalsifierFirst.output.includes(doubleResizeHistory) ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('textureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('msaaTextureResourceCount=2') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('resolveTargetCount=1') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes('draws=3') ||
  !msaaDoubleResizeChurnRepeatFalsifierSecond.output.includes(doubleResizeHistory)
) {
  console.error('[m3-programmable] MSAA double resize churn repeatability: FAIL - one or more independent legs did not pass');
  failSmoke();
}
const msaaDoubleResizeChurnRepeatNormalDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1')),
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2')),
);
const msaaDoubleResizeChurnRepeatFalsifierDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1')),
  readRepeatabilitySnapshot(resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2')),
);
let msaaDoubleResizeChurnRepeatDeltaFirst;
let msaaDoubleResizeChurnRepeatDeltaSecond;
try {
  msaaDoubleResizeChurnRepeatDeltaFirst = compareDawnReadbacks(
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-1', 'dawn-readback.json'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-1', 'dawn-readback.json'),
  );
  msaaDoubleResizeChurnRepeatDeltaSecond = compareDawnReadbacks(
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'normal-2', 'dawn-readback.json'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.rgba'),
    resolve(msaaDoubleResizeChurnRepeatArtifactRoot, 'falsifier-2', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA double resize churn repeatability pixel delta: FAIL - ${error}`);
  failSmoke();
}
if (
  msaaDoubleResizeChurnRepeatNormalDiff !== undefined ||
  msaaDoubleResizeChurnRepeatFalsifierDiff !== undefined ||
  msaaDoubleResizeChurnRepeatDeltaFirst.changedPixels === 0 ||
  msaaDoubleResizeChurnRepeatDeltaFirst.meanRgbDelta <= 0.01 ||
  JSON.stringify(msaaDoubleResizeChurnRepeatDeltaFirst) !== JSON.stringify(msaaDoubleResizeChurnRepeatDeltaSecond)
) {
  console.error(
    `[m3-programmable] MSAA double resize churn repeatability: FAIL - ${JSON.stringify({ normalDiff: msaaDoubleResizeChurnRepeatNormalDiff, falsifierDiff: msaaDoubleResizeChurnRepeatFalsifierDiff, firstDelta: msaaDoubleResizeChurnRepeatDeltaFirst, secondDelta: msaaDoubleResizeChurnRepeatDeltaSecond })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] MSAA double resize churn repeatability: PASS normalSha256=${msaaDoubleResizeChurnRepeatDeltaFirst.normalSha256} falsifierSha256=${msaaDoubleResizeChurnRepeatDeltaFirst.falsifierSha256} changedPixels=${msaaDoubleResizeChurnRepeatDeltaFirst.changedPixels} meanRgbDelta=${msaaDoubleResizeChurnRepeatDeltaFirst.meanRgbDelta.toFixed(4)}`,
);

const noMsaaDoubleResizeChurnRepeatArtifactRoot = resolve(
  customRhiArtifactRoot,
  'no-msaa-double-resize-churn-repeatability',
);
const noMsaaDoubleResizeChurnRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, pass);
  noMsaaDoubleResizeChurnRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA double resize churn repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA double resize churn repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaDoubleResizeHistory = 'resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const noMsaaDoubleResizeOutputOk = (output, draws) =>
  output.includes('antialias=M3_ANTIALIAS=none') &&
  output.includes('post=M3_POST_EFFECT=inversion') &&
  output.includes('textureResourceCount=2') &&
  output.includes('msaaTextureResourceCount=0') &&
  output.includes('resolveTargetCount=0') &&
  output.includes(`draws=${draws}`) &&
  output.includes(noMsaaDoubleResizeHistory);
if (
  noMsaaDoubleResizeChurnRepeatRuns.some(
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
const noMsaaDoubleResizeNormalDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal')),
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal')),
);
const noMsaaDoubleResizeFalsifierDiff = repeatabilityDiff(
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier')),
  readRepeatabilitySnapshot(resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier')),
);
let noMsaaDoubleResizeDawnDeltaFirst;
let noMsaaDoubleResizeDawnDeltaSecond;
let noMsaaDoubleResizePngDeltaFirst;
let noMsaaDoubleResizePngDeltaSecond;
try {
  noMsaaDoubleResizeDawnDeltaFirst = compareDawnReadbacks(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaDoubleResizeDawnDeltaSecond = compareDawnReadbacks(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaDoubleResizePngDeltaFirst = comparePngs(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  noMsaaDoubleResizePngDeltaSecond = comparePngs(
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(noMsaaDoubleResizeChurnRepeatArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] no-MSAA double resize churn repeatability delta: FAIL - ${error}`);
  failSmoke();
}
if (
  noMsaaDoubleResizeNormalDiff !== undefined ||
  noMsaaDoubleResizeFalsifierDiff !== undefined ||
  noMsaaDoubleResizeDawnDeltaFirst.changedPixels === 0 ||
  noMsaaDoubleResizeDawnDeltaFirst.meanRgbDelta <= 0.01 ||
  noMsaaDoubleResizePngDeltaFirst.changedPixels === 0 ||
  noMsaaDoubleResizePngDeltaFirst.meanRgbDelta <= 0.01 ||
  JSON.stringify(noMsaaDoubleResizeDawnDeltaFirst) !== JSON.stringify(noMsaaDoubleResizeDawnDeltaSecond) ||
  JSON.stringify(noMsaaDoubleResizePngDeltaFirst) !== JSON.stringify(noMsaaDoubleResizePngDeltaSecond)
) {
  console.error(
    `[m3-programmable] no-MSAA double resize churn repeatability: FAIL - ${JSON.stringify({ normalDiff: noMsaaDoubleResizeNormalDiff, falsifierDiff: noMsaaDoubleResizeFalsifierDiff, dawnFirst: noMsaaDoubleResizeDawnDeltaFirst, dawnSecond: noMsaaDoubleResizeDawnDeltaSecond, pngFirst: noMsaaDoubleResizePngDeltaFirst, pngSecond: noMsaaDoubleResizePngDeltaSecond })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] no-MSAA double resize churn repeatability: PASS normalSha256=${noMsaaDoubleResizeDawnDeltaFirst.normalSha256} falsifierSha256=${noMsaaDoubleResizeDawnDeltaFirst.falsifierSha256} dawnChangedPixels=${noMsaaDoubleResizeDawnDeltaFirst.changedPixels} pngChangedPixels=${noMsaaDoubleResizePngDeltaFirst.changedPixels}`,
);

const msaaCustomArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-custom-graph');
const msaaCustom = run(
  'custom pipeline MSAA graph',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaCustomArtifactRoot, 'normal'),
  },
);
const msaaCustomFalsifier = run(
  'custom pipeline MSAA graph falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaCustomArtifactRoot, 'falsifier'),
  },
);
if (
  msaaCustom.status !== 0 ||
  !msaaCustom.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaCustom.output.includes('msaaTextureResourceCount=2') ||
  !msaaCustom.output.includes('resolveTargetCount=') ||
  !msaaCustom.output.includes('draws=3') ||
  !msaaCustom.output.includes('variantSwitch=true') ||
  !msaaCustom.output.includes('dawnReadbackSha256=') ||
  msaaCustomFalsifier.status !== 0 ||
  !msaaCustomFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaCustomFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaCustomFalsifier.output.includes('dawnReadbackSha256=')
) {
  console.error('[m3-programmable] custom pipeline MSAA graph: FAIL - MSAA resolve/replay falsifier leg did not pass');
  failSmoke();
}
let msaaPixelDelta;
try {
  msaaPixelDelta = comparePngs(
    resolve(msaaCustomArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaCustomArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA pixel delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaPixelDelta.changedPixels === 0 || msaaPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA pixel delta: FAIL - changedPixels=${msaaPixelDelta.changedPixels} meanRgbDelta=${msaaPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA graph: PASS changedPixels=${msaaPixelDelta.changedPixels} changedFraction=${msaaPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaPixelDelta.meanRgbDelta.toFixed(4)}`,
);
let msaaDawnReadbackDelta;
try {
  msaaDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaCustomArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaCustomArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaCustomArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaCustomArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA Dawn readback delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaDawnReadbackDelta.changedPixels === 0 || msaaDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA Dawn readback delta: FAIL - changedPixels=${msaaDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA Dawn readback: PASS changedPixels=${msaaDawnReadbackDelta.changedPixels} changedFraction=${msaaDawnReadbackDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaDawnReadbackDelta.normalSha256} falsifierSha256=${msaaDawnReadbackDelta.falsifierSha256}`,
);

const msaaRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-repeatability');
const msaaRepeatNormal = run(
  'custom pipeline MSAA repeatability normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaRepeatArtifactRoot, 'normal'),
  },
);
const msaaRepeatFalsifier = run(
  'custom pipeline MSAA repeatability falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaRepeatArtifactRoot, 'falsifier'),
  },
);
if (msaaRepeatNormal.status !== 0 || msaaRepeatFalsifier.status !== 0) {
  console.error('[m3-programmable] custom pipeline MSAA repeatability: FAIL - repeated normal/falsifier leg did not pass');
  failSmoke();
}
const firstNormalReadback = readDawnReadbackMetadata(resolve(msaaCustomArtifactRoot, 'normal', 'dawn-readback.json'));
const repeatNormalReadback = readDawnReadbackMetadata(resolve(msaaRepeatArtifactRoot, 'normal', 'dawn-readback.json'));
const firstFalsifierReadback = readDawnReadbackMetadata(resolve(msaaCustomArtifactRoot, 'falsifier', 'dawn-readback.json'));
const repeatFalsifierReadback = readDawnReadbackMetadata(resolve(msaaRepeatArtifactRoot, 'falsifier', 'dawn-readback.json'));
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

const msaaTrueVariantArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant');
const msaaTrueVariant = run(
  'custom pipeline MSAA true variant',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantArtifactRoot, 'normal'),
  },
);
const msaaTrueVariantFalsifier = run(
  'custom pipeline MSAA true variant falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantArtifactRoot, 'falsifier'),
  },
);
const msaaTrueVariantCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaTrueVariantFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
if (
  msaaTrueVariant.status !== 0 ||
  !msaaTrueVariant.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaTrueVariant.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaTrueVariant.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariant.output.includes('draws=3') ||
  !msaaTrueVariant.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantFalsifier.status !== 0 ||
  !msaaTrueVariantFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaTrueVariantFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaTrueVariantCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaTrueVariantFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaTrueVariantFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa'
) {
  console.error('[m3-programmable] custom pipeline MSAA true variant: FAIL - initial true-variant MSAA combination did not pass');
  failSmoke();
}
let msaaTrueVariantPixelDelta;
try {
  msaaTrueVariantPixelDelta = comparePngs(
    resolve(msaaTrueVariantArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant pixel delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaTrueVariantPixelDelta.changedPixels === 0 || msaaTrueVariantPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant pixel delta: FAIL - changedPixels=${msaaTrueVariantPixelDelta.changedPixels} meanRgbDelta=${msaaTrueVariantPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaTrueVariantDawnReadbackDelta;
try {
  msaaTrueVariantDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaTrueVariantArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant Dawn readback delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaTrueVariantDawnReadbackDelta.changedPixels === 0 || msaaTrueVariantDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant Dawn readback delta: FAIL - changedPixels=${msaaTrueVariantDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaTrueVariantDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA true variant: PASS changedPixels=${msaaTrueVariantPixelDelta.changedPixels} changedFraction=${msaaTrueVariantPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaTrueVariantPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaTrueVariantDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaTrueVariantDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaTrueVariantDawnReadbackDelta.normalSha256} falsifierSha256=${msaaTrueVariantDawnReadbackDelta.falsifierSha256}`,
);

const msaaTrueVariantSwitchArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant-switch');
const msaaTrueVariantSwitch = run(
  'custom pipeline MSAA true variant live switch',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantSwitchArtifactRoot, 'normal'),
  },
);
const msaaTrueVariantSwitchFalsifier = run(
  'custom pipeline MSAA true variant live switch falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier'),
  },
);
const msaaTrueVariantSwitchCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaTrueVariantSwitchFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
if (
  msaaTrueVariantSwitch.status !== 0 ||
  !msaaTrueVariantSwitch.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueVariantSwitch.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaTrueVariantSwitch.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantSwitch.output.includes('draws=3') ||
  !msaaTrueVariantSwitch.output.includes('variantSwitch=true') ||
  !msaaTrueVariantSwitch.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantSwitchFalsifier.status !== 0 ||
  !msaaTrueVariantSwitchFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaTrueVariantSwitchFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantSwitchFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaTrueVariantSwitchCapture.selectedVariant !== 'true' ||
  msaaTrueVariantSwitchCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantSwitchCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaTrueVariantSwitchCapture.variantSwitchedAfterPipeline !== true ||
  msaaTrueVariantSwitchFalsifierCapture.selectedVariant !== 'true' ||
  msaaTrueVariantSwitchFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantSwitchFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaTrueVariantSwitchFalsifierCapture.variantSwitchedAfterPipeline !== true
) {
  console.error('[m3-programmable] custom pipeline MSAA true variant live switch: FAIL - initial true variant did not switch through the MSAA graph');
  failSmoke();
}
let msaaTrueVariantSwitchPixelDelta;
try {
  msaaTrueVariantSwitchPixelDelta = comparePngs(
    resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant live switch pixel delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaTrueVariantSwitchPixelDelta.changedPixels === 0 || msaaTrueVariantSwitchPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant live switch pixel delta: FAIL - changedPixels=${msaaTrueVariantSwitchPixelDelta.changedPixels} meanRgbDelta=${msaaTrueVariantSwitchPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaTrueVariantSwitchDawnReadbackDelta;
try {
  msaaTrueVariantSwitchDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaTrueVariantSwitchArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA true variant live switch Dawn readback delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaTrueVariantSwitchDawnReadbackDelta.changedPixels === 0 || msaaTrueVariantSwitchDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant live switch Dawn readback delta: FAIL - changedPixels=${msaaTrueVariantSwitchDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaTrueVariantSwitchDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA true variant live switch: PASS changedPixels=${msaaTrueVariantSwitchPixelDelta.changedPixels} changedFraction=${msaaTrueVariantSwitchPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaTrueVariantSwitchPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaTrueVariantSwitchDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaTrueVariantSwitchDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaTrueVariantSwitchDawnReadbackDelta.normalSha256} falsifierSha256=${msaaTrueVariantSwitchDawnReadbackDelta.falsifierSha256}`,
);

const msaaPipelineFalsifierArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-pipeline-falsifier');
const msaaPipelineNormal = run(
  'custom pipeline MSAA adjacent pipeline normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPipelineFalsifierArtifactRoot, 'normal'),
  },
);
const msaaPipelineFalsifier = run(
  'custom pipeline MSAA adjacent pipeline falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier'),
  },
);
const msaaPipelineNormalCapture = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaPipelineFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaPipelineNormalSummary = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaPipelineFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
const msaaPipelineNormalTopology = readRenderPassTopology(
  resolve(msaaPipelineFalsifierArtifactRoot, 'normal'),
);
const msaaPipelineFalsifierTopology = readRenderPassTopology(
  resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier'),
);
const msaaPipelineTopologyChanged =
  JSON.stringify(msaaPipelineNormalTopology) !== JSON.stringify(msaaPipelineFalsifierTopology);
if (
  msaaPipelineNormal.status !== 0 ||
  !msaaPipelineNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPipelineNormal.output.includes('msaaTextureResourceCount=2') ||
  !msaaPipelineNormal.output.includes('resolveTargetCount=1') ||
  !msaaPipelineNormal.output.includes('draws=3') ||
  !msaaPipelineNormal.output.includes('variantSwitch=true') ||
  !msaaPipelineNormal.output.includes('dawnReadbackSha256=') ||
  msaaPipelineFalsifier.status !== 0 ||
  !msaaPipelineFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPipelineFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaPipelineFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaPipelineFalsifier.output.includes('draws=2') ||
  !msaaPipelineFalsifier.output.includes('variantSwitch=true') ||
  !msaaPipelineFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaPipelineNormalCapture.selectedVariant !== 'true' ||
  msaaPipelineNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaPipelineNormalCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaPipelineNormalCapture.falsifyPipeline !== false ||
  msaaPipelineNormalCapture.variantSwitchedAfterPipeline !== true ||
  msaaPipelineFalsifierCapture.selectedVariant !== 'true' ||
  msaaPipelineFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaPipelineFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaPipelineFalsifierCapture.falsifyPipeline !== true ||
  msaaPipelineFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  msaaPipelineNormalSummary.resolveTargetCount !== 1 ||
  msaaPipelineNormalSummary.drawCount !== 3 ||
  msaaPipelineFalsifierSummary.resolveTargetCount !== 1 ||
  msaaPipelineFalsifierSummary.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA adjacent pipeline falsifier: FAIL - pipeline-selection fault did not preserve MSAA resolve while changing topology: ${JSON.stringify({ normal: msaaPipelineNormalTopology, falsifier: msaaPipelineFalsifierTopology })}`,
  );
  failSmoke();
}
let msaaPipelinePixelDelta;
try {
  msaaPipelinePixelDelta = comparePngs(
    resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA adjacent pipeline PNG delta: FAIL - ${error}`);
  failSmoke();
}
let msaaPipelineDawnReadbackDelta;
try {
  msaaPipelineDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaPipelineFalsifierArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaPipelineDawnReadbackDelta.width !== 640 || msaaPipelineDawnReadbackDelta.height !== 360) {
  console.error(
    `[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn readback: FAIL - dimensions=${msaaPipelineDawnReadbackDelta.width}x${msaaPipelineDawnReadbackDelta.height}`,
  );
  failSmoke();
}
// Use inversion for this adjacent-pipeline probe so suppressing the feature-host
// stage is observable in both the live screenshot and fresh-device replay.
if (
  msaaPipelineDawnReadbackDelta.changedPixels === 0 ||
  msaaPipelineDawnReadbackDelta.normalSha256 === msaaPipelineDawnReadbackDelta.falsifierSha256
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA adjacent pipeline Dawn delta: FAIL - changedPixels=${msaaPipelineDawnReadbackDelta.changedPixels} normalSha256=${msaaPipelineDawnReadbackDelta.normalSha256} falsifierSha256=${msaaPipelineDawnReadbackDelta.falsifierSha256}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA adjacent pipeline: PASS normalResolve=${msaaPipelineNormalSummary.resolveTargetCount} falsifierResolve=${msaaPipelineFalsifierSummary.resolveTargetCount} normalDraws=${msaaPipelineNormalSummary.drawCount} falsifierDraws=${msaaPipelineFalsifierSummary.drawCount} browserChangedPixels=${msaaPipelinePixelDelta.changedPixels} browserMeanRgbDelta=${msaaPipelinePixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaPipelineDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaPipelineDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaPipelineDawnReadbackDelta.normalSha256} falsifierSha256=${msaaPipelineDawnReadbackDelta.falsifierSha256}`,
);

const msaaTrueVariantPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-variant-pipeline-repeatability');
const msaaTrueVariantPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaTrueVariantPipelineRepeatArtifactRoot, pass);
  msaaTrueVariantPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA true variant pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA true variant pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaTrueVariantPipelineRepeatSnapshots = msaaTrueVariantPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueVariantPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueVariantPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaTrueVariantPipelineRepeatFirst, msaaTrueVariantPipelineRepeatSecond] = msaaTrueVariantPipelineRepeatSnapshots;
const msaaTrueVariantPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot,
  msaaTrueVariantPipelineRepeatSecond.normal.snapshot,
);
const msaaTrueVariantPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot,
  msaaTrueVariantPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaTrueVariantPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaTrueVariantPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  !msaaTrueVariantPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  msaaTrueVariantPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaTrueVariantPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaTrueVariantPipelineRepeatNormalDiff !== undefined ||
  msaaTrueVariantPipelineRepeatFalsifierDiff !== undefined ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueVariantPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true variant pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaTrueVariantPipelineRepeatFirst.normal.result.status, msaaTrueVariantPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaTrueVariantPipelineRepeatFirst.falsifier.result.status, msaaTrueVariantPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaTrueVariantPipelineRepeatNormalDiff, falsifierDiff: msaaTrueVariantPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA true variant pipeline repeatability: PASS normalSha256=${msaaTrueVariantPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaTrueVariantPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaTrueVariantPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaTrueInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-true-inversion-pipeline-repeatability');
const msaaTrueInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaTrueInversionPipelineRepeatArtifactRoot, pass);
  msaaTrueInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA true inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA true inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaTrueInversionPipelineRepeatSnapshots = msaaTrueInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaTrueInversionPipelineRepeatFirst, msaaTrueInversionPipelineRepeatSecond] = msaaTrueInversionPipelineRepeatSnapshots;
const msaaTrueInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot,
  msaaTrueInversionPipelineRepeatSecond.normal.snapshot,
);
const msaaTrueInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot,
  msaaTrueInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaTrueInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  !msaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  msaaTrueInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaTrueInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaTrueInversionPipelineRepeatNormalDiff !== undefined ||
  msaaTrueInversionPipelineRepeatFalsifierDiff !== undefined ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.variant !== 'M3_MULTI_UV_VARIANT=false' ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA true inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaTrueInversionPipelineRepeatFirst.normal.result.status, msaaTrueInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaTrueInversionPipelineRepeatFirst.falsifier.result.status, msaaTrueInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaTrueInversionPipelineRepeatNormalDiff, falsifierDiff: msaaTrueInversionPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA true inversion pipeline repeatability: PASS normalSha256=${msaaTrueInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaTrueInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaFalsePassthroughPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-false-passthrough-pipeline-repeatability');
const msaaFalsePassthroughPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalsePassthroughPipelineRepeatArtifactRoot, pass);
  msaaFalsePassthroughPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA false passthrough pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalsePassthroughPipelineRepeatSnapshots = msaaFalsePassthroughPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaFalsePassthroughPipelineRepeatFirst, msaaFalsePassthroughPipelineRepeatSecond] = msaaFalsePassthroughPipelineRepeatSnapshots;
const msaaFalsePassthroughPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot,
  msaaFalsePassthroughPipelineRepeatSecond.normal.snapshot,
);
const msaaFalsePassthroughPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot,
  msaaFalsePassthroughPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaFalsePassthroughPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS -') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=false') ||
  !msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=false') ||
  msaaFalsePassthroughPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaFalsePassthroughPipelineRepeatNormalDiff !== undefined ||
  msaaFalsePassthroughPipelineRepeatFalsifierDiff !== undefined ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA false passthrough pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaFalsePassthroughPipelineRepeatFirst.normal.result.status, msaaFalsePassthroughPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaFalsePassthroughPipelineRepeatFirst.falsifier.result.status, msaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaFalsePassthroughPipelineRepeatNormalDiff, falsifierDiff: msaaFalsePassthroughPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA false passthrough pipeline repeatability: PASS normalSha256=${msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaFalseInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-false-inversion-pipeline-repeatability');
const msaaFalseInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalseInversionPipelineRepeatArtifactRoot, pass);
  msaaFalseInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA false inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalseInversionPipelineRepeatSnapshots = msaaFalseInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaFalseInversionPipelineRepeatFirst, msaaFalseInversionPipelineRepeatSecond] = msaaFalseInversionPipelineRepeatSnapshots;
const msaaFalseInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot,
  msaaFalseInversionPipelineRepeatSecond.normal.snapshot,
);
const msaaFalseInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot,
  msaaFalseInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaFalseInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS -') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=false') ||
  !msaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=false') ||
  msaaFalseInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaFalseInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaFalseInversionPipelineRepeatNormalDiff !== undefined ||
  msaaFalseInversionPipelineRepeatFalsifierDiff !== undefined ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA false inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaFalseInversionPipelineRepeatFirst.normal.result.status, msaaFalseInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaFalseInversionPipelineRepeatFirst.falsifier.result.status, msaaFalseInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaFalseInversionPipelineRepeatNormalDiff, falsifierDiff: msaaFalseInversionPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA false inversion pipeline repeatability: PASS normalSha256=${msaaFalseInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaFalseInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaFalseInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-false-inversion-pipeline-repeatability');
const noMsaaFalseInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaFalseInversionPipelineRepeatArtifactRoot, pass);
  noMsaaFalseInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA false inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaFalseInversionPipelineRepeatSnapshots = noMsaaFalseInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalseInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaFalseInversionPipelineRepeatFirst, noMsaaFalseInversionPipelineRepeatSecond] = noMsaaFalseInversionPipelineRepeatSnapshots;
const noMsaaFalseInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot,
  noMsaaFalseInversionPipelineRepeatSecond.normal.snapshot,
);
const noMsaaFalseInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot,
  noMsaaFalseInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaFalseInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaFalseInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaFalseInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaFalseInversionPipelineRepeatNormalDiff !== undefined ||
  noMsaaFalseInversionPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA false inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaFalseInversionPipelineRepeatFirst.normal.result.status, noMsaaFalseInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaFalseInversionPipelineRepeatFirst.falsifier.result.status, noMsaaFalseInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaFalseInversionPipelineRepeatNormalDiff, falsifierDiff: noMsaaFalseInversionPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA false inversion pipeline repeatability: PASS normalSha256=${noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaFalseInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaFalseInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaTrueInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-true-inversion-pipeline-repeatability');
const noMsaaTrueInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaTrueInversionPipelineRepeatArtifactRoot, pass);
  noMsaaTrueInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA true inversion pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA true inversion pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaTrueInversionPipelineRepeatSnapshots = noMsaaTrueInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTrueInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaTrueInversionPipelineRepeatFirst, noMsaaTrueInversionPipelineRepeatSecond] = noMsaaTrueInversionPipelineRepeatSnapshots;
const noMsaaTrueInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot,
  noMsaaTrueInversionPipelineRepeatSecond.normal.snapshot,
);
const noMsaaTrueInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot,
  noMsaaTrueInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaTrueInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaTrueInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaTrueInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaTrueInversionPipelineRepeatNormalDiff !== undefined ||
  noMsaaTrueInversionPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA true inversion pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaTrueInversionPipelineRepeatFirst.normal.result.status, noMsaaTrueInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaTrueInversionPipelineRepeatFirst.falsifier.result.status, noMsaaTrueInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaTrueInversionPipelineRepeatNormalDiff, falsifierDiff: noMsaaTrueInversionPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA true inversion pipeline repeatability: PASS normalSha256=${noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaTrueInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaTrueInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaTruePassthroughPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-true-passthrough-pipeline-repeatability');
const noMsaaTruePassthroughPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaTruePassthroughPipelineRepeatArtifactRoot, pass);
  noMsaaTruePassthroughPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA true passthrough pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA true passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaTruePassthroughPipelineRepeatSnapshots = noMsaaTruePassthroughPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTruePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaTruePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaTruePassthroughPipelineRepeatFirst, noMsaaTruePassthroughPipelineRepeatSecond] = noMsaaTruePassthroughPipelineRepeatSnapshots;
const noMsaaTruePassthroughPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot,
  noMsaaTruePassthroughPipelineRepeatSecond.normal.snapshot,
);
const noMsaaTruePassthroughPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot,
  noMsaaTruePassthroughPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaTruePassthroughPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaTruePassthroughPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaTruePassthroughPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaTruePassthroughPipelineRepeatNormalDiff !== undefined ||
  noMsaaTruePassthroughPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA true passthrough pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaTruePassthroughPipelineRepeatFirst.normal.result.status, noMsaaTruePassthroughPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaTruePassthroughPipelineRepeatFirst.falsifier.result.status, noMsaaTruePassthroughPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaTruePassthroughPipelineRepeatNormalDiff, falsifierDiff: noMsaaTruePassthroughPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA true passthrough pipeline repeatability: PASS normalSha256=${noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaTruePassthroughPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaTruePassthroughPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaFalsePassthroughPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-false-passthrough-pipeline-repeatability');
const noMsaaFalsePassthroughPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaFalsePassthroughPipelineRepeatArtifactRoot, pass);
  noMsaaFalsePassthroughPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA false passthrough pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false passthrough pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaFalsePassthroughPipelineRepeatSnapshots = noMsaaFalsePassthroughPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaFalsePassthroughPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaFalsePassthroughPipelineRepeatFirst, noMsaaFalsePassthroughPipelineRepeatSecond] = noMsaaFalsePassthroughPipelineRepeatSnapshots;
const noMsaaFalsePassthroughPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot,
  noMsaaFalsePassthroughPipelineRepeatSecond.normal.snapshot,
);
const noMsaaFalsePassthroughPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot,
  noMsaaFalsePassthroughPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaFalsePassthroughPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatNormalDiff !== undefined ||
  noMsaaFalsePassthroughPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA false passthrough pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaFalsePassthroughPipelineRepeatFirst.normal.result.status, noMsaaFalsePassthroughPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.result.status, noMsaaFalsePassthroughPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaFalsePassthroughPipelineRepeatNormalDiff, falsifierDiff: noMsaaFalsePassthroughPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA false passthrough pipeline repeatability: PASS normalSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaFalsePassthroughPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyFalsePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-false-passthrough-repeatability');
const noMsaaSteadyFalsePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyFalsePassthroughRepeatArtifactRoot, pass);
  noMsaaSteadyFalsePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady false passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady false passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyFalsePassthroughRepeatSnapshots = noMsaaSteadyFalsePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaSteadyFalsePassthroughRepeatFirst, noMsaaSteadyFalsePassthroughRepeatSecond] = noMsaaSteadyFalsePassthroughRepeatSnapshots;
const noMsaaSteadyFalsePassthroughRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot,
  noMsaaSteadyFalsePassthroughRepeatSecond.normal.snapshot,
);
const noMsaaSteadyFalsePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot,
  noMsaaSteadyFalsePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('draws=3') ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyFalsePassthroughRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatNormalDiff !== undefined ||
  noMsaaSteadyFalsePassthroughRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady false passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyFalsePassthroughRepeatFirst.normal.result.status, noMsaaSteadyFalsePassthroughRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status, noMsaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyFalsePassthroughRepeatNormalDiff, falsifierDiff: noMsaaSteadyFalsePassthroughRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady false passthrough repeatability: PASS normalSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyFalseInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-false-inversion-repeatability');
const noMsaaSteadyFalseInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyFalseInversionRepeatArtifactRoot, pass);
  noMsaaSteadyFalseInversionRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady false inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady false inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyFalseInversionRepeatSnapshots = noMsaaSteadyFalseInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [noMsaaSteadyFalseInversionRepeatFirst, noMsaaSteadyFalseInversionRepeatSecond] = noMsaaSteadyFalseInversionRepeatSnapshots;
const noMsaaSteadyFalseInversionRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot,
  noMsaaSteadyFalseInversionRepeatSecond.normal.snapshot,
);
const noMsaaSteadyFalseInversionRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot,
  noMsaaSteadyFalseInversionRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyFalseInversionRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('draws=3') ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyFalseInversionRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyFalseInversionRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyFalseInversionRepeatNormalDiff !== undefined ||
  noMsaaSteadyFalseInversionRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady false inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyFalseInversionRepeatFirst.normal.result.status, noMsaaSteadyFalseInversionRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyFalseInversionRepeatFirst.falsifier.result.status, noMsaaSteadyFalseInversionRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyFalseInversionRepeatNormalDiff, falsifierDiff: noMsaaSteadyFalseInversionRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady false inversion repeatability: PASS normalSha256=${noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyFalseInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyTruePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-true-passthrough-repeatability');
const noMsaaSteadyTruePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyTruePassthroughRepeatArtifactRoot, pass);
  noMsaaSteadyTruePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady true passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady true passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyTruePassthroughRepeatSnapshots = noMsaaSteadyTruePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [noMsaaSteadyTruePassthroughRepeatFirst, noMsaaSteadyTruePassthroughRepeatSecond] = noMsaaSteadyTruePassthroughRepeatSnapshots;
const noMsaaSteadyTruePassthroughRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot,
  noMsaaSteadyTruePassthroughRepeatSecond.normal.snapshot,
);
const noMsaaSteadyTruePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot,
  noMsaaSteadyTruePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyTruePassthroughRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('draws=3') ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyTruePassthroughRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyTruePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyTruePassthroughRepeatNormalDiff !== undefined ||
  noMsaaSteadyTruePassthroughRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady true passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyTruePassthroughRepeatFirst.normal.result.status, noMsaaSteadyTruePassthroughRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyTruePassthroughRepeatFirst.falsifier.result.status, noMsaaSteadyTruePassthroughRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyTruePassthroughRepeatNormalDiff, falsifierDiff: noMsaaSteadyTruePassthroughRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady true passthrough repeatability: PASS normalSha256=${noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyTruePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaSteadyTrueInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-steady-true-inversion-repeatability');
const noMsaaSteadyTrueInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaSteadyTrueInversionRepeatArtifactRoot, pass);
  noMsaaSteadyTrueInversionRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA steady true inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA steady true inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaSteadyTrueInversionRepeatSnapshots = noMsaaSteadyTrueInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(noMsaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [noMsaaSteadyTrueInversionRepeatFirst, noMsaaSteadyTrueInversionRepeatSecond] = noMsaaSteadyTrueInversionRepeatSnapshots;
const noMsaaSteadyTrueInversionRepeatNormalDiff = repeatabilityDiff(
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot,
  noMsaaSteadyTrueInversionRepeatSecond.normal.snapshot,
);
const noMsaaSteadyTrueInversionRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot,
  noMsaaSteadyTrueInversionRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaSteadyTrueInversionRepeatFirst.normal.result.status !== 0 ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('draws=3') ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('draws=2') ||
  noMsaaSteadyTrueInversionRepeatSecond.normal.result.status !== 0 ||
  noMsaaSteadyTrueInversionRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaSteadyTrueInversionRepeatNormalDiff !== undefined ||
  noMsaaSteadyTrueInversionRepeatFalsifierDiff !== undefined ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA steady true inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaSteadyTrueInversionRepeatFirst.normal.result.status, noMsaaSteadyTrueInversionRepeatSecond.normal.result.status], falsifierStatus: [noMsaaSteadyTrueInversionRepeatFirst.falsifier.result.status, noMsaaSteadyTrueInversionRepeatSecond.falsifier.result.status], normalDiff: noMsaaSteadyTrueInversionRepeatNormalDiff, falsifierDiff: noMsaaSteadyTrueInversionRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA steady true inversion repeatability: PASS normalSha256=${noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaSteadyTrueInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);
}
