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

export const TSR_ANALYZE_WGSL = tsrSource(analyze, analyzeCommon, false);
export const TSR_RECONSTRUCT_WGSL = tsrSource(reconstruct, reconstructCommon, false);
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
export const TSR_RECONSTRUCT_VELOCITY_WGSL = tsrSource(reconstruct, reconstructCommon, true);
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
