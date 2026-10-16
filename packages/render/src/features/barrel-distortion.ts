/** One graph-valid identity for the barrel stage, feature and shader prewarm. */
export const BARREL_DISTORTION_POST_PROCESS_ID = 'fullscreen.forgeax.barrel-distortion';
export const BARREL_DISTORTION_FEATURE_IDENTITY = BARREL_DISTORTION_POST_PROCESS_ID;

import { ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import type { RenderFeaturePlan } from './plan';
import type { RenderFeature, RenderFeatureExtractContext, RenderFeaturePlanContext } from './types';

/**
 * The coordinate function is exported beside the production shader so a real
 * f32 device probe can compile exactly the same implementation.  Keeping the
 * probe source here avoids a second test-only equation that could drift from
 * the Standard pass.
 */
export const BARREL_DISTORTION_WGSL_COORDINATE = /* wgsl */ `
struct BarrelDistortionParams {
  strength : f32,
  centerX : f32,
  centerY : f32,
  radiusSquared : f32,
};

fn barrel_distortion_display_to_scene_uv(
  inputUv : vec2<f32>,
  params : BarrelDistortionParams,
  dimensions : vec2<f32>,
) -> vec2<f32> {
  let aspect = dimensions.x / max(dimensions.y, 1.0);
  let p = vec2<f32>(
    2.0 * aspect * (inputUv.x - params.centerX),
    2.0 * (inputUv.y - params.centerY),
  );
  let t = dot(p, p) / max(params.radiusSquared, 1e-6);
  let scale = (1.0 - params.strength) / (1.0 - params.strength * t);
  return clamp(
    vec2<f32>(
      params.centerX + (inputUv.x - params.centerX) * scale,
      params.centerY + (inputUv.y - params.centerY) * scale,
    ),
    vec2<f32>(0.0),
    vec2<f32>(1.0),
  );
}
`;

/**
 * Manifest-equivalent WGSL for the bounded analytic model.  The Standard
 * owner registers this source once and keeps the graph, encoder, and submit
 * lifecycle shared with every other fullscreen stage.
 */
export const BARREL_DISTORTION_WGSL = /* wgsl */ `${BARREL_DISTORTION_WGSL_COORDINATE}
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

fn fullscreen_triangle(vertex_index : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (vertex_index == 1u) { x = 3.0; }
  if (vertex_index == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var sceneColor : texture_2d<f32>;
@group(1) @binding(1) var sceneSampler : sampler;

@group(1) @binding(2) var<uniform> params : BarrelDistortionParams;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(input : FullscreenOutput) -> @location(0) vec4<f32> {
  let dimensions = vec2<f32>(textureDimensions(sceneColor));
  let sampleUv = barrel_distortion_display_to_scene_uv(input.uv, params, dimensions);
  return textureSampleLevel(sceneColor, sceneSampler, sampleUv, 0.0);
}
`;

/**
 * Ordinary feature registration for the Standard linear-LDR stage.
 * Standard still allocates the stage targets and chooses its position in the
 * post chain; this feature owns the executable fullscreen declaration that is
 * projected into that slot by the existing graph/encoder/submit path.
 */
export interface BarrelDistortionFeatureFrame {
  /** True only when the extracted camera requires a spatial warp this frame. */
  readonly views: readonly string[];
}

export function createBarrelDistortionRenderFeature(): RenderFeature<BarrelDistortionFeatureFrame> {
  return Object.freeze({
    identity: BARREL_DISTORTION_FEATURE_IDENTITY,
    requiredCapabilities: ['rgba16floatRenderable'] as const,
    requiredFullscreenPostProcesses: [
      { identity: BARREL_DISTORTION_POST_PROCESS_ID, source: BARREL_DISTORTION_WGSL },
    ],
    extract: (
      context: RenderFeatureExtractContext,
    ): Result<BarrelDistortionFeatureFrame, RenderError> =>
      ok({
        views: context.views
          .filter(
            (view) => view.render && (view.selectedCamera?.barrelDistortion?.strength ?? 0) > 0,
          )
          .map((view) => view.identity),
      }),
    plan: (
      data: BarrelDistortionFeatureFrame,
      _context: RenderFeaturePlanContext,
    ): Result<RenderFeaturePlan, RenderError> =>
      ok({
        work: data.views.map((view) => ({
          scope: { view },
          resources: [
            {
              kind: 'fullscreen-program' as const,
              name: BARREL_DISTORTION_POST_PROCESS_ID,
              source: BARREL_DISTORTION_WGSL,
              reads: ['ldrColor'],
              params: { byteSize: 16, defaultValue: new Uint8Array(16) },
            },
            {
              kind: 'graphics-program' as const,
              name: 'barrel-distortion-pipeline',
              program: {
                shader: BARREL_DISTORTION_POST_PROCESS_ID,
                vertexLayout: 'none',
                colorFormats: ['rgba16float'],
                sampleCount: 1,
              },
            },
            {
              kind: 'graphics-bindings' as const,
              name: 'barrel-distortion-bindings',
              program: 'barrel-distortion-pipeline',
              values: {
                group: 1,
                fullscreen: true,
                shader: BARREL_DISTORTION_POST_PROCESS_ID,
                input: 'barrel-input',
              },
              logicalTargets: { input: 'barrel-input' },
            },
          ],
          passes: [
            {
              kind: 'raster' as const,
              name: 'barrel-distortion',
              colorAttachments: [
                { target: 'barrel-output', loadOp: 'clear' as const, storeOp: 'store' as const },
              ],
              sampledTargets: ['barrel-input'],
              draws: [
                {
                  program: 'barrel-distortion-pipeline',
                  bindings: ['barrel-distortion-bindings'],
                  vertexData: [],
                  vertexLayout: 'none' as const,
                  draw: { kind: 'draw' as const, vertexCount: 3, instanceCount: 1 },
                },
              ],
            },
          ],
        })),
      }),
  });
}
