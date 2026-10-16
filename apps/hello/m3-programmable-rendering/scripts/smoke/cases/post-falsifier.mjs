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

export function runPostFalsifierCases() {
const msaaPostArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-postfx-falsifier');
const msaaPostNormal = run(
  'custom pipeline MSAA inversion post normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPostArtifactRoot, 'normal'),
  },
);
const msaaPostFalsifier = run(
  'custom pipeline MSAA inversion post falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaPostArtifactRoot, 'falsifier'),
  },
);
const msaaPostNormalCapture = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaPostFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaPostNormalSummary = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaPostFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaPostArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaPostNormal.status !== 0 ||
  !msaaPostNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaPostNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPostNormal.output.includes('msaaTextureResourceCount=2') ||
  !msaaPostNormal.output.includes('resolveTargetCount=1') ||
  !msaaPostNormal.output.includes('draws=3') ||
  !msaaPostNormal.output.includes('variantSwitch=true') ||
  msaaPostFalsifier.status !== 0 ||
  !msaaPostFalsifier.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaPostFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaPostFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaPostFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaPostFalsifier.output.includes('draws=2') ||
  msaaPostNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaPostFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaPostNormalCapture.falsifyPipeline !== false ||
  msaaPostFalsifierCapture.falsifyPipeline !== true ||
  msaaPostNormalSummary.resolveTargetCount !== 1 ||
  msaaPostNormalSummary.drawCount !== 3 ||
  msaaPostFalsifierSummary.resolveTargetCount !== 1 ||
  msaaPostFalsifierSummary.drawCount !== 2
) {
  console.error('[m3-programmable] custom pipeline MSAA inversion post: FAIL - non-default post effect did not preserve the adjacent-pipeline oracle');
  failSmoke();
}
let msaaPostPixelDelta;
try {
  msaaPostPixelDelta = comparePngs(
    resolve(msaaPostArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaPostArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA inversion post PNG delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaPostPixelDelta.changedPixels === 0 || msaaPostPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA inversion post PNG delta: FAIL - changedPixels=${msaaPostPixelDelta.changedPixels} meanRgbDelta=${msaaPostPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaPostDawnReadbackDelta;
try {
  msaaPostDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaPostArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaPostArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaPostArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaPostArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA inversion post Dawn delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaPostDawnReadbackDelta.changedPixels === 0 || msaaPostDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA inversion post Dawn delta: FAIL - changedPixels=${msaaPostDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaPostDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA inversion post: PASS normalResolve=1 falsifierResolve=1 normalDraws=3 falsifierDraws=2 changedPixels=${msaaPostPixelDelta.changedPixels} changedFraction=${msaaPostPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaPostPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaPostDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaPostDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaPostDawnReadbackDelta.normalSha256} falsifierSha256=${msaaPostDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-falsifier');
const msaaLivePostNormal = run(
  'custom pipeline MSAA live post normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostArtifactRoot, 'normal'),
  },
);
const msaaLivePostFalsifier = run(
  'custom pipeline MSAA live post falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostArtifactRoot, 'falsifier'),
  },
);
const msaaLivePostNormalCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaLivePostFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaLivePostNormalSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaLivePostFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaLivePostNormal.status !== 0 ||
  !msaaLivePostNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostNormal.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostNormal.output.includes('resolveTargetCount=1') ||
  !msaaLivePostNormal.output.includes('draws=3') ||
  !msaaLivePostNormal.output.includes('variantSwitch=true') ||
  !msaaLivePostNormal.output.includes('postSwitch=true') ||
  msaaLivePostFalsifier.status !== 0 ||
  !msaaLivePostFalsifier.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaLivePostFalsifier.output.includes('draws=2') ||
  !msaaLivePostFalsifier.output.includes('variantSwitch=true') ||
  !msaaLivePostFalsifier.output.includes('postSwitch=true') ||
  msaaLivePostNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostNormalSummary.resolveTargetCount !== 1 ||
  msaaLivePostNormalSummary.drawCount !== 3 ||
  msaaLivePostFalsifierSummary.resolveTargetCount !== 1 ||
  msaaLivePostFalsifierSummary.drawCount !== 2
) {
  console.error('[m3-programmable] custom pipeline MSAA live post: FAIL - live post selection did not preserve the MSAA adjacent-pipeline oracle');
  failSmoke();
}
let msaaLivePostPixelDelta;
try {
  msaaLivePostPixelDelta = comparePngs(
    resolve(msaaLivePostArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaLivePostArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post PNG delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaLivePostPixelDelta.changedPixels === 0 || msaaLivePostPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post PNG delta: FAIL - changedPixels=${msaaLivePostPixelDelta.changedPixels} meanRgbDelta=${msaaLivePostPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaLivePostDawnReadbackDelta;
try {
  msaaLivePostDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaLivePostArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post Dawn delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaLivePostDawnReadbackDelta.changedPixels === 0 || msaaLivePostDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post Dawn delta: FAIL - changedPixels=${msaaLivePostDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaLivePostDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=1 normalDraws=3 falsifierDraws=2 changedPixels=${msaaLivePostPixelDelta.changedPixels} changedFraction=${msaaLivePostPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaLivePostPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaLivePostDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaLivePostDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaLivePostDawnReadbackDelta.normalSha256} falsifierSha256=${msaaLivePostDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostPipelineArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-pipeline-falsifier');
const msaaLivePostPipelineNormal = run(
  'custom pipeline MSAA live post adjacent pipeline normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostPipelineArtifactRoot, 'normal'),
  },
);
const msaaLivePostPipelineFalsifier = run(
  'custom pipeline MSAA live post adjacent pipeline falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostPipelineArtifactRoot, 'falsifier'),
  },
);
const msaaLivePostPipelineNormalCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaLivePostPipelineFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaLivePostPipelineNormalSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaLivePostPipelineFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaLivePostPipelineNormal.status !== 0 ||
  !msaaLivePostPipelineNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostPipelineNormal.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostPipelineNormal.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineNormal.output.includes('draws=3') ||
  !msaaLivePostPipelineNormal.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineNormal.output.includes('postSwitch=true') ||
  msaaLivePostPipelineFalsifier.status !== 0 ||
  !msaaLivePostPipelineFalsifier.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineFalsifier.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostPipelineFalsifier.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostPipelineFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineFalsifier.output.includes('draws=2') ||
  !msaaLivePostPipelineFalsifier.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineFalsifier.output.includes('postSwitch=true') ||
  msaaLivePostPipelineNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostPipelineFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostPipelineNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostPipelineFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostPipelineNormalCapture.falsifyPipeline !== false ||
  msaaLivePostPipelineFalsifierCapture.falsifyPipeline !== true ||
  msaaLivePostPipelineNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostPipelineFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostPipelineNormalSummary.resolveTargetCount !== 1 ||
  msaaLivePostPipelineNormalSummary.drawCount !== 3 ||
  msaaLivePostPipelineFalsifierSummary.resolveTargetCount !== 1 ||
  msaaLivePostPipelineFalsifierSummary.drawCount !== 2
) {
  console.error('[m3-programmable] custom pipeline MSAA live post adjacent pipeline falsifier: FAIL - live post switching did not survive the adjacent pipeline fault');
  failSmoke();
}
let msaaLivePostPipelinePixelDelta;
try {
  msaaLivePostPipelinePixelDelta = comparePngs(
    resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post adjacent pipeline PNG delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaLivePostPipelinePixelDelta.changedPixels === 0 || msaaLivePostPipelinePixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline PNG delta: FAIL - changedPixels=${msaaLivePostPipelinePixelDelta.changedPixels} meanRgbDelta=${msaaLivePostPipelinePixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaLivePostPipelineDawnReadbackDelta;
try {
  msaaLivePostPipelineDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostPipelineArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostPipelineArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post adjacent pipeline Dawn delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaLivePostPipelineDawnReadbackDelta.width !== 640 || msaaLivePostPipelineDawnReadbackDelta.height !== 360) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline Dawn readback: FAIL - dimensions=${msaaLivePostPipelineDawnReadbackDelta.width}x${msaaLivePostPipelineDawnReadbackDelta.height}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post adjacent pipeline: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=1 normalDraws=3 falsifierDraws=2 changedPixels=${msaaLivePostPipelinePixelDelta.changedPixels} changedFraction=${msaaLivePostPipelinePixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaLivePostPipelinePixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaLivePostPipelineDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaLivePostPipelineDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaLivePostPipelineDawnReadbackDelta.normalSha256} falsifierSha256=${msaaLivePostPipelineDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-pipeline-repeatability');
const msaaLivePostPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLivePostPipelineRepeatArtifactRoot, pass);
  msaaLivePostPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live post adjacent pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live post adjacent pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLivePostPipelineRepeatSnapshots = msaaLivePostPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(resolve(msaaLivePostPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal')),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(resolve(msaaLivePostPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier')),
  },
}));
const [msaaLivePostPipelineRepeatFirst, msaaLivePostPipelineRepeatSecond] = msaaLivePostPipelineRepeatSnapshots;
const msaaLivePostPipelineRepeatNormalDiff = repeatabilityDiff(
  msaaLivePostPipelineRepeatFirst.normal.snapshot,
  msaaLivePostPipelineRepeatSecond.normal.snapshot,
);
const msaaLivePostPipelineRepeatFalsifierDiff = repeatabilityDiff(
  msaaLivePostPipelineRepeatFirst.falsifier.snapshot,
  msaaLivePostPipelineRepeatSecond.falsifier.snapshot,
);
if (
  msaaLivePostPipelineRepeatFirst.normal.result.status !== 0 ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineRepeatFirst.normal.result.output.includes('postSwitch=true') ||
  msaaLivePostPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  !msaaLivePostPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=true') ||
  msaaLivePostPipelineRepeatSecond.normal.result.status !== 0 ||
  msaaLivePostPipelineRepeatSecond.falsifier.result.status !== 0 ||
  msaaLivePostPipelineRepeatNormalDiff !== undefined ||
  msaaLivePostPipelineRepeatFalsifierDiff !== undefined ||
  msaaLivePostPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaLivePostPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post adjacent pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLivePostPipelineRepeatFirst.normal.result.status, msaaLivePostPipelineRepeatSecond.normal.result.status], falsifierStatus: [msaaLivePostPipelineRepeatFirst.falsifier.result.status, msaaLivePostPipelineRepeatSecond.falsifier.result.status], normalDiff: msaaLivePostPipelineRepeatNormalDiff, falsifierDiff: msaaLivePostPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post adjacent pipeline repeatability: PASS normalSha256=${msaaLivePostPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLivePostPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLivePostPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLivePostPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaLivePostResolveArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-resolve-falsifier');
const msaaLivePostResolveNormal = run(
  'custom pipeline MSAA live post resolve normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostResolveArtifactRoot, 'normal'),
  },
);
const msaaLivePostResolveFalsifier = run(
  'custom pipeline MSAA live post resolve falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'passthrough',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_SWITCH_POST: '1',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaLivePostResolveArtifactRoot, 'falsifier'),
  },
);
const msaaLivePostResolveNormalCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaLivePostResolveFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaLivePostResolveNormalSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaLivePostResolveFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaLivePostResolveNormal.status !== 0 ||
  !msaaLivePostResolveNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostResolveNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostResolveNormal.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostResolveNormal.output.includes('resolveTargetCount=1') ||
  !msaaLivePostResolveNormal.output.includes('draws=3') ||
  !msaaLivePostResolveNormal.output.includes('variantSwitch=true') ||
  !msaaLivePostResolveNormal.output.includes('postSwitch=true') ||
  msaaLivePostResolveFalsifier.status !== 0 ||
  !msaaLivePostResolveFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLivePostResolveFalsifier.output.includes('resolveTargetCount=1') ||
  !msaaLivePostResolveFalsifier.output.includes('dawnReadbackSha256=') ||
  msaaLivePostResolveNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostResolveFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostResolveNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveNormalSummary.resolveTargetCount !== 1 ||
  msaaLivePostResolveNormalSummary.drawCount !== 3 ||
  msaaLivePostResolveFalsifierSummary.resolveTargetCount !== 1 ||
  msaaLivePostResolveFalsifierSummary.drawCount !== 3
) {
  console.error('[m3-programmable] custom pipeline MSAA live post resolve falsifier: FAIL - post switch did not survive the no-resolve topology falsifier');
  failSmoke();
}
let msaaLivePostResolvePixelDelta;
try {
  msaaLivePostResolvePixelDelta = comparePngs(
    resolve(msaaLivePostResolveArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post resolve PNG delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaLivePostResolvePixelDelta.changedPixels === 0 || msaaLivePostResolvePixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post resolve PNG delta: FAIL - changedPixels=${msaaLivePostResolvePixelDelta.changedPixels} meanRgbDelta=${msaaLivePostResolvePixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaLivePostResolveDawnReadbackDelta;
try {
  msaaLivePostResolveDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaLivePostResolveArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostResolveArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostResolveArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA live post resolve Dawn delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaLivePostResolveDawnReadbackDelta.changedPixels === 0 || msaaLivePostResolveDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post resolve Dawn delta: FAIL - changedPixels=${msaaLivePostResolveDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaLivePostResolveDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post resolve falsifier: PASS normalPost=passthrough falsifierPost=passthrough finalPost=inversion normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 changedPixels=${msaaLivePostResolvePixelDelta.changedPixels} changedFraction=${msaaLivePostResolvePixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaLivePostResolvePixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaLivePostResolveDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaLivePostResolveDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaLivePostResolveDawnReadbackDelta.normalSha256} falsifierSha256=${msaaLivePostResolveDawnReadbackDelta.falsifierSha256}`,
);

const msaaLivePostResolveRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-post-resolve-repeatability');
const msaaLivePostResolveRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLivePostResolveRepeatArtifactRoot, pass);
  msaaLivePostResolveRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live post resolve repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live post resolve repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLivePostResolveRepeatSnapshots = msaaLivePostResolveRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaLivePostResolveRepeatFirst, msaaLivePostResolveRepeatSecond] = msaaLivePostResolveRepeatSnapshots;
const msaaLivePostResolveRepeatNormalDiff = repeatabilityDiff(
  msaaLivePostResolveRepeatFirst.normal.snapshot,
  msaaLivePostResolveRepeatSecond.normal.snapshot,
);
const msaaLivePostResolveRepeatFalsifierDiff = repeatabilityDiff(
  msaaLivePostResolveRepeatFirst.falsifier.snapshot,
  msaaLivePostResolveRepeatSecond.falsifier.snapshot,
);
if (
  msaaLivePostResolveRepeatFirst.normal.result.status !== 0 ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLivePostResolveRepeatFirst.normal.result.output.includes('postSwitch=true') ||
  msaaLivePostResolveRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLivePostResolveRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLivePostResolveRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  msaaLivePostResolveRepeatSecond.normal.result.status !== 0 ||
  msaaLivePostResolveRepeatSecond.falsifier.result.status !== 0 ||
  msaaLivePostResolveRepeatNormalDiff !== undefined ||
  msaaLivePostResolveRepeatFalsifierDiff !== undefined ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLivePostResolveRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live post resolve repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLivePostResolveRepeatFirst.normal.result.status, msaaLivePostResolveRepeatSecond.normal.result.status], falsifierStatus: [msaaLivePostResolveRepeatFirst.falsifier.result.status, msaaLivePostResolveRepeatSecond.falsifier.result.status], normalDiff: msaaLivePostResolveRepeatNormalDiff, falsifierDiff: msaaLivePostResolveRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA live post resolve repeatability: PASS normalSha256=${msaaLivePostResolveRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLivePostResolveRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLivePostResolveRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLivePostResolveRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaLivePostDoubleResizeRepeatArtifactRoot = resolve(
  customRhiArtifactRoot,
  'msaa-live-post-double-resize-repeatability',
);
const msaaLivePostDoubleResizeRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, pass);
  msaaLivePostDoubleResizeRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live post double resize repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLivePostDoubleResizeRepeatFirst = msaaLivePostDoubleResizeRepeatRuns[0];
const msaaLivePostDoubleResizeRepeatSecond = msaaLivePostDoubleResizeRepeatRuns[1];
const msaaLivePostDoubleResizeRepeatFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal'),
);
const msaaLivePostDoubleResizeRepeatSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal'),
);
const msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier'),
);
const msaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier'),
);
const msaaLivePostDoubleResizeRepeatNormalDiff = repeatabilityDiff(
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot,
  msaaLivePostDoubleResizeRepeatSecondNormalSnapshot,
);
const msaaLivePostDoubleResizeRepeatFalsifierDiff = repeatabilityDiff(
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot,
  msaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot,
);
let msaaLivePostDoubleResizeRepeatFirstPngDelta;
let msaaLivePostDoubleResizeRepeatSecondPngDelta;
let msaaLivePostDoubleResizeRepeatFirstDawnDelta;
let msaaLivePostDoubleResizeRepeatSecondDawnDelta;
try {
  msaaLivePostDoubleResizeRepeatFirstPngDelta = comparePngs(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  msaaLivePostDoubleResizeRepeatSecondPngDelta = comparePngs(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  msaaLivePostDoubleResizeRepeatFirstDawnDelta = compareDawnReadbacks(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  msaaLivePostDoubleResizeRepeatSecondDawnDelta = compareDawnReadbacks(
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA live post double resize repeatability delta: FAIL - ${error}`);
  failSmoke();
}
const msaaLivePostDoubleResizeExpectedHistoryArray = [
  '640x360',
  '480x270',
  '720x405',
  '640x360',
  '480x270',
  '720x405',
  '640x360',
];
if (
  msaaLivePostDoubleResizeRepeatFirst.normal.status !== 0 ||
  msaaLivePostDoubleResizeRepeatFirst.falsifier.status !== 0 ||
  msaaLivePostDoubleResizeRepeatSecond.normal.status !== 0 ||
  msaaLivePostDoubleResizeRepeatSecond.falsifier.status !== 0 ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.resizeHistory.join('>') !==
    msaaLivePostDoubleResizeExpectedHistoryArray.join('>') ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.drawCount !== 3 ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.postSwitchedAfterPipeline !== true ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.resizeHistory.join('>') !==
    msaaLivePostDoubleResizeExpectedHistoryArray.join('>') ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.drawCount !== 3 ||
  msaaLivePostDoubleResizeRepeatNormalDiff !== undefined ||
  msaaLivePostDoubleResizeRepeatFalsifierDiff !== undefined ||
  msaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatFirstPngDelta.meanRgbDelta <= 0.01 ||
  msaaLivePostDoubleResizeRepeatSecondPngDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatSecondPngDelta.meanRgbDelta <= 0.01 ||
  msaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatFirstDawnDelta.meanRgbDelta <= 0.01 ||
  msaaLivePostDoubleResizeRepeatSecondDawnDelta.changedPixels === 0 ||
  msaaLivePostDoubleResizeRepeatSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] MSAA live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: msaaLivePostDoubleResizeRepeatFirst.normal.status, firstFalsifier: msaaLivePostDoubleResizeRepeatFirst.falsifier.status, secondNormal: msaaLivePostDoubleResizeRepeatSecond.normal.status, secondFalsifier: msaaLivePostDoubleResizeRepeatSecond.falsifier.status }, normalDiff: msaaLivePostDoubleResizeRepeatNormalDiff, falsifierDiff: msaaLivePostDoubleResizeRepeatFalsifierDiff, firstPng: msaaLivePostDoubleResizeRepeatFirstPngDelta, secondPng: msaaLivePostDoubleResizeRepeatSecondPngDelta, firstDawn: msaaLivePostDoubleResizeRepeatFirstDawnDelta, secondDawn: msaaLivePostDoubleResizeRepeatSecondDawnDelta })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] MSAA live post double resize repeatability: PASS normalSha256=${msaaLivePostDoubleResizeRepeatFirstDawnDelta.normalSha256} falsifierSha256=${msaaLivePostDoubleResizeRepeatFirstDawnDelta.falsifierSha256} dawnChangedPixels=${msaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels} pngChangedPixels=${msaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels}`,
);

const msaaLiveVariantRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-variant-repeatability');
const msaaLiveVariantRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLiveVariantRepeatArtifactRoot, pass);
  msaaLiveVariantRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live variant repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live variant repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLiveVariantRepeatSnapshots = msaaLiveVariantRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaLiveVariantRepeatFirst, msaaLiveVariantRepeatSecond] = msaaLiveVariantRepeatSnapshots;
const msaaLiveVariantRepeatNormalDiff = repeatabilityDiff(
  msaaLiveVariantRepeatFirst.normal.snapshot,
  msaaLiveVariantRepeatSecond.normal.snapshot,
);
const msaaLiveVariantRepeatFalsifierDiff = repeatabilityDiff(
  msaaLiveVariantRepeatFirst.falsifier.snapshot,
  msaaLiveVariantRepeatSecond.falsifier.snapshot,
);
if (
  msaaLiveVariantRepeatFirst.normal.result.status !== 0 ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLiveVariantRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaLiveVariantRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLiveVariantRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLiveVariantRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  msaaLiveVariantRepeatSecond.normal.result.status !== 0 ||
  msaaLiveVariantRepeatSecond.falsifier.result.status !== 0 ||
  msaaLiveVariantRepeatNormalDiff !== undefined ||
  msaaLiveVariantRepeatFalsifierDiff !== undefined ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLiveVariantRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLiveVariantRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLiveVariantRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live variant repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLiveVariantRepeatFirst.normal.result.status, msaaLiveVariantRepeatSecond.normal.result.status], falsifierStatus: [msaaLiveVariantRepeatFirst.falsifier.result.status, msaaLiveVariantRepeatSecond.falsifier.result.status], normalDiff: msaaLiveVariantRepeatNormalDiff, falsifierDiff: msaaLiveVariantRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA live variant repeatability: PASS normalSha256=${msaaLiveVariantRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLiveVariantRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLiveVariantRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLiveVariantRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyInversionArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-inversion');
const msaaLiveVariantInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-live-variant-inversion-repeatability');
const msaaLiveVariantInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaLiveVariantInversionRepeatArtifactRoot, pass);
  msaaLiveVariantInversionRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA live variant inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA live variant inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaLiveVariantInversionRepeatSnapshots = msaaLiveVariantInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaLiveVariantInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaLiveVariantInversionRepeatFirst, msaaLiveVariantInversionRepeatSecond] = msaaLiveVariantInversionRepeatSnapshots;
const msaaLiveVariantInversionRepeatNormalDiff = repeatabilityDiff(
  msaaLiveVariantInversionRepeatFirst.normal.snapshot,
  msaaLiveVariantInversionRepeatSecond.normal.snapshot,
);
const msaaLiveVariantInversionRepeatFalsifierDiff = repeatabilityDiff(
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot,
  msaaLiveVariantInversionRepeatSecond.falsifier.snapshot,
);
if (
  msaaLiveVariantInversionRepeatFirst.normal.result.status !== 0 ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !msaaLiveVariantInversionRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaLiveVariantInversionRepeatFirst.falsifier.result.status !== 0 ||
  !msaaLiveVariantInversionRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaLiveVariantInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  msaaLiveVariantInversionRepeatSecond.normal.result.status !== 0 ||
  msaaLiveVariantInversionRepeatSecond.falsifier.result.status !== 0 ||
  msaaLiveVariantInversionRepeatNormalDiff !== undefined ||
  msaaLiveVariantInversionRepeatFalsifierDiff !== undefined ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLiveVariantInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA live variant inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaLiveVariantInversionRepeatFirst.normal.result.status, msaaLiveVariantInversionRepeatSecond.normal.result.status], falsifierStatus: [msaaLiveVariantInversionRepeatFirst.falsifier.result.status, msaaLiveVariantInversionRepeatSecond.falsifier.result.status], normalDiff: msaaLiveVariantInversionRepeatNormalDiff, falsifierDiff: msaaLiveVariantInversionRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA live variant inversion repeatability: PASS normalSha256=${msaaLiveVariantInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaLiveVariantInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaLiveVariantInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaLiveVariantInversionPipelineRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-variant-inversion-pipeline-repeatability');
const noMsaaLiveVariantInversionPipelineRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaLiveVariantInversionPipelineRepeatArtifactRoot, pass);
  noMsaaLiveVariantInversionPipelineRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA live variant inversion adjacent pipeline repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA live variant inversion adjacent pipeline repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaLiveVariantInversionPipelineRepeatSnapshots = noMsaaLiveVariantInversionPipelineRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLiveVariantInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLiveVariantInversionPipelineRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaLiveVariantInversionPipelineRepeatFirst, noMsaaLiveVariantInversionPipelineRepeatSecond] = noMsaaLiveVariantInversionPipelineRepeatSnapshots;
const noMsaaLiveVariantInversionPipelineRepeatNormalDiff = repeatabilityDiff(
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot,
  noMsaaLiveVariantInversionPipelineRepeatSecond.normal.snapshot,
);
const noMsaaLiveVariantInversionPipelineRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot,
  noMsaaLiveVariantInversionPipelineRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.status !== 0 ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('draws=3') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS -') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('draws=2') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  !noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.output.includes('postSwitch=false') ||
  noMsaaLiveVariantInversionPipelineRepeatSecond.normal.result.status !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatNormalDiff !== undefined ||
  noMsaaLiveVariantInversionPipelineRepeatFalsifierDiff !== undefined ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== true ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.rhi.drawCount !== 2
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA live variant inversion adjacent pipeline repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaLiveVariantInversionPipelineRepeatFirst.normal.result.status, noMsaaLiveVariantInversionPipelineRepeatSecond.normal.result.status], falsifierStatus: [noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.result.status, noMsaaLiveVariantInversionPipelineRepeatSecond.falsifier.result.status], normalDiff: noMsaaLiveVariantInversionPipelineRepeatNormalDiff, falsifierDiff: noMsaaLiveVariantInversionPipelineRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA live variant inversion adjacent pipeline repeatability: PASS normalSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaLiveVariantInversionPipelineRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyInversionNormal = run(
  'custom pipeline MSAA steady inversion normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyInversionArtifactRoot, 'normal'),
  },
);
const msaaSteadyInversionFalsifier = run(
  'custom pipeline MSAA steady inversion falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'false',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyInversionArtifactRoot, 'falsifier'),
  },
);
const msaaSteadyInversionNormalCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaSteadyInversionFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaSteadyInversionNormalSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaSteadyInversionFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaSteadyInversionNormal.status !== 0 ||
  !msaaSteadyInversionNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyInversionNormal.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaSteadyInversionNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaSteadyInversionNormal.output.includes('msaaTextureResourceCount=2') ||
  !msaaSteadyInversionNormal.output.includes('resolveTargetCount=1') ||
  !msaaSteadyInversionNormal.output.includes('draws=3') ||
  !msaaSteadyInversionNormal.output.includes('variantSwitch=false') ||
  !msaaSteadyInversionNormal.output.includes('postSwitch=false') ||
  msaaSteadyInversionFalsifier.status !== 0 ||
  !msaaSteadyInversionFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyInversionFalsifier.output.includes('resolveTargetCount=1') ||
  msaaSteadyInversionNormalCapture.falsifyPipeline !== false ||
  msaaSteadyInversionFalsifierCapture.falsifyPipeline !== false ||
  msaaSteadyInversionNormalCapture.selectedVariant !== 'false' ||
  msaaSteadyInversionFalsifierCapture.selectedVariant !== 'false' ||
  msaaSteadyInversionNormalCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyInversionFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyInversionNormalCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyInversionFalsifierCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyInversionNormalCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyInversionFalsifierCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyInversionNormalSummary.resolveTargetCount !== 1 ||
  msaaSteadyInversionNormalSummary.drawCount !== 3 ||
  msaaSteadyInversionFalsifierSummary.resolveTargetCount !== 1 ||
  msaaSteadyInversionFalsifierSummary.drawCount !== 3
) {
  console.error('[m3-programmable] custom pipeline MSAA steady inversion: FAIL - steady-state variant/post or no-resolve evidence did not pass');
  failSmoke();
}
let msaaSteadyInversionPixelDelta;
try {
  msaaSteadyInversionPixelDelta = comparePngs(
    resolve(msaaSteadyInversionArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady inversion PNG delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaSteadyInversionPixelDelta.changedPixels === 0 || msaaSteadyInversionPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady inversion PNG delta: FAIL - changedPixels=${msaaSteadyInversionPixelDelta.changedPixels} meanRgbDelta=${msaaSteadyInversionPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaSteadyInversionDawnReadbackDelta;
try {
  msaaSteadyInversionDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaSteadyInversionArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaSteadyInversionArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaSteadyInversionArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady inversion Dawn delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaSteadyInversionDawnReadbackDelta.changedPixels === 0 || msaaSteadyInversionDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady inversion Dawn delta: FAIL - changedPixels=${msaaSteadyInversionDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaSteadyInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady inversion: PASS normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 changedPixels=${msaaSteadyInversionPixelDelta.changedPixels} changedFraction=${msaaSteadyInversionPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaSteadyInversionPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaSteadyInversionDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaSteadyInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaSteadyInversionDawnReadbackDelta.normalSha256} falsifierSha256=${msaaSteadyInversionDawnReadbackDelta.falsifierSha256}`,
);

const msaaSteadyTrueInversionArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-inversion');
const msaaSteadyTrueInversionNormal = run(
  'custom pipeline MSAA steady true inversion normal',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyTrueInversionArtifactRoot, 'normal'),
  },
);
const msaaSteadyTrueInversionFalsifier = run(
  'custom pipeline MSAA steady true inversion falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_MSAA: '1',
    FORGEAX_M3_POST: 'inversion',
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier'),
  },
);
const msaaSteadyTrueInversionNormalCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'capture.json'), 'utf8'),
);
const msaaSteadyTrueInversionFalsifierCapture = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'capture.json'), 'utf8'),
);
const msaaSteadyTrueInversionNormalSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'rhi-summary.json'), 'utf8'),
);
const msaaSteadyTrueInversionFalsifierSummary = JSON.parse(
  readFileSync(resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'rhi-summary.json'), 'utf8'),
);
if (
  msaaSteadyTrueInversionNormal.status !== 0 ||
  !msaaSteadyTrueInversionNormal.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyTrueInversionNormal.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaSteadyTrueInversionNormal.output.includes('antialias=M3_ANTIALIAS=msaa') ||
  !msaaSteadyTrueInversionNormal.output.includes('msaaTextureResourceCount=2') ||
  !msaaSteadyTrueInversionNormal.output.includes('resolveTargetCount=1') ||
  !msaaSteadyTrueInversionNormal.output.includes('draws=3') ||
  !msaaSteadyTrueInversionNormal.output.includes('variantSwitch=false') ||
  !msaaSteadyTrueInversionNormal.output.includes('postSwitch=false') ||
  msaaSteadyTrueInversionFalsifier.status !== 0 ||
  !msaaSteadyTrueInversionFalsifier.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyTrueInversionFalsifier.output.includes('resolveTargetCount=1') ||
  msaaSteadyTrueInversionNormalCapture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionFalsifierCapture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionNormalCapture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionFalsifierCapture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionNormalCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionNormalCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionFalsifierCapture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionNormalCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionFalsifierCapture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionNormalSummary.resolveTargetCount !== 1 ||
  msaaSteadyTrueInversionNormalSummary.drawCount !== 3 ||
  msaaSteadyTrueInversionFalsifierSummary.resolveTargetCount !== 1 ||
  msaaSteadyTrueInversionFalsifierSummary.drawCount !== 3
) {
  console.error('[m3-programmable] custom pipeline MSAA steady true inversion: FAIL - steady-state true variant/post or no-resolve evidence did not pass');
  failSmoke();
}
let msaaSteadyTrueInversionPixelDelta;
try {
  msaaSteadyTrueInversionPixelDelta = comparePngs(
    resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'custom-live.png'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'custom-live.png'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady true inversion PNG delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaSteadyTrueInversionPixelDelta.changedPixels === 0 || msaaSteadyTrueInversionPixelDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true inversion PNG delta: FAIL - changedPixels=${msaaSteadyTrueInversionPixelDelta.changedPixels} meanRgbDelta=${msaaSteadyTrueInversionPixelDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
let msaaSteadyTrueInversionDawnReadbackDelta;
try {
  msaaSteadyTrueInversionDawnReadbackDelta = compareDawnReadbacks(
    resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'dawn-readback.rgba'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'normal', 'dawn-readback.json'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaSteadyTrueInversionArtifactRoot, 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] custom pipeline MSAA steady true inversion Dawn delta: FAIL - ${error}`);
  failSmoke();
}
if (msaaSteadyTrueInversionDawnReadbackDelta.changedPixels === 0 || msaaSteadyTrueInversionDawnReadbackDelta.meanRgbDelta <= 0.01) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true inversion Dawn delta: FAIL - changedPixels=${msaaSteadyTrueInversionDawnReadbackDelta.changedPixels} meanRgbDelta=${msaaSteadyTrueInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady true inversion: PASS normalResolve=1 falsifierResolve=0 normalDraws=2 falsifierDraws=2 changedPixels=${msaaSteadyTrueInversionPixelDelta.changedPixels} changedFraction=${msaaSteadyTrueInversionPixelDelta.changedFraction.toFixed(3)} meanRgbDelta=${msaaSteadyTrueInversionPixelDelta.meanRgbDelta.toFixed(4)} dawnChangedPixels=${msaaSteadyTrueInversionDawnReadbackDelta.changedPixels} dawnMeanRgbDelta=${msaaSteadyTrueInversionDawnReadbackDelta.meanRgbDelta.toFixed(4)} normalSha256=${msaaSteadyTrueInversionDawnReadbackDelta.normalSha256} falsifierSha256=${msaaSteadyTrueInversionDawnReadbackDelta.falsifierSha256}`,
);

const msaaSteadyTrueInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-inversion-repeatability');
const msaaSteadyTrueInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyTrueInversionRepeatArtifactRoot, pass);
  msaaSteadyTrueInversionRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady true inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady true inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyTrueInversionRepeatSnapshots = msaaSteadyTrueInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTrueInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyTrueInversionRepeatFirst, msaaSteadyTrueInversionRepeatSecond] = msaaSteadyTrueInversionRepeatSnapshots;
const msaaSteadyTrueInversionRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot,
  msaaSteadyTrueInversionRepeatSecond.normal.snapshot,
);
const msaaSteadyTrueInversionRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot,
  msaaSteadyTrueInversionRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyTrueInversionRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyTrueInversionRepeatFirst.normal.result.output.includes('draws=3') ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyTrueInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  msaaSteadyTrueInversionRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyTrueInversionRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyTrueInversionRepeatNormalDiff !== undefined ||
  msaaSteadyTrueInversionRepeatFalsifierDiff !== undefined ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyTrueInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyTrueInversionRepeatFirst.normal.result.status, msaaSteadyTrueInversionRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyTrueInversionRepeatFirst.falsifier.result.status, msaaSteadyTrueInversionRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyTrueInversionRepeatNormalDiff, falsifierDiff: msaaSteadyTrueInversionRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady true inversion repeatability: PASS normalSha256=${msaaSteadyTrueInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyTrueInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyTrueInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyTruePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-true-passthrough-repeatability');
const msaaSteadyTruePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyTruePassthroughRepeatArtifactRoot, pass);
  msaaSteadyTruePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady true passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady true passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyTruePassthroughRepeatSnapshots = msaaSteadyTruePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyTruePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyTruePassthroughRepeatFirst, msaaSteadyTruePassthroughRepeatSecond] = msaaSteadyTruePassthroughRepeatSnapshots;
const msaaSteadyTruePassthroughRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot,
  msaaSteadyTruePassthroughRepeatSecond.normal.snapshot,
);
const msaaSteadyTruePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot,
  msaaSteadyTruePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyTruePassthroughRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=true') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaSteadyTruePassthroughRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyTruePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  msaaSteadyTruePassthroughRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyTruePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyTruePassthroughRepeatNormalDiff !== undefined ||
  msaaSteadyTruePassthroughRepeatFalsifierDiff !== undefined ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady true passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyTruePassthroughRepeatFirst.normal.result.status, msaaSteadyTruePassthroughRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyTruePassthroughRepeatFirst.falsifier.result.status, msaaSteadyTruePassthroughRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyTruePassthroughRepeatNormalDiff, falsifierDiff: msaaSteadyTruePassthroughRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady true passthrough repeatability: PASS normalSha256=${msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyTruePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyTruePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyFalsePassthroughRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-false-passthrough-repeatability');
const msaaSteadyFalsePassthroughRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyFalsePassthroughRepeatArtifactRoot, pass);
  msaaSteadyFalsePassthroughRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady false passthrough repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady false passthrough repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyFalsePassthroughRepeatSnapshots = msaaSteadyFalsePassthroughRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalsePassthroughRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyFalsePassthroughRepeatFirst, msaaSteadyFalsePassthroughRepeatSecond] = msaaSteadyFalsePassthroughRepeatSnapshots;
const msaaSteadyFalsePassthroughRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot,
  msaaSteadyFalsePassthroughRepeatSecond.normal.snapshot,
);
const msaaSteadyFalsePassthroughRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot,
  msaaSteadyFalsePassthroughRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyFalsePassthroughRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=passthrough') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('draws=3') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('variantSwitch=false') ||
  !msaaSteadyFalsePassthroughRepeatFirst.normal.result.output.includes('postSwitch=false') ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  msaaSteadyFalsePassthroughRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyFalsePassthroughRepeatNormalDiff !== undefined ||
  msaaSteadyFalsePassthroughRepeatFalsifierDiff !== undefined ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady false passthrough repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyFalsePassthroughRepeatFirst.normal.result.status, msaaSteadyFalsePassthroughRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyFalsePassthroughRepeatFirst.falsifier.result.status, msaaSteadyFalsePassthroughRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyFalsePassthroughRepeatNormalDiff, falsifierDiff: msaaSteadyFalsePassthroughRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady false passthrough repeatability: PASS normalSha256=${msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyFalsePassthroughRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyFalsePassthroughRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const msaaSteadyFalseInversionRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'msaa-steady-false-inversion-repeatability');
const msaaSteadyFalseInversionRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaSteadyFalseInversionRepeatArtifactRoot, pass);
  msaaSteadyFalseInversionRepeatRuns.push({
    normal: run(
      `custom pipeline MSAA steady false inversion repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA steady false inversion repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'inversion',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaSteadyFalseInversionRepeatSnapshots = msaaSteadyFalseInversionRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(msaaSteadyFalseInversionRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [msaaSteadyFalseInversionRepeatFirst, msaaSteadyFalseInversionRepeatSecond] = msaaSteadyFalseInversionRepeatSnapshots;
const msaaSteadyFalseInversionRepeatNormalDiff = repeatabilityDiff(
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot,
  msaaSteadyFalseInversionRepeatSecond.normal.snapshot,
);
const msaaSteadyFalseInversionRepeatFalsifierDiff = repeatabilityDiff(
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot,
  msaaSteadyFalseInversionRepeatSecond.falsifier.snapshot,
);
if (
  msaaSteadyFalseInversionRepeatFirst.normal.result.status !== 0 ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('variant=M3_MULTI_UV_VARIANT=false') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('post=M3_POST_EFFECT=inversion') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=2') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('resolveTargetCount=1') ||
  !msaaSteadyFalseInversionRepeatFirst.normal.result.output.includes('draws=3') ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.result.status !== 0 ||
  !msaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  !msaaSteadyFalseInversionRepeatFirst.falsifier.result.output.includes('resolveTargetCount=1') ||
  msaaSteadyFalseInversionRepeatSecond.normal.result.status !== 0 ||
  msaaSteadyFalseInversionRepeatSecond.falsifier.result.status !== 0 ||
  msaaSteadyFalseInversionRepeatNormalDiff !== undefined ||
  msaaSteadyFalseInversionRepeatFalsifierDiff !== undefined ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'false' ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=inversion' ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.capture.falsifyPipeline !== false ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyFalseInversionRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 1 ||
  msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline MSAA steady false inversion repeatability: FAIL - ${JSON.stringify({ normalStatus: [msaaSteadyFalseInversionRepeatFirst.normal.result.status, msaaSteadyFalseInversionRepeatSecond.normal.result.status], falsifierStatus: [msaaSteadyFalseInversionRepeatFirst.falsifier.result.status, msaaSteadyFalseInversionRepeatSecond.falsifier.result.status], normalDiff: msaaSteadyFalseInversionRepeatNormalDiff, falsifierDiff: msaaSteadyFalseInversionRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline MSAA steady false inversion repeatability: PASS normalSha256=${msaaSteadyFalseInversionRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${msaaSteadyFalseInversionRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${msaaSteadyFalseInversionRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaLivePostResolveRepeatArtifactRoot = resolve(customRhiArtifactRoot, 'no-msaa-live-post-resolve-repeatability');
const noMsaaLivePostResolveRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaLivePostResolveRepeatArtifactRoot, pass);
  noMsaaLivePostResolveRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA live post resolve repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA live post resolve repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaLivePostResolveRepeatSnapshots = noMsaaLivePostResolveRepeatRuns.map((pass, index) => ({
  normal: {
    result: pass.normal,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/normal' : 'second/normal'),
    ),
  },
  falsifier: {
    result: pass.falsifier,
    snapshot: readRepeatabilitySnapshot(
      resolve(noMsaaLivePostResolveRepeatArtifactRoot, index === 0 ? 'first/falsifier' : 'second/falsifier'),
    ),
  },
}));
const [noMsaaLivePostResolveRepeatFirst, noMsaaLivePostResolveRepeatSecond] = noMsaaLivePostResolveRepeatSnapshots;
const noMsaaLivePostResolveRepeatNormalDiff = repeatabilityDiff(
  noMsaaLivePostResolveRepeatFirst.normal.snapshot,
  noMsaaLivePostResolveRepeatSecond.normal.snapshot,
);
const noMsaaLivePostResolveRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot,
  noMsaaLivePostResolveRepeatSecond.falsifier.snapshot,
);
if (
  noMsaaLivePostResolveRepeatFirst.normal.result.status !== 0 ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('draws=3') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('variantSwitch=true') ||
  !noMsaaLivePostResolveRepeatFirst.normal.result.output.includes('postSwitch=true') ||
  noMsaaLivePostResolveRepeatFirst.falsifier.result.status !== 0 ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('antialias=M3_ANTIALIAS=none') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('msaaTextureResourceCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('resolveTargetCount=0') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('draws=3') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('variantSwitch=true') ||
  !noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('postSwitch=true') ||
  noMsaaLivePostResolveRepeatFirst.falsifier.result.output.includes('[m3-browser-rhi] PASS_FALSIFY') ||
  noMsaaLivePostResolveRepeatSecond.normal.result.status !== 0 ||
  noMsaaLivePostResolveRepeatSecond.falsifier.result.status !== 0 ||
  noMsaaLivePostResolveRepeatNormalDiff !== undefined ||
  noMsaaLivePostResolveRepeatFalsifierDiff !== undefined ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.normal.snapshot.rhi.drawCount !== 3 ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.rhi.drawCount !== 3
) {
  console.error(
    `[m3-programmable] custom pipeline no-MSAA live post resolve repeatability: FAIL - ${JSON.stringify({ normalStatus: [noMsaaLivePostResolveRepeatFirst.normal.result.status, noMsaaLivePostResolveRepeatSecond.normal.result.status], falsifierStatus: [noMsaaLivePostResolveRepeatFirst.falsifier.result.status, noMsaaLivePostResolveRepeatSecond.falsifier.result.status], normalDiff: noMsaaLivePostResolveRepeatNormalDiff, falsifierDiff: noMsaaLivePostResolveRepeatFalsifierDiff })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] custom pipeline no-MSAA live post resolve repeatability: PASS normalSha256=${noMsaaLivePostResolveRepeatFirst.normal.snapshot.dawn.sha256} falsifierSha256=${noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.dawn.sha256} normalPngSha256=${noMsaaLivePostResolveRepeatFirst.normal.snapshot.screenshotSha256} falsifierPngSha256=${noMsaaLivePostResolveRepeatFirst.falsifier.snapshot.screenshotSha256}`,
);

const noMsaaLivePostDoubleResizeRepeatArtifactRoot = resolve(
  customRhiArtifactRoot,
  'no-msaa-live-post-double-resize-repeatability',
);
const noMsaaLivePostDoubleResizeRepeatRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, pass);
  noMsaaLivePostDoubleResizeRepeatRuns.push({
    normal: run(
      `custom pipeline no-MSAA live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA live post double resize repeat ${pass} adjacent pipeline falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'true',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaLivePostDoubleResizeRepeatFirst = noMsaaLivePostDoubleResizeRepeatRuns[0];
const noMsaaLivePostDoubleResizeRepeatSecond = noMsaaLivePostDoubleResizeRepeatRuns[1];
const noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal'),
);
const noMsaaLivePostDoubleResizeRepeatSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal'),
);
const noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier'),
);
const noMsaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier'),
);
const noMsaaLivePostDoubleResizeRepeatNormalDiff = repeatabilityDiff(
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot,
  noMsaaLivePostDoubleResizeRepeatSecondNormalSnapshot,
);
const noMsaaLivePostDoubleResizeRepeatFalsifierDiff = repeatabilityDiff(
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot,
  noMsaaLivePostDoubleResizeRepeatSecondFalsifierSnapshot,
);
let noMsaaLivePostDoubleResizeRepeatFirstPngDelta;
let noMsaaLivePostDoubleResizeRepeatSecondPngDelta;
let noMsaaLivePostDoubleResizeRepeatFirstDawnDelta;
let noMsaaLivePostDoubleResizeRepeatSecondDawnDelta;
try {
  noMsaaLivePostDoubleResizeRepeatFirstPngDelta = comparePngs(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  noMsaaLivePostDoubleResizeRepeatSecondPngDelta = comparePngs(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  noMsaaLivePostDoubleResizeRepeatFirstDawnDelta = compareDawnReadbacks(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaLivePostDoubleResizeRepeatSecondDawnDelta = compareDawnReadbacks(
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaLivePostDoubleResizeRepeatArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] no-MSAA live post double resize repeatability delta: FAIL - ${error}`);
  failSmoke();
}
const noMsaaLivePostDoubleResizeExpectedHistory = [
  '640x360',
  '480x270',
  '720x405',
  '640x360',
  '480x270',
  '720x405',
  '640x360',
].join('>');
if (
  noMsaaLivePostDoubleResizeRepeatFirst.normal.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirst.falsifier.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatSecond.normal.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatSecond.falsifier.status !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.falsifyPipeline !== false ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.capture.resizeHistory.join('>') !== noMsaaLivePostDoubleResizeExpectedHistory ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstNormalSnapshot.rhi.drawCount !== 3 ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.selectedVariant !== 'true' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.variantSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.postSwitchedAfterPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.falsifyPipeline !== true ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.capture.resizeHistory.join('>') !== noMsaaLivePostDoubleResizeExpectedHistory ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstFalsifierSnapshot.rhi.drawCount !== 2 ||
  noMsaaLivePostDoubleResizeRepeatNormalDiff !== undefined ||
  noMsaaLivePostDoubleResizeRepeatFalsifierDiff !== undefined ||
  noMsaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaLivePostDoubleResizeRepeatSecondPngDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatSecondPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.meanRgbDelta <= 0.01 ||
  noMsaaLivePostDoubleResizeRepeatSecondDawnDelta.changedPixels === 0 ||
  noMsaaLivePostDoubleResizeRepeatSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] no-MSAA live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: noMsaaLivePostDoubleResizeRepeatFirst.normal.status, firstFalsifier: noMsaaLivePostDoubleResizeRepeatFirst.falsifier.status, secondNormal: noMsaaLivePostDoubleResizeRepeatSecond.normal.status, secondFalsifier: noMsaaLivePostDoubleResizeRepeatSecond.falsifier.status }, normalDiff: noMsaaLivePostDoubleResizeRepeatNormalDiff, falsifierDiff: noMsaaLivePostDoubleResizeRepeatFalsifierDiff, firstPng: noMsaaLivePostDoubleResizeRepeatFirstPngDelta, secondPng: noMsaaLivePostDoubleResizeRepeatSecondPngDelta, firstDawn: noMsaaLivePostDoubleResizeRepeatFirstDawnDelta, secondDawn: noMsaaLivePostDoubleResizeRepeatSecondDawnDelta })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] no-MSAA live post double resize repeatability: PASS normalSha256=${noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.normalSha256} falsifierSha256=${noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.falsifierSha256} dawnChangedPixels=${noMsaaLivePostDoubleResizeRepeatFirstDawnDelta.changedPixels} pngChangedPixels=${noMsaaLivePostDoubleResizeRepeatFirstPngDelta.changedPixels}`,
);

const noMsaaFalseVariantLivePostDoubleResizeArtifactRoot = resolve(
  customRhiArtifactRoot,
  'no-msaa-live-post-false-variant-double-resize-repeatability',
);
const noMsaaFalseVariantLivePostDoubleResizeRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, pass);
  noMsaaFalseVariantLivePostDoubleResizeRuns.push({
    normal: run(
      `custom pipeline no-MSAA false-variant live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline no-MSAA false-variant live post double resize repeat ${pass} adjacent pipeline falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '0',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const noMsaaFalseVariantLivePostDoubleResizeFirst = noMsaaFalseVariantLivePostDoubleResizeRuns[0];
const noMsaaFalseVariantLivePostDoubleResizeSecond = noMsaaFalseVariantLivePostDoubleResizeRuns[1];
const noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal'),
);
const noMsaaFalseVariantLivePostDoubleResizeSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal'),
);
const noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier'),
);
const noMsaaFalseVariantLivePostDoubleResizeSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier'),
);
const noMsaaFalseVariantLivePostDoubleResizeNormalDiff = repeatabilityDiff(
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot,
  noMsaaFalseVariantLivePostDoubleResizeSecondNormalSnapshot,
);
const noMsaaFalseVariantLivePostDoubleResizeFalsifierDiff = repeatabilityDiff(
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot,
  noMsaaFalseVariantLivePostDoubleResizeSecondFalsifierSnapshot,
);
let noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta;
let noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta;
let noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta;
let noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta;
try {
  noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta = comparePngs(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta = comparePngs(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta = compareDawnReadbacks(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta = compareDawnReadbacks(
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(noMsaaFalseVariantLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] no-MSAA false-variant live post double resize repeatability delta: FAIL - ${error}`);
  failSmoke();
}
const noMsaaFalseVariantLivePostDoubleResizeExpectedHistory =
  '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const noMsaaFalseVariantLivePostDoubleResizeNormalCapture =
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.capture;
const noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture =
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.capture;
if (
  noMsaaFalseVariantLivePostDoubleResizeFirst.normal.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirst.falsifier.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecond.normal.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecond.falsifier.status !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.selectedVariant !== 'false' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.variantSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.postSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.falsifyPipeline !== false ||
  noMsaaFalseVariantLivePostDoubleResizeNormalCapture.resizeHistory.join('>') !== noMsaaFalseVariantLivePostDoubleResizeExpectedHistory ||
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstNormalSnapshot.rhi.drawCount !== 3 ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.selectedVariant !== 'false' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.antialias !== 'M3_ANTIALIAS=none' ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.postSwitchedAfterPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.falsifyPipeline !== true ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierCapture.resizeHistory.join('>') !== noMsaaFalseVariantLivePostDoubleResizeExpectedHistory ||
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.rhi.resolveTargetCount !== 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstFalsifierSnapshot.rhi.drawCount !== 2 ||
  noMsaaFalseVariantLivePostDoubleResizeNormalDiff !== undefined ||
  noMsaaFalseVariantLivePostDoubleResizeFalsifierDiff !== undefined ||
  noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta.meanRgbDelta <= 0.01 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.meanRgbDelta <= 0.01 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta.changedPixels === 0 ||
  noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] no-MSAA false-variant live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: noMsaaFalseVariantLivePostDoubleResizeFirst.normal.status, firstFalsifier: noMsaaFalseVariantLivePostDoubleResizeFirst.falsifier.status, secondNormal: noMsaaFalseVariantLivePostDoubleResizeSecond.normal.status, secondFalsifier: noMsaaFalseVariantLivePostDoubleResizeSecond.falsifier.status }, normalDiff: noMsaaFalseVariantLivePostDoubleResizeNormalDiff, falsifierDiff: noMsaaFalseVariantLivePostDoubleResizeFalsifierDiff, firstPng: noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta, secondPng: noMsaaFalseVariantLivePostDoubleResizeSecondPngDelta, firstDawn: noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta, secondDawn: noMsaaFalseVariantLivePostDoubleResizeSecondDawnDelta })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] no-MSAA false-variant live post double resize repeatability: PASS normalSha256=${noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.normalSha256} falsifierSha256=${noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.falsifierSha256} dawnChangedPixels=${noMsaaFalseVariantLivePostDoubleResizeFirstDawnDelta.changedPixels} pngChangedPixels=${noMsaaFalseVariantLivePostDoubleResizeFirstPngDelta.changedPixels}`,
);

const msaaFalseStartLivePostDoubleResizeArtifactRoot = resolve(
  customRhiArtifactRoot,
  'msaa-live-post-false-start-double-resize-repeatability',
);
const msaaFalseStartLivePostDoubleResizeRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, pass);
  msaaFalseStartLivePostDoubleResizeRuns.push({
    normal: run(
      `custom pipeline MSAA false-start live post double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false-start live post double resize repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY_MSAA_RESOLVE: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalseStartLivePostDoubleResizeFirst = msaaFalseStartLivePostDoubleResizeRuns[0];
const msaaFalseStartLivePostDoubleResizeSecond = msaaFalseStartLivePostDoubleResizeRuns[1];
const msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal'),
);
const msaaFalseStartLivePostDoubleResizeSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal'),
);
const msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier'),
);
const msaaFalseStartLivePostDoubleResizeSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier'),
);
const msaaFalseStartLivePostDoubleResizeNormalDiff = repeatabilityDiff(
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot,
  msaaFalseStartLivePostDoubleResizeSecondNormalSnapshot,
);
const msaaFalseStartLivePostDoubleResizeFalsifierDiff = repeatabilityDiff(
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot,
  msaaFalseStartLivePostDoubleResizeSecondFalsifierSnapshot,
);
let msaaFalseStartLivePostDoubleResizeFirstPngDelta;
let msaaFalseStartLivePostDoubleResizeSecondPngDelta;
let msaaFalseStartLivePostDoubleResizeFirstDawnDelta;
let msaaFalseStartLivePostDoubleResizeSecondDawnDelta;
try {
  msaaFalseStartLivePostDoubleResizeFirstPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostDoubleResizeSecondPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostDoubleResizeFirstDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  msaaFalseStartLivePostDoubleResizeSecondDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA false-start live post double resize repeatability delta: FAIL - ${error}`);
  failSmoke();
}
const msaaFalseStartLivePostDoubleResizeExpectedHistory =
  '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const msaaFalseStartLivePostDoubleResizeNormalCapture =
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.capture;
const msaaFalseStartLivePostDoubleResizeFalsifierCapture =
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.capture;
if (
  msaaFalseStartLivePostDoubleResizeFirst.normal.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeFirst.falsifier.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeSecond.normal.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeSecond.falsifier.status !== 0 ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.falsifyPipeline !== false ||
  msaaFalseStartLivePostDoubleResizeNormalCapture.resizeHistory.join('>') !== msaaFalseStartLivePostDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseStartLivePostDoubleResizeFirstNormalSnapshot.rhi.drawCount !== 3 ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.falsifyPipeline !== false ||
  msaaFalseStartLivePostDoubleResizeFalsifierCapture.resizeHistory.join('>') !== msaaFalseStartLivePostDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseStartLivePostDoubleResizeFirstFalsifierSnapshot.rhi.drawCount !== 3 ||
  msaaFalseStartLivePostDoubleResizeNormalDiff !== undefined ||
  msaaFalseStartLivePostDoubleResizeFalsifierDiff !== undefined ||
  msaaFalseStartLivePostDoubleResizeFirstPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeFirstPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostDoubleResizeSecondPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeSecondPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostDoubleResizeFirstDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeFirstDawnDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostDoubleResizeSecondDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostDoubleResizeSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] MSAA false-start live post double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: msaaFalseStartLivePostDoubleResizeFirst.normal.status, firstFalsifier: msaaFalseStartLivePostDoubleResizeFirst.falsifier.status, secondNormal: msaaFalseStartLivePostDoubleResizeSecond.normal.status, secondFalsifier: msaaFalseStartLivePostDoubleResizeSecond.falsifier.status }, normalDiff: msaaFalseStartLivePostDoubleResizeNormalDiff, falsifierDiff: msaaFalseStartLivePostDoubleResizeFalsifierDiff, firstPng: msaaFalseStartLivePostDoubleResizeFirstPngDelta, secondPng: msaaFalseStartLivePostDoubleResizeSecondPngDelta, firstDawn: msaaFalseStartLivePostDoubleResizeFirstDawnDelta, secondDawn: msaaFalseStartLivePostDoubleResizeSecondDawnDelta })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] MSAA false-start live post double resize repeatability: PASS normalSha256=${msaaFalseStartLivePostDoubleResizeFirstDawnDelta.normalSha256} falsifierSha256=${msaaFalseStartLivePostDoubleResizeFirstDawnDelta.falsifierSha256} dawnChangedPixels=${msaaFalseStartLivePostDoubleResizeFirstDawnDelta.changedPixels} pngChangedPixels=${msaaFalseStartLivePostDoubleResizeFirstPngDelta.changedPixels}`,
);

const msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot = resolve(
  customRhiArtifactRoot,
  'msaa-live-post-false-start-pipeline-double-resize-repeatability',
);
const msaaFalseStartLivePostPipelineDoubleResizeRuns = [];
for (const pass of ['first', 'second']) {
  const passRoot = resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, pass);
  msaaFalseStartLivePostPipelineDoubleResizeRuns.push({
    normal: run(
      `custom pipeline MSAA false-start live post adjacent pipeline double resize repeat ${pass} normal`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'normal'),
      },
    ),
    falsifier: run(
      `custom pipeline MSAA false-start live post adjacent pipeline double resize repeat ${pass} falsifier`,
      ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
      {
        FORGEAX_M3_MSAA: '1',
        FORGEAX_M3_POST: 'passthrough',
        FORGEAX_M3_VARIANT: 'false',
        FORGEAX_M3_SWITCH_VARIANT: '1',
        FORGEAX_M3_SWITCH_POST: '1',
        FORGEAX_M3_RESIZE_CHURN: '1',
        FORGEAX_M3_DOUBLE_RESIZE_CHURN: '1',
        FORGEAX_M3_FALSIFY: '1',
        FORGEAX_M3_ARTIFACT_DIR: resolve(passRoot, 'falsifier'),
      },
    ),
  });
}
const msaaFalseStartLivePostPipelineDoubleResizeFirst =
  msaaFalseStartLivePostPipelineDoubleResizeRuns[0];
const msaaFalseStartLivePostPipelineDoubleResizeSecond =
  msaaFalseStartLivePostPipelineDoubleResizeRuns[1];
const msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal'),
);
const msaaFalseStartLivePostPipelineDoubleResizeSecondNormalSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal'),
);
const msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier'),
);
const msaaFalseStartLivePostPipelineDoubleResizeSecondFalsifierSnapshot = readRepeatabilitySnapshot(
  resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier'),
);
const msaaFalseStartLivePostPipelineDoubleResizeNormalDiff = repeatabilityDiff(
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot,
  msaaFalseStartLivePostPipelineDoubleResizeSecondNormalSnapshot,
);
const msaaFalseStartLivePostPipelineDoubleResizeFalsifierDiff = repeatabilityDiff(
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot,
  msaaFalseStartLivePostPipelineDoubleResizeSecondFalsifierSnapshot,
);
let msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta;
let msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta;
let msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta;
let msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta;
try {
  msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta = comparePngs(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal', 'custom-live.png'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier', 'custom-live.png'),
  );
  msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'first', 'falsifier', 'dawn-readback.json'),
  );
  msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta = compareDawnReadbacks(
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'normal', 'dawn-readback.json'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.rgba'),
    resolve(msaaFalseStartLivePostPipelineDoubleResizeArtifactRoot, 'second', 'falsifier', 'dawn-readback.json'),
  );
} catch (error) {
  console.error(`[m3-programmable] MSAA false-start live post adjacent pipeline double resize delta: FAIL - ${error}`);
  failSmoke();
}
const msaaFalseStartLivePostPipelineDoubleResizeExpectedHistory =
  '640x360>480x270>720x405>640x360>480x270>720x405>640x360';
const msaaFalseStartLivePostPipelineDoubleResizeNormalCapture =
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.capture;
const msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture =
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.capture;
if (
  msaaFalseStartLivePostPipelineDoubleResizeFirst.normal.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirst.falsifier.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecond.normal.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecond.falsifier.status !== 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.falsifyPipeline !== false ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalCapture.resizeHistory.join('>') !==
    msaaFalseStartLivePostPipelineDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstNormalSnapshot.rhi.drawCount !== 3 ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.variant !== 'M3_MULTI_UV_VARIANT=true' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.post !== 'M3_POST_EFFECT=inversion' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.selectedVariant !== 'false' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.selectedPost !== 'M3_POST_EFFECT=passthrough' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.antialias !== 'M3_ANTIALIAS=msaa' ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.variantSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.postSwitchedAfterPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.falsifyPipeline !== true ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierCapture.resizeHistory.join('>') !==
    msaaFalseStartLivePostPipelineDoubleResizeExpectedHistory ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.rhi.msaaTextureResourceCount !== 2 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.rhi.resolveTargetCount !== 1 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstFalsifierSnapshot.rhi.drawCount !== 2 ||
  msaaFalseStartLivePostPipelineDoubleResizeNormalDiff !== undefined ||
  msaaFalseStartLivePostPipelineDoubleResizeFalsifierDiff !== undefined ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.meanRgbDelta <= 0.01 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta.changedPixels === 0 ||
  msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta.meanRgbDelta <= 0.01
) {
  console.error(
    `[m3-programmable] MSAA false-start live post adjacent pipeline double resize repeatability: FAIL - ${JSON.stringify({ statuses: { firstNormal: msaaFalseStartLivePostPipelineDoubleResizeFirst.normal.status, firstFalsifier: msaaFalseStartLivePostPipelineDoubleResizeFirst.falsifier.status, secondNormal: msaaFalseStartLivePostPipelineDoubleResizeSecond.normal.status, secondFalsifier: msaaFalseStartLivePostPipelineDoubleResizeSecond.falsifier.status }, normalDiff: msaaFalseStartLivePostPipelineDoubleResizeNormalDiff, falsifierDiff: msaaFalseStartLivePostPipelineDoubleResizeFalsifierDiff, firstPng: msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta, secondPng: msaaFalseStartLivePostPipelineDoubleResizeSecondPngDelta, firstDawn: msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta, secondDawn: msaaFalseStartLivePostPipelineDoubleResizeSecondDawnDelta })}`,
  );
  failSmoke();
}
console.log(
  `[m3-programmable] MSAA false-start live post adjacent pipeline double resize repeatability: PASS normalSha256=${msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.normalSha256} falsifierSha256=${msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.falsifierSha256} dawnChangedPixels=${msaaFalseStartLivePostPipelineDoubleResizeFirstDawnDelta.changedPixels} pngChangedPixels=${msaaFalseStartLivePostPipelineDoubleResizeFirstPngDelta.changedPixels}`,
);

const liveVariantArtifactRoot = resolve(customRhiArtifactRoot, 'live-variant-switch');
const liveVariant = run(
  'custom pipeline live variant switch',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(liveVariantArtifactRoot, 'normal'),
  },
);
const liveVariantFalsifier = run(
  'custom pipeline live variant switch falsifier',
  ['--filter', '@forgeax/hello-multi-uv', 'run', 'smoke:browser-rhi'],
  {
    FORGEAX_M3_VARIANT: 'true',
    FORGEAX_M3_SWITCH_VARIANT: '1',
    FORGEAX_M3_FALSIFY: '1',
    FORGEAX_M3_ARTIFACT_DIR: resolve(liveVariantArtifactRoot, 'falsifier'),
  },
);
if (
  liveVariant.status !== 0 ||
  !liveVariant.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false') ||
  !liveVariant.output.includes('draws=3') ||
  !liveVariant.output.includes('variantSwitch=true') ||
  liveVariantFalsifier.status !== 0 ||
  !liveVariantFalsifier.output.includes('pipeline=M3_PIPELINE=custom variant=M3_MULTI_UV_VARIANT=false') ||
  !liveVariantFalsifier.output.includes('draws=2') ||
  !liveVariantFalsifier.output.includes('variantSwitch=true')
) {
  console.error('[m3-programmable] custom pipeline live variant switch: FAIL - post-resize custom variant mutation did not pass');
  failSmoke();
}
console.log('[m3-programmable] custom pipeline live variant switch: PASS');
console.log('[m3-programmable] PASS - M3 programmable rendering gates GREEN');
}
