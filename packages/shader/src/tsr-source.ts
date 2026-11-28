import temporal from './scene-temporal.wgsl?raw';
import { SCENE_VELOCITY_RECONSTRUCTION_WGSL } from './scene-velocity-source';
import analyze from './tsr-analyze.wgsl?raw';
import analyzeCommon from './tsr-analyze-common.wgsl?raw';
import analyzeFragment from './tsr-analyze-fragment.wgsl?raw';
import clamp from './tsr-clamp.wgsl?raw';
import clampFragment from './tsr-clamp-fragment.wgsl?raw';
import common from './tsr-common.wgsl?raw';
import dilate from './tsr-dilate.wgsl?raw';
import dilateCommon from './tsr-dilate-common.wgsl?raw';
import dilateFragment from './tsr-dilate-fragment.wgsl?raw';
import flickerLuma from './tsr-flicker-luma.wgsl?raw';
import flickerLumaFragment from './tsr-flicker-luma-fragment.wgsl?raw';
import fullscreen from './tsr-fullscreen.wgsl?raw';
import measure from './tsr-measure.wgsl?raw';
import measureFragment from './tsr-measure-fragment.wgsl?raw';
import moire from './tsr-moire.wgsl?raw';
import moireClamp from './tsr-moire-clamp.wgsl?raw';
import moireClampFragment from './tsr-moire-clamp-fragment.wgsl?raw';
import moireCommon from './tsr-moire-common.wgsl?raw';
import moireHistory from './tsr-moire-history.wgsl?raw';
import moireHistoryFragment from './tsr-moire-history-fragment.wgsl?raw';
import moireMeasure from './tsr-moire-measure.wgsl?raw';
import moireMeasureFragment from './tsr-moire-measure-fragment.wgsl?raw';
import moireUpdate from './tsr-moire-update.wgsl?raw';
import moireUpdateFragment from './tsr-moire-update-fragment.wgsl?raw';
import opaque from './tsr-opaque.wgsl?raw';
import opaqueFragment from './tsr-opaque-fragment.wgsl?raw';
import reconstruct from './tsr-reconstruct.wgsl?raw';
import reconstructCommon from './tsr-reconstruct-common.wgsl?raw';
import reconstructFragment from './tsr-reconstruct-fragment.wgsl?raw';
import reject from './tsr-reject.wgsl?raw';
import rejectCommon from './tsr-reject-common.wgsl?raw';
import rejectFragment from './tsr-reject-fragment.wgsl?raw';
import rejectFused from './tsr-reject-fused.wgsl?raw';
import resolve from './tsr-resolve.wgsl?raw';
import resolveCommon from './tsr-resolve-common.wgsl?raw';
import resolveFragment from './tsr-resolve-fragment.wgsl?raw';
import resurrectCommon from './tsr-resurrect-common.wgsl?raw';
import resurrectGuide from './tsr-resurrect-guide.wgsl?raw';
import resurrectGuideFragment from './tsr-resurrect-guide-fragment.wgsl?raw';
import resurrectMeasure from './tsr-resurrect-measure.wgsl?raw';
import resurrectMeasureFragment from './tsr-resurrect-measure-fragment.wgsl?raw';
import spatial from './tsr-spatial.wgsl?raw';
import spatialCommon from './tsr-spatial-common.wgsl?raw';
import spatialFragment from './tsr-spatial-fragment.wgsl?raw';

// Reuse the sole temporal-v1 decoder. The module marker is composition metadata.
const sceneData = temporal.replace(/^#define_import_path.*$/gm, '');

const loadedTemporal = `
fn loadSceneTemporal(pixel : vec2<i32>) -> vec4<f32> { return textureLoad(sceneTemporal, pixel, 0); }
fn tsrClosestSceneTemporalAt(center : vec2<i32>, radius : i32) -> TsrGeometry {
  return tsrClosestTemporalAt(sceneTemporal, center, radius);
}
`;

const velocityTemporal = `
@group(0) @binding(17) var velocityDepth : texture_depth_2d;
@group(0) @binding(18) var<uniform> velocityView : View;
fn loadSceneTemporal(pixel : vec2<i32>) -> vec4<f32> {
  return sceneTemporalFromVelocity(pixel, velocityDepth, sceneTemporal, velocityView);
}
fn tsrClosestSceneTemporalAt(center : vec2<i32>, radius : i32) -> TsrGeometry {
  let closest = closestSceneVelocity(center, radius, velocityDepth, sceneTemporal, velocityView);
  return TsrGeometry(closest.packed, closest.depthEdge);
}
`;

const closestScene = `
fn tsrClosestSceneTemporal(uv : vec2<f32>, radius : i32) -> TsrGeometry {
  return tsrClosestSceneTemporalAt(tsrPixel(uv, textureDimensions(sceneTemporal)), radius);
}
`;

function tsrSource(stage: string, logic: string, velocity: boolean): string {
  return [
    velocity ? SCENE_VELOCITY_RECONSTRUCTION_WGSL : sceneData,
    common,
    velocity
      ? stage.replace('var sceneTemporal: texture_2d<f32>;', 'var sceneTemporal: texture_2d<u32>;')
      : stage,
    velocity ? velocityTemporal : loadedTemporal,
    closestScene,
    logic,
  ].join('\n');
}

// Analysis reads the dilated tuples and previous-frame textures, never the raw scene tuple source.
const analysisSource = (stage: string) => [sceneData, common, stage, analyzeCommon].join('\n');
const noHalfOutput = /* wgsl */ `
fn tsrPublishHalf(pixel: vec2<u32>, lane: u32, size: vec2<u32>, color: vec4<f32>) {}
`;

const halfOutput = /* wgsl */ `
@group(0) @binding(17) var halfColorOutput: texture_storage_2d<rgba16float, write>;
// Quantize each lane to match a separate read of the resolved FP16 color.
// Clamped lanes compute the border pixel to fill the last 2x2 footprint.
var<workgroup> tileColor: array<vec2<u32>, 64>;
fn tsrPublishHalf(pixel: vec2<u32>, lane: u32, size: vec2<u32>, color: vec4<f32>) {
  tileColor[lane] = vec2<u32>(pack2x16float(color.xy), pack2x16float(color.zw));
  workgroupBarrier();
  if (all(pixel < size) && all(pixel % 2u == vec2<u32>(0u))) {
    let a = tileColor[lane];
    let b = tileColor[lane + 1u];
    let c = tileColor[lane + 8u];
    let d = tileColor[lane + 9u];
    let xy = (unpack2x16float(a.x) + unpack2x16float(b.x) + unpack2x16float(c.x) + unpack2x16float(d.x)) * 0.25;
    let zw = (unpack2x16float(a.y) + unpack2x16float(b.y) + unpack2x16float(c.y) + unpack2x16float(d.y)) * 0.25;
    textureStore(halfColorOutput, vec2<i32>(pixel / 2u), vec4<f32>(xy, zw));
  }
}
`;

// The half-output program needs every lane to reach the box filter barrier.
const guardedReconstruct = reconstruct.replace(
  '// TSR_RECONSTRUCTION_EDGE_GUARD',
  'if (!inside) { return; }',
);

export const TSR_ANALYZE_WGSL = analysisSource(analyze);
export const TSR_DILATE_WGSL = tsrSource(dilate, dilateCommon, false);
export const TSR_DILATE_VELOCITY_WGSL = tsrSource(dilate, dilateCommon, true);
export const TSR_DILATE_FRAGMENT_WGSL = tsrSource(fullscreen + dilateFragment, dilateCommon, false);
export const TSR_DILATE_FRAGMENT_VELOCITY_WGSL = tsrSource(
  fullscreen + dilateFragment,
  dilateCommon,
  true,
);
// Reconstruct consumes pre-dilated tuples from tsr-dilate, never raw scene velocity.
const reconstructSource = (stage: string) =>
  [sceneData, common, stage, reconstructCommon].join('\n');
export const TSR_RECONSTRUCT_WGSL = reconstructSource(noHalfOutput + guardedReconstruct);
export const TSR_RECONSTRUCT_HALF_WGSL = reconstructSource(halfOutput + reconstruct);
export const TSR_OPAQUE_WGSL = `${sceneData}\n${common}\n${opaque}`;
export const TSR_ANALYZE_FRAGMENT_WGSL = analysisSource(fullscreen + analyzeFragment);
export const TSR_RECONSTRUCT_FRAGMENT_WGSL = reconstructSource(fullscreen + reconstructFragment);
// Shading rejection stages read only their declared input-resolution textures.
const rejectionSource = (stage: string) => [sceneData, common, stage, rejectCommon].join('\n');
export const TSR_CLAMP_WGSL = rejectionSource(clamp);
export const TSR_MEASURE_WGSL = rejectionSource(measure);
export const TSR_REJECT_WGSL = rejectionSource(reject);
export const TSR_REJECT_FUSED_WGSL = rejectionSource(rejectFused);
export const TSR_CLAMP_FRAGMENT_WGSL = rejectionSource(fullscreen + clampFragment);
export const TSR_MEASURE_FRAGMENT_WGSL = rejectionSource(fullscreen + measureFragment);
export const TSR_REJECT_FRAGMENT_WGSL = rejectionSource(fullscreen + rejectFragment);
// The resurrected guide is clamped by the unchanged clamp stage and measured without flicker error.
export const TSR_RESURRECT_MEASURE_WGSL = rejectionSource(resurrectMeasure);
export const TSR_RESURRECT_MEASURE_FRAGMENT_WGSL = rejectionSource(
  fullscreen + resurrectMeasureFragment,
);
// UE DecimateHistory resurrection reprojection of the persistent snapshot guide.
const resurrectSource = (stage: string) => [sceneData, common, stage, resurrectCommon].join('\n');
export const TSR_RESURRECT_GUIDE_WGSL = resurrectSource(resurrectGuide);
export const TSR_RESURRECT_GUIDE_FRAGMENT_WGSL = resurrectSource(
  fullscreen + resurrectGuideFragment,
);
// UE TSRSpatialAntiAliasing reads scene color and the reject decision at the input lattice.
const spatialSource = (stage: string) => [sceneData, common, stage, spatialCommon].join('\n');
export const TSR_SPATIAL_WGSL = spatialSource(spatial);
export const TSR_SPATIAL_FRAGMENT_WGSL = spatialSource(fullscreen + spatialFragment);
// UE TSRResolveHistory downsamples the history to the output lattice.
const resolveSource = (stage: string) => [sceneData, common, stage, resolveCommon].join('\n');
export const TSR_RESOLVE_WGSL = resolveSource(resolve);
export const TSR_RESOLVE_FRAGMENT_WGSL = resolveSource(fullscreen + resolveFragment);
// UE MeasureFlickeringLuma reads scene color at the input lattice.
const flickerLumaSource = (stage: string) => [sceneData, common, stage].join('\n');
export const TSR_FLICKER_LUMA_WGSL = flickerLumaSource(flickerLuma);
export const TSR_FLICKER_LUMA_FRAGMENT_WGSL = flickerLumaSource(fullscreen + flickerLumaFragment);
// UE ComputeMoireError: fused single-pass compute + multi-pass raster fallback.
const moireSource = (stage: string) =>
  [sceneData, common, stage, rejectCommon, moireCommon].join('\n');
export const TSR_MOIRE_WGSL = moireSource(moire);
export const TSR_MOIRE_CLAMP_WGSL = moireSource(moireClamp);
export const TSR_MOIRE_MEASURE_WGSL = moireSource(moireMeasure);
export const TSR_MOIRE_UPDATE_WGSL = moireSource(moireUpdate);
export const TSR_MOIRE_HISTORY_WGSL = moireSource(moireHistory);
export const TSR_MOIRE_CLAMP_FRAGMENT_WGSL = moireSource(fullscreen + moireClampFragment);
export const TSR_MOIRE_MEASURE_FRAGMENT_WGSL = moireSource(fullscreen + moireMeasureFragment);
export const TSR_MOIRE_UPDATE_FRAGMENT_WGSL = moireSource(fullscreen + moireUpdateFragment);
export const TSR_MOIRE_HISTORY_FRAGMENT_WGSL = moireSource(fullscreen + moireHistoryFragment);
export const TSR_OPAQUE_FRAGMENT_WGSL = `${sceneData}\n${common}\n${fullscreen}\n${opaqueFragment}`;

export const TSR_RECONSTRUCT_VELOCITY_WGSL = TSR_RECONSTRUCT_WGSL;
export const TSR_RECONSTRUCT_HALF_VELOCITY_WGSL = TSR_RECONSTRUCT_HALF_WGSL;
export const TSR_RECONSTRUCT_FRAGMENT_VELOCITY_WGSL = TSR_RECONSTRUCT_FRAGMENT_WGSL;
