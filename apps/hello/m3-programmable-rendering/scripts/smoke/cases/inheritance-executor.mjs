import {
  failSmoke,
  readLiveMaterialSnapshotIfAvailable,
  repeatabilityDiff,
  repoRoot,
  run,
} from '../lib/runtime.mjs';
import { resolve } from 'node:path';

export function runComposedInheritanceStartRepeatability({ msaa, startVariant }) {
  const switchedVariant = startVariant === 'true' ? 'false' : 'true';
  const mode = msaa ? 'msaa' : 'no-msaa';
  const modeLabel = msaa ? 'MSAA' : 'no-MSAA';
  const artifactRoot = resolve(
    process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
    `inheritance-live-material-composed-${mode}-start-${startVariant}-repeatability`,
  );
  const runs = [];
  for (const pass of ['first', 'second']) {
    const artifactDir = resolve(artifactRoot, pass);
    runs.push({
      pass,
      result: run(
        `browser composed inherited material ${modeLabel} startup-${startVariant} rebind ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
        {
          FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
          FORGEAX_M3_LIVE_VARIANT_SWITCH: '1',
          FORGEAX_M3_MSAA: msaa ? '1' : '0',
          FORGEAX_M3_START_VARIANT: startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: artifactDir,
        },
      ),
      snapshot: readLiveMaterialSnapshotIfAvailable(artifactDir),
    });
  }
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      runResult.snapshot === undefined ||
      !runResult.result.output.includes(`[m3-live-material] PASS pipeline=custom post=inversion msaa=${msaa} startVariant=${startVariant} variantSwitch=true`) ||
      !runResult.result.output.includes('normalSlots=true/true') ||
      !runResult.result.output.includes('falsifierSlots=false/false') ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} ${runResult.pass}: FAIL`);
      failSmoke();
    }
  }
  const first = runs[0].snapshot;
  const second = runs[1].snapshot;
  if (repeatabilityDiff(first, second) !== undefined) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} repeatability: FAIL - ${JSON.stringify({ first, second })}`,
    );
    failSmoke();
  }
  const expectedRenderedVariant = `M3_MULTI_UV_VARIANT=${switchedVariant}`;
  for (const [leg, value] of Object.entries(first)) {
    if (
      value.before.variant !== expectedRenderedVariant ||
      value.after.variant !== expectedRenderedVariant ||
      value.after.pipeline !== 'M3_PIPELINE=custom' ||
      value.after.post !== 'M3_POST_EFFECT=inversion' ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.rhiTopology.msaaTextureResourceCount !== (msaa ? 2 : 0) ||
      value.rhiTopology.resolveTargetCount !== (msaa ? 1 : 0) ||
      value.draws !== 3 ||
      value.inspectedWork === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} ${leg} topology: FAIL - ${JSON.stringify(value)}`);
      failSmoke();
    }
  }
  const normal = first.normal;
  const falsifier = first.falsifier;
  if (
    normal.afterEvidence.inheritanceBacked !== true ||
    normal.afterEvidence.baseColorSlotChanged !== true ||
    normal.afterEvidence.detailSlotChanged !== true ||
    normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    normal.afterEvidence.sourceRootArtifactDigest !== normal.afterEvidence.sourceArtifactDigest ||
    normal.afterEvidence.sourceRootCookInputDigest !== normal.afterEvidence.sourceCookInputDigest ||
    normal.delta.changed < 1000 ||
    falsifier.afterEvidence.inheritanceBacked !== true ||
    falsifier.afterEvidence.baseColorSlotChanged !== false ||
    falsifier.afterEvidence.detailSlotChanged !== false ||
    falsifier.afterEvidence.falsifierMarker !== 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' ||
    falsifier.delta.changed !== 0
  ) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} oracle: FAIL - ${JSON.stringify(first)}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} repeatability: PASS normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} dawnSha=${normal.dawn.sha256}`,
  );
}
export function runComposedInheritancePipelineFalsifierRepeatability({ msaa, startVariant }) {
  const switchedVariant = startVariant === 'true' ? 'false' : 'true';
  const mode = msaa ? 'msaa' : 'no-msaa';
  const modeLabel = msaa ? 'MSAA' : 'no-MSAA';
  const artifactRoot = resolve(
    process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
    `inheritance-live-material-composed-${mode}-start-${startVariant}-pipeline-falsifier-repeatability`,
  );
  const runs = [];
  for (const pass of ['first', 'second']) {
    const artifactDir = resolve(artifactRoot, pass);
    runs.push({
      pass,
      result: run(
        `browser composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
        {
          FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
          FORGEAX_M3_INHERITANCE_FALSIFIER_KIND: 'pipeline',
          FORGEAX_M3_LIVE_VARIANT_SWITCH: '1',
          FORGEAX_M3_MSAA: msaa ? '1' : '0',
          FORGEAX_M3_START_VARIANT: startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: artifactDir,
        },
      ),
      snapshot: readLiveMaterialSnapshotIfAvailable(artifactDir),
    });
  }
  for (const runResult of runs) {
    if (
      runResult.result.status !== 0 ||
      runResult.snapshot === undefined ||
      !runResult.result.output.includes(`[m3-live-material] PASS pipeline=custom post=inversion msaa=${msaa} startVariant=${startVariant} variantSwitch=true falsifier=pipeline`) ||
      !runResult.result.output.includes('normalSlots=true/true') ||
      !runResult.result.output.includes('falsifierSlots=true/true') ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier ${runResult.pass}: FAIL`);
      failSmoke();
    }
  }
  const first = runs[0].snapshot;
  const second = runs[1].snapshot;
  if (repeatabilityDiff(first, second) !== undefined) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier repeatability: FAIL - ${JSON.stringify({ first, second })}`,
    );
    failSmoke();
  }
  for (const [leg, value] of Object.entries(first)) {
    if (
      value.before.variant !== `M3_MULTI_UV_VARIANT=${switchedVariant}` ||
      value.after.variant !== `M3_MULTI_UV_VARIANT=${switchedVariant}` ||
      value.after.pipeline !== 'M3_PIPELINE=custom' ||
      value.after.post !== 'M3_POST_EFFECT=inversion' ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.rhiTopology.msaaTextureResourceCount !== (msaa ? (2) : 0) ||
      value.rhiTopology.resolveTargetCount !== (msaa ? 1 : 0) ||
      value.draws !== (leg === 'normal' ? 3 : 2) ||
      value.inspectedWork === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier ${leg}: FAIL - ${JSON.stringify(value)}`);
      failSmoke();
    }
  }
  const normal = first.normal;
  const falsifier = first.falsifier;
  if (
    normal.afterEvidence.inheritanceBacked !== true ||
    normal.afterEvidence.baseColorSlotChanged !== true ||
    normal.afterEvidence.detailSlotChanged !== true ||
    normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    normal.delta.changed < 1000 ||
    falsifier.afterEvidence.inheritanceBacked !== true ||
    falsifier.afterEvidence.baseColorSlotChanged !== true ||
    falsifier.afterEvidence.detailSlotChanged !== true ||
    falsifier.afterEvidence.falsifierMarker !== null ||
    falsifier.delta.changed < 1000 ||
    normal.dawn.sha256 === falsifier.dawn.sha256
  ) {
    console.error(
      `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier oracle: FAIL - ${JSON.stringify(first)}`,
    );
    failSmoke();
  }
  console.log(
    `[m3-programmable] composed inherited material ${modeLabel} startup-${startVariant} pipeline falsifier repeatability: PASS normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} draws=${normal.draws}/${falsifier.draws} dawnSha=${normal.dawn.sha256}/${falsifier.dawn.sha256}`,
  );
}

const composedResizeHistory = '640x360>480x270>720x405>640x360>480x270>720x405>640x360';

// Derived facts of one inherited-material post scenario; every phase below
// reads the same description instead of re-deriving it from `falsifierKind`.
function describePostScenario({ msaa, startVariant, post, falsifierKind }) {
  const mode = msaa ? 'msaa' : 'no-msaa';
  const reversePipelineFalsifier =
    falsifierKind === 'reverse-pipeline' || falsifierKind === 'reverse-pipeline-texture';
  return {
    msaa,
    startVariant,
    post,
    falsifierKind,
    mode,
    depthPost: post === 'depth',
    pipelineFalsifier:
      falsifierKind === 'pipeline' || falsifierKind === 'pipeline-texture' || reversePipelineFalsifier,
    textureSlotFalsifier:
      falsifierKind === 'texture' ||
      falsifierKind === 'pipeline-texture' ||
      falsifierKind === 'reverse-pipeline-texture',
    parameterFalsifier: falsifierKind === 'param',
    expectedPipeline: reversePipelineFalsifier ? 'standard' : 'custom',
    passLabel: falsifierKind === 'texture' ? mode : `${mode} ${falsifierKind} falsifier`,
  };
}

function postScenarioArtifactRoot(scenario) {
  const artifactSuffix = scenario.falsifierKind === 'texture' ? '' : `-${scenario.falsifierKind}-falsifier`;
  const postSegment = scenario.depthPost ? 'depth-post' : `${scenario.post}-post`;
  return resolve(
    process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
    `inheritance-${postSegment}-composed-${scenario.mode}-start-${scenario.startVariant}${artifactSuffix}-repeatability`,
  );
}

function runPostScenarioPasses(scenario) {
  const artifactRoot = postScenarioArtifactRoot(scenario);
  const runs = [];
  for (const pass of ['first', 'second']) {
    const artifactDir = resolve(artifactRoot, pass);
    runs.push({
      pass,
      result: run(
        `browser inherited material ${scenario.post} post ${scenario.mode} startup-${scenario.startVariant} ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
        {
          FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
          FORGEAX_M3_INHERITANCE_POST: scenario.post,
          FORGEAX_M3_INHERITANCE_DEPTH_POST: scenario.depthPost ? '1' : '0',
          FORGEAX_M3_INHERITANCE_FALSIFIER_KIND: scenario.falsifierKind,
          FORGEAX_M3_LIVE_VARIANT_SWITCH: '1',
          FORGEAX_M3_MSAA: scenario.msaa ? '1' : '0',
          FORGEAX_M3_START_VARIANT: scenario.startVariant,
          FORGEAX_M3_RESIZE_CHURN: '1',
          FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
          FORGEAX_M3_ARTIFACT_DIR: artifactDir,
        },
      ),
      snapshot: readLiveMaterialSnapshotIfAvailable(artifactDir),
    });
  }
  return runs;
}

function postPassOutputHolds(runResult, scenario) {
  const { output } = runResult.result;
  const { parameterFalsifier } = scenario;
  return (
    runResult.result.status === 0 &&
    runResult.snapshot !== undefined &&
    output.includes(
      `[m3-live-material] PASS pipeline=${scenario.expectedPipeline} post=${scenario.post} msaa=${scenario.msaa} startVariant=${scenario.startVariant} variantSwitch=true falsifier=${scenario.falsifierKind}`,
    ) &&
    output.includes(`normalSlots=${parameterFalsifier ? 'false/false' : 'true/true'}`) &&
    output.includes(
      `falsifierSlots=${parameterFalsifier || scenario.textureSlotFalsifier ? 'false/false' : 'true/true'}`,
    ) &&
    (!parameterFalsifier || output.includes('normalParams=true/true falsifierParams=false/false')) &&
    output.includes(`resizeHistory=${composedResizeHistory}`)
  );
}

function requirePostPassOutputs(runs, scenario) {
  for (const runResult of runs) {
    if (!postPassOutputHolds(runResult, scenario)) {
      console.error(
        `[m3-programmable] inherited material ${scenario.post} post ${scenario.passLabel} startup-${scenario.startVariant} ${runResult.pass}: FAIL`,
      );
      failSmoke();
    }
  }
}

function postLegTopologyHolds(leg, value, scenario) {
  const { msaa, pipelineFalsifier } = scenario;
  const expectedRenderedVariant = `M3_MULTI_UV_VARIANT=${scenario.startVariant === 'true' ? 'false' : 'true'}`;
  return (
    value.before.variant === expectedRenderedVariant &&
    value.after.variant === expectedRenderedVariant &&
    value.after.pipeline === `M3_PIPELINE=${scenario.expectedPipeline}` &&
    value.after.post === `M3_POST_EFFECT=${scenario.post}` &&
    value.afterEvidence.resizeHistory.join('>') === composedResizeHistory &&
    value.rhiTopology.msaaTextureResourceCount === (msaa ? 2 : 0) &&
    value.rhiTopology.resolveTargetCount === (msaa ? 1 : 0) &&
    value.rhiTopology.hasDepthBinding === (scenario.depthPost && (pipelineFalsifier ? leg === 'normal' : true)) &&
    value.draws === (pipelineFalsifier && leg === 'falsifier' ? 2 : 3) &&
    value.inspectedWork !== undefined &&
    value.dawn.nonBlackPixelCount !== 0
  );
}

function requirePostTopology(first, scenario) {
  for (const [leg, value] of Object.entries(first)) {
    if (!postLegTopologyHolds(leg, value, scenario)) {
      console.error(
        `[m3-programmable] inherited material ${scenario.post} post ${scenario.passLabel} ${leg} topology: FAIL - ${JSON.stringify(value)}`,
      );
      failSmoke();
    }
  }
}

function normalRebindHolds(normal, parameterFalsifier) {
  const evidence = normal.afterEvidence;
  const rebound = parameterFalsifier
    ? evidence.baseColorParameterChanged === true && evidence.baseColorUvTransformChanged === true
    : evidence.baseColorSlotChanged === true && evidence.detailSlotChanged === true;
  return (
    evidence.inheritanceBacked === true &&
    rebound &&
    evidence.afterComponentMaterialMatchesAfter === true &&
    normal.delta.changed >= 1000
  );
}

function textureRebindRejected(falsifier) {
  return (
    falsifier.afterEvidence.baseColorSlotChanged === false &&
    falsifier.afterEvidence.detailSlotChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' &&
    falsifier.delta.changed === 0
  );
}

function parameterRebindRejected(normal, falsifier) {
  return (
    falsifier.afterEvidence.baseColorParameterChanged === false &&
    falsifier.afterEvidence.baseColorUvTransformChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-parameters' &&
    falsifier.delta.changed === 0 &&
    normal.draws === falsifier.draws
  );
}

function pipelineRebindDiverges(normal, falsifier, post) {
  return (
    falsifier.afterEvidence.baseColorSlotChanged === true &&
    falsifier.afterEvidence.detailSlotChanged === true &&
    falsifier.afterEvidence.falsifierMarker === null &&
    falsifier.delta.changed >= 1000 &&
    normal.rhiTopology.passCount !== falsifier.rhiTopology.passCount &&
    (post === 'passthrough' || normal.dawn.sha256 !== falsifier.dawn.sha256)
  );
}

// `pipeline-texture` and `reverse-pipeline-texture` reject the texture rebind
// while their adjacent pipeline still changes the rendered passes and pixels.
function falsifierOracleHolds(normal, falsifier, scenario) {
  if (scenario.parameterFalsifier) return parameterRebindRejected(normal, falsifier);
  if (scenario.pipelineFalsifier && scenario.textureSlotFalsifier) {
    return (
      textureRebindRejected(falsifier) &&
      normal.dawn.sha256 !== falsifier.dawn.sha256 &&
      normal.rhiTopology.passCount !== falsifier.rhiTopology.passCount
    );
  }
  if (scenario.pipelineFalsifier) return pipelineRebindDiverges(normal, falsifier, scenario.post);
  return textureRebindRejected(falsifier);
}

export function runComposedInheritancePostRepeatability({ msaa, startVariant, post = 'depth', falsifierKind = 'texture' }) {
  const scenario = describePostScenario({ msaa, startVariant, post, falsifierKind });
  const runs = runPostScenarioPasses(scenario);
  requirePostPassOutputs(runs, scenario);
  const first = runs[0].snapshot;
  const second = runs[1].snapshot;
  if (repeatabilityDiff(first, second) !== undefined) {
    console.error(`[m3-programmable] inherited material ${post} post ${scenario.passLabel} repeatability: FAIL - ${JSON.stringify({ first, second })}`);
    failSmoke();
  }
  requirePostTopology(first, scenario);
  const normal = first.normal;
  const falsifier = first.falsifier;
  if (
    !normalRebindHolds(normal, scenario.parameterFalsifier) ||
    falsifier.afterEvidence.inheritanceBacked !== true ||
    !falsifierOracleHolds(normal, falsifier, scenario)
  ) {
    console.error(`[m3-programmable] inherited material ${post} post ${scenario.passLabel} oracle: FAIL - ${JSON.stringify(first)}`);
    failSmoke();
  }
  console.log(
    `[m3-programmable] inherited material ${post} post ${scenario.passLabel} startup-${startVariant} repeatability: PASS normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} dawnSha=${normal.dawn.sha256}`,
  );
}
