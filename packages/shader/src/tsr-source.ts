import temporal from './scene-temporal.wgsl?raw';
import { SCENE_VELOCITY_RECONSTRUCTION_WGSL } from './scene-velocity-source';
import analyze from './tsr-analyze.wgsl?raw';
import analyzeCommon from './tsr-analyze-common.wgsl?raw';
import analyzeFragment from './tsr-analyze-fragment.wgsl?raw';
import common from './tsr-common.wgsl?raw';
import fullscreen from './tsr-fullscreen.wgsl?raw';
import opaque from './tsr-opaque.wgsl?raw';
import opaqueFragment from './tsr-opaque-fragment.wgsl?raw';
import reconstruct from './tsr-reconstruct.wgsl?raw';
import reconstructCommon from './tsr-reconstruct-common.wgsl?raw';
import reconstructFragment from './tsr-reconstruct-fragment.wgsl?raw';

// Reuse the sole temporal-v1 decoder. The module marker is composition metadata.
const sceneData = temporal.replace(/^#define_import_path.*$/gm, '');

const loadedTemporal = `
fn loadSceneTemporal(pixel : vec2<i32>) -> vec4<f32> { return textureLoad(sceneTemporal, pixel, 0); }
fn tsrClosestSceneTemporalAt(center : vec2<i32>, radius : i32) -> TsrGeometry {
  return tsrClosestTemporalAt(sceneTemporal, center, radius);
}
`;

const velocityTemporal = `
@group(0) @binding(14) var velocityDepth : texture_depth_2d;
@group(0) @binding(15) var<uniform> velocityView : View;
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

const noHalfOutput = /* wgsl */ `
fn tsrPublishHalf(pixel: vec2<u32>, lane: u32, size: vec2<u32>, color: vec4<f32>) {}
`;

const halfOutput = /* wgsl */ `
@group(0) @binding(13) var halfColorOutput: texture_storage_2d<rgba16float, write>;
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

export const TSR_ANALYZE_WGSL = tsrSource(analyze, analyzeCommon, false);
export const TSR_RECONSTRUCT_WGSL = tsrSource(
  noHalfOutput + guardedReconstruct,
  reconstructCommon,
  false,
);
export const TSR_RECONSTRUCT_HALF_WGSL = tsrSource(
  halfOutput + reconstruct,
  reconstructCommon,
  false,
);
export const TSR_OPAQUE_WGSL = `${sceneData}\n${common}\n${opaque}`;
export const TSR_ANALYZE_FRAGMENT_WGSL = tsrSource(
  fullscreen + analyzeFragment,
  analyzeCommon,
  false,
);
export const TSR_RECONSTRUCT_FRAGMENT_WGSL = tsrSource(
  fullscreen + reconstructFragment,
  reconstructCommon,
  false,
);
export const TSR_OPAQUE_FRAGMENT_WGSL = `${sceneData}\n${common}\n${fullscreen}\n${opaqueFragment}`;

export const TSR_ANALYZE_VELOCITY_WGSL = tsrSource(analyze, analyzeCommon, true);
export const TSR_RECONSTRUCT_VELOCITY_WGSL = tsrSource(
  noHalfOutput + guardedReconstruct,
  reconstructCommon,
  true,
);
export const TSR_RECONSTRUCT_HALF_VELOCITY_WGSL = tsrSource(
  halfOutput + reconstruct,
  reconstructCommon,
  true,
);
export const TSR_ANALYZE_FRAGMENT_VELOCITY_WGSL = tsrSource(
  fullscreen + analyzeFragment,
  analyzeCommon,
  true,
);
export const TSR_RECONSTRUCT_FRAGMENT_VELOCITY_WGSL = tsrSource(
  fullscreen + reconstructFragment,
  reconstructCommon,
  true,
);
