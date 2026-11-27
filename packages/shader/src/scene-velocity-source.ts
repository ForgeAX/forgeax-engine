import common from './common.wgsl?raw';
import motionBlur from './motion-blur.wgsl?raw';
import temporal from './scene-temporal.wgsl?raw';
import reconstruction from './scene-velocity-reconstruction.wgsl?raw';

export const SCENE_VELOCITY_WITH_DEPTH_OVERRIDE = '64009';

import taa from './taa-resolve.wgsl?raw';

const view = common.match(
  /struct AtmosphereMedium\s*\{[\s\S]*?\n\};\s*struct View\s*\{[\s\S]*?\n\};/,
)?.[0];
if (view === undefined) throw new Error('Missing scene velocity View declarations');
export const SCENE_VELOCITY_RECONSTRUCTION_WGSL = [
  view,
  temporal.replace(/^#define_import_path.*$/gm, ''),
  reconstruction,
].join('\n');

export const TAA_SCENE_VELOCITY_WGSL = [
  SCENE_VELOCITY_RECONSTRUCTION_WGSL,
  '@group(1) @binding(14) var velocityDepth : texture_depth_2d;',
  '@group(1) @binding(15) var<uniform> velocityView : View;',
  taa
    .replace(/^#define_import_path.*$/gm, '')
    .replace('var currentTemporal : texture_2d<f32>;', 'var currentTemporal : texture_2d<u32>;')
    .replace(
      'fn closestCurrentTemporal(pixel : vec2<i32>, dimensions : vec2<i32>) -> TaaCurrentTemporal {',
      `fn closestCurrentTemporal(pixel : vec2<i32>, dimensions : vec2<i32>) -> TaaCurrentTemporal {
        if (params.hasOutputTemporal == 0u) {
          let closest = closestSceneVelocity(pixel, 1, velocityDepth, currentTemporal, velocityView);
          return TaaCurrentTemporal(closest.packed, closest.depthEdge);
        }`,
    )
    .replace(
      'vec2<i32>(textureDimensions(currentOutputTemporal))',
      'vec2<i32>(select(textureDimensions(velocityDepth), textureDimensions(currentOutputTemporal), params.hasOutputTemporal != 0u))',
    ),
].join('\n');

export const MOTION_BLUR_SCENE_VELOCITY_WGSL = [
  SCENE_VELOCITY_RECONSTRUCTION_WGSL,
  'struct FullscreenOutput { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32> };',
  'fn fullscreen_triangle(index : u32) -> FullscreenOutput { let uv = vec2<f32>(f32(index & 1u) * 2.0, f32(index & 2u)); return FullscreenOutput(vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0), uv); }',
  '@group(0) @binding(4) var velocityDepth : texture_depth_2d;',
  '@group(0) @binding(5) var<uniform> velocityView : View;',
  motionBlur
    .replace(/^#(?:define_import_path|import).*$/gm, '')
    .replaceAll('@group(1)', '@group(0)')
    .replace('flags : u32,', 'flags : u32,\n  jitterUv : vec2<f32>,')
    .replace('var sceneTemporal : texture_2d<f32>;', 'var sceneTemporal : texture_2d<u32>;')
    .replace('floor(colorUv *', 'floor((colorUv + params.jitterUv) *')
    .replace(
      'textureLoad(sceneTemporal, samplePixel, 0)',
      'sceneTemporalFromVelocity(samplePixel, velocityDepth, sceneTemporal, velocityView)',
    ),
].join('\n');
