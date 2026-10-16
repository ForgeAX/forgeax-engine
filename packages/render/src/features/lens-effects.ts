// RGBShiftShader channel sampling and FilmShader noise mixing are adapted from
// Three.js b745e6cb7b098e4b56bb9a3dbb1ab0b480f35aa2 (MIT; see ../../NOTICE).
// VignetteShader supplies the centered RGB-mix model; the camera adds a soft edge.
import { ok } from '@forgeax/engine-types';
import type { LensEffectsSnapshot } from '../components/lens-effects';
import type { RenderFeature } from './types';

export const LENS_EFFECTS_POST_PROCESS_ID = 'forgeax.lens-effects';

export const LENS_EFFECTS_WGSL = /* wgsl */ `
struct Params {
  vignette: vec4<f32>,
  grainIntensity: f32,
  grainSize: f32,
  frame: u32,
  chromaticAngle: f32,
  color: vec4<f32>,
};
struct Output {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var<uniform> params: Params;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Output {
  let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return Output(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0), uv);
}
fn grain_hash(pixel: vec2<u32>, frame: u32) -> f32 {
  var h = (pixel.x * 1597334677u) ^ (pixel.y * 3812015801u) ^ (frame * 2798796415u);
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return f32(h & 0x00ffffffu) / 16777216.0;
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let dimensions = vec2<f32>(textureDimensions(scene));
  // Input and output extents match; preserve the center channels without resampling.
  let center = textureLoad(scene, vec2<i32>(input.position.xy), 0);
  var color = center.rgb;
  if (params.vignette.w > 0.0) {
    // Three.js uses bottom-left UVs; negate Y for this top-left texture domain.
    let direction = vec2<f32>(cos(params.chromaticAngle), -sin(params.chromaticAngle));
    let offset = direction * params.vignette.w / dimensions;
    let halfTexel = 0.5 / dimensions;
    let redUv = clamp(input.uv + offset, halfTexel, 1.0 - halfTexel);
    let blueUv = clamp(input.uv - offset, halfTexel, 1.0 - halfTexel);
    color.r = textureSampleLevel(scene, sceneSampler, redUv, 0.0).r;
    color.b = textureSampleLevel(scene, sceneSampler, blueUv, 0.0).b;
  }
  let radius = length((input.uv - 0.5) * 2.0) / sqrt(2.0);
  let vignette = smoothstep(params.vignette.y, params.vignette.y + params.vignette.z, radius);
  color = mix(color, params.color.rgb, params.vignette.x * vignette);
  if (params.grainIntensity > 0.0) {
    let pixel = vec2<u32>(floor(input.position.xy / params.grainSize));
    let noise = clamp(0.1 + grain_hash(pixel, params.frame), 0.0, 1.0);
    color = mix(color, color + color * noise, params.grainIntensity);
  }
  return vec4<f32>(color, center.a);
}
`;

/** Standard owns placement; the ordinary feature host owns shader preparation. */
export function createLensEffectsRenderFeature(): RenderFeature<readonly string[]> {
  return {
    identity: LENS_EFFECTS_POST_PROCESS_ID,
    requiredCapabilities: ['rgba16floatRenderable'],
    requiredFullscreenPostProcesses: [
      { identity: LENS_EFFECTS_POST_PROCESS_ID, source: LENS_EFFECTS_WGSL },
    ],
    extract: (context) =>
      ok(
        context.views
          .filter((view) => view.render && view.selectedCamera?.lensEffects !== undefined)
          .map((view) => view.identity),
      ),
    plan: (views) =>
      ok({
        work: views.map((view) => ({
          scope: { view },
          resources: [
            {
              kind: 'fullscreen-program' as const,
              name: LENS_EFFECTS_POST_PROCESS_ID,
              source: LENS_EFFECTS_WGSL,
              reads: ['scene-color' as const],
              params: { byteSize: 48, defaultValue: packLensEffectsParams(undefined, 0) },
            },
          ],
          passes: [],
        })),
      }),
  };
}

/** The captured frame seed makes replay deterministic without a clock or texture. */
export function packLensEffectsParams(
  input: LensEffectsSnapshot | undefined,
  frame: number,
): Uint8Array {
  const values = new Float32Array([
    input?.vignetteIntensity ?? 0,
    input?.vignetteRadius ?? 0.5,
    input?.vignetteSoftness ?? 0.5,
    input?.chromaticAberration ?? 0,
    input?.grainIntensity ?? 0,
    input?.grainSize ?? 1,
    0,
    input?.chromaticAberrationAngle ?? 0,
    input?.vignetteColor[0] ?? 0,
    input?.vignetteColor[1] ?? 0,
    input?.vignetteColor[2] ?? 0,
    0,
  ]);
  new DataView(values.buffer).setUint32(24, frame >>> 0, true);
  return new Uint8Array(values.buffer);
}
