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

export function runComposedInheritancePostRepeatability({ msaa, startVariant, post = 'depth', falsifierKind = 'texture' }) {
  const mode = msaa ? 'msaa' : 'no-msaa';
  const depthPost = post === 'depth';
  const pipelineFalsifier =
    falsifierKind === 'pipeline' ||
    falsifierKind === 'pipeline-texture' ||
    falsifierKind === 'reverse-pipeline' ||
    falsifierKind === 'reverse-pipeline-texture';
  const reversePipelineFalsifier =
    falsifierKind === 'reverse-pipeline' || falsifierKind === 'reverse-pipeline-texture';
  const textureSlotFalsifier =
    falsifierKind === 'texture' ||
    falsifierKind === 'pipeline-texture' ||
    falsifierKind === 'reverse-pipeline-texture';
  const parameterFalsifier = falsifierKind === 'param';
  const expectedPipeline = reversePipelineFalsifier ? 'standard' : 'custom';
  const passLabel = falsifierKind === 'texture' ? mode : `${mode} ${falsifierKind} falsifier`;
  const artifactSuffix = falsifierKind === 'texture' ? '' : `-${falsifierKind}-falsifier`;
  const artifactRoot = resolve(
    process.env.FORGEAX_M3_ARTIFACT_DIR ?? resolve(repoRoot, '.forgeax-gauntlet', 'hello-m3-programmable-rendering'),
    `inheritance-${depthPost ? 'depth-post' : `${post}-post`}-composed-${mode}-start-${startVariant}${artifactSuffix}-repeatability`,
  );
  const runs = [];
  for (const pass of ['first', 'second']) {
    const artifactDir = resolve(artifactRoot, pass);
    runs.push({
      pass,
      result: run(
        `browser inherited material ${post} post ${mode} startup-${startVariant} ${pass}`,
        ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-composed'],
        {
          FORGEAX_M3_INHERITANCE_LIVE_MATERIAL: '1',
          FORGEAX_M3_INHERITANCE_POST: post,
          FORGEAX_M3_INHERITANCE_DEPTH_POST: depthPost ? '1' : '0',
          FORGEAX_M3_INHERITANCE_FALSIFIER_KIND: falsifierKind,
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
      !runResult.result.output.includes(
        `[m3-live-material] PASS pipeline=${expectedPipeline} post=${post} msaa=${msaa} startVariant=${startVariant} variantSwitch=true falsifier=${falsifierKind}`,
      ) ||
      !runResult.result.output.includes(
        `normalSlots=${parameterFalsifier ? 'false/false' : 'true/true'}`,
      ) ||
      !runResult.result.output.includes(
        `falsifierSlots=${parameterFalsifier || textureSlotFalsifier ? 'false/false' : 'true/true'}`,
      ) ||
      (parameterFalsifier && !runResult.result.output.includes('normalParams=true/true falsifierParams=false/false')) ||
      !runResult.result.output.includes('resizeHistory=640x360>480x270>720x405>640x360>480x270>720x405>640x360')
    ) {
      console.error(`[m3-programmable] inherited material ${post} post ${passLabel} startup-${startVariant} ${runResult.pass}: FAIL`);
      failSmoke();
    }
  }
  const first = runs[0].snapshot;
  const second = runs[1].snapshot;
  if (repeatabilityDiff(first, second) !== undefined) {
    console.error(`[m3-programmable] inherited material ${post} post ${passLabel} repeatability: FAIL - ${JSON.stringify({ first, second })}`);
    failSmoke();
  }
  const expectedRenderedVariant = `M3_MULTI_UV_VARIANT=${startVariant === 'true' ? 'false' : 'true'}`;
  for (const [leg, value] of Object.entries(first)) {
    if (
      value.before.variant !== expectedRenderedVariant ||
      value.after.variant !== expectedRenderedVariant ||
      value.after.pipeline !== `M3_PIPELINE=${expectedPipeline}` ||
      value.after.post !== `M3_POST_EFFECT=${post}` ||
      value.afterEvidence.resizeHistory.join('>') !== '640x360>480x270>720x405>640x360>480x270>720x405>640x360' ||
      value.rhiTopology.msaaTextureResourceCount !== (msaa ? 2 : 0) ||
      value.rhiTopology.resolveTargetCount !== (msaa ? 1 : 0) ||
      value.rhiTopology.hasDepthBinding !== (depthPost && (pipelineFalsifier ? leg === 'normal' : true)) ||
      value.draws !== (pipelineFalsifier && leg === 'falsifier' ? 2 : 3) ||
      value.inspectedWork === undefined ||
      value.dawn.nonBlackPixelCount === 0
    ) {
      console.error(`[m3-programmable] inherited material ${post} post ${passLabel} ${leg} topology: FAIL - ${JSON.stringify(value)}`);
      failSmoke();
    }
  }
  const normal = first.normal;
  const falsifier = first.falsifier;
  const textureFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === false &&
    falsifier.afterEvidence.detailSlotChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' &&
    falsifier.delta.changed === 0;
  const reversePipelineTextureFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === false &&
    falsifier.afterEvidence.detailSlotChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' &&
    falsifier.delta.changed === 0 &&
    normal.dawn.sha256 !== falsifier.dawn.sha256 &&
    normal.rhiTopology.passCount !== falsifier.rhiTopology.passCount;
  const pipelineTextureFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === false &&
    falsifier.afterEvidence.detailSlotChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-rebind' &&
    falsifier.delta.changed === 0 &&
    normal.dawn.sha256 !== falsifier.dawn.sha256 &&
    normal.rhiTopology.passCount !== falsifier.rhiTopology.passCount;
  const parameterFalsifierOracle =
    falsifier.afterEvidence.baseColorParameterChanged === false &&
    falsifier.afterEvidence.baseColorUvTransformChanged === false &&
    falsifier.afterEvidence.falsifierMarker === 'FALSIFY_EXPECTED_FAILURE:live-inheritance-parameters' &&
    falsifier.delta.changed === 0 &&
    normal.draws === falsifier.draws;
  const pipelineFalsifierOracle =
    falsifier.afterEvidence.baseColorSlotChanged === true &&
    falsifier.afterEvidence.detailSlotChanged === true &&
    falsifier.afterEvidence.falsifierMarker === null &&
    falsifier.delta.changed >= 1000 &&
    normal.rhiTopology.passCount !== falsifier.rhiTopology.passCount &&
    (post === 'passthrough' || normal.dawn.sha256 !== falsifier.dawn.sha256);
  if (
    normal.afterEvidence.inheritanceBacked !== true ||
    (parameterFalsifier
      ? normal.afterEvidence.baseColorParameterChanged !== true ||
        normal.afterEvidence.baseColorUvTransformChanged !== true
      : normal.afterEvidence.baseColorSlotChanged !== true ||
        normal.afterEvidence.detailSlotChanged !== true) ||
    normal.afterEvidence.afterComponentMaterialMatchesAfter !== true ||
    normal.delta.changed < 1000 ||
    falsifier.afterEvidence.inheritanceBacked !== true ||
    (falsifierKind === 'param'
      ? !parameterFalsifierOracle
      : falsifierKind === 'pipeline-texture'
      ? !pipelineTextureFalsifierOracle
      : falsifierKind === 'reverse-pipeline-texture'
        ? !reversePipelineTextureFalsifierOracle
      : pipelineFalsifier
        ? !pipelineFalsifierOracle
        : !textureFalsifierOracle)
  ) {
    console.error(`[m3-programmable] inherited material ${post} post ${passLabel} oracle: FAIL - ${JSON.stringify(first)}`);
    failSmoke();
  }
  console.log(
    `[m3-programmable] inherited material ${post} post ${passLabel} startup-${startVariant} repeatability: PASS normalChanged=${normal.delta.changed} falsifierChanged=${falsifier.delta.changed} dawnSha=${normal.dawn.sha256}`,
  );
}
