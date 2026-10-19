// Image-based lens flare following the model and default parameters of Unreal
// Engine PostProcessLensFlares (71fe36aac5a8df5ccd66c763ffc902b29b6a9c43):
// threshold, disc bokeh, then 8 scaled ghost images masked by DiscMask(P) *
// DiscMask(0.8P). No Unreal code is used; the splat blur is replaced by a
// gather, which lets the guard band shrink from 2 to 1.25. Three.js
// Lensflare (d3b629c0c2097cec664ad16369bb6eae3b10e335, MIT; see NOTICE)
// supplies the mirrored ghost placement P * (1 - 2d).
import { ok } from '@forgeax/engine-types';
import { LENS_FLARE_GHOST_COUNT, type LensFlareSnapshot } from '../components/lens-flare';
import type { RenderFeature, RenderFeatureFullscreenProgramDeclaration } from './types';

export const LENS_FLARE_POST_PROCESS_ID = 'forgeax.lens-flare';
export const LENS_FLARE_PREFILTER_ID = 'forgeax.lens-flare.prefilter';
export const LENS_FLARE_BLUR_ID = 'forgeax.lens-flare.blur';
export const LENS_FLARE_COMPOSITE_ID = 'forgeax.lens-flare.composite';
export const LENS_FLARE_PARAMS_BYTES = 32 + LENS_FLARE_GHOST_COUNT * 16;
/** Gather taps of the disc bokeh. */
const LENS_FLARE_BOKEH_TAPS = 64;
/**
 * Screen extent the bokeh target covers. A gather only spreads a source by
 * the bokeh radius, at most 0.2 of the view at bokehSize 10, so content past
 * 1.25 is always zero; Unreal's splat keeps a guard band of 2.
 */
export const LENS_FLARE_GUARD_BAND = 1.25;

const common = /* wgsl */ `
const GUARD_BAND: f32 = ${LENS_FLARE_GUARD_BAND};
struct Params {
  control: vec4<f32>,
  tint: vec4<f32>,
  ghosts: array<vec4<f32>, ${LENS_FLARE_GHOST_COUNT}>,
};
struct Output {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var linearSampler: sampler;
@group(1) @binding(2) var<uniform> params: Params;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Output {
  let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return Output(vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0), uv);
}
fn disc_mask(x: vec2<f32>) -> f32 {
  let r = saturate(1.0 - dot(x, x));
  return r * r;
}
`;

// Guard-band UV g maps to screen offset X = (2g - 1) * GUARD_BAND at 1/8 of
// the view density. Each output texel box-filters 8x8 source pixels with 16
// bilinear taps; the subtractive threshold removes Unreal's hard-cut flicker,
// and Unreal's guard-band disc mask DiscMask(X / 2) is kept.
const prefilter = /* wgsl */ `${common}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let x = (input.uv * 2.0 - 1.0) * GUARD_BAND;
  let sceneUv = x * 0.5 + 0.5;
  if (any(sceneUv < vec2<f32>(0.0)) || any(sceneUv > vec2<f32>(1.0))) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  let texel = 1.0 / vec2<f32>(textureDimensions(source));
  var sum = vec3<f32>(0.0);
  for (var j = 0u; j < 4u; j += 1u) {
    for (var i = 0u; i < 4u; i += 1u) {
      let offset = (vec2<f32>(f32(i), f32(j)) - 1.5) * 2.0 * texel;
      let uv = clamp(sceneUv + offset, texel * 0.5, 1.0 - texel * 0.5);
      let color = min(textureSampleLevel(source, linearSampler, uv, 0.0).rgb, vec3<f32>(65504.0));
      let luminance = color.r + color.g + color.b;
      sum += color * (max(luminance - params.control.x, 0.0) / max(luminance, 1e-4));
    }
  }
  return vec4<f32>(sum * (disc_mask(x * 0.5) / 16.0), 1.0);
}
`;

// Vogel-spiral gather of a uniform disc; control.y is Unreal's diameter as a
// fraction of twice the view width, i.e. the radius in view widths.
const blur = /* wgsl */ `${common}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let dimensions = vec2<f32>(textureDimensions(source));
  let radius = params.control.y * dimensions.x / GUARD_BAND;
  var sum = vec3<f32>(0.0);
  for (var i = 0u; i < ${LENS_FLARE_BOKEH_TAPS}u; i += 1u) {
    let r = sqrt((f32(i) + 0.5) / ${LENS_FLARE_BOKEH_TAPS}.0) * radius;
    let theta = f32(i) * 2.39996323;
    let uv = input.uv + vec2<f32>(cos(theta), sin(theta)) * r / dimensions;
    sum += textureSampleLevel(source, linearSampler, uv, 0.0).rgb;
  }
  return vec4<f32>(sum / ${LENS_FLARE_BOKEH_TAPS}.0, 1.0);
}
`;

// Ghost i at screen position P reads the source offset X = P / scale_i;
// offsets outside the guard band hold no energy and are skipped.
const composite = /* wgsl */ `${common}
@group(1) @binding(3) var bokeh: texture_2d<f32>;
// Small, bright bokeh texels amplify fixed-precision hardware filter weights.
// Interpolate in f32 to keep ghost energy consistent across backends.
fn sample_bokeh(uv: vec2<f32>) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(bokeh));
  let p = uv * vec2<f32>(size) - 0.5;
  let base = vec2<i32>(floor(p));
  let f = fract(p);
  let a = textureLoad(bokeh, clamp(base, vec2<i32>(0), size - 1), 0).rgb;
  let b = textureLoad(bokeh, clamp(base + vec2<i32>(1, 0), vec2<i32>(0), size - 1), 0).rgb;
  let c = textureLoad(bokeh, clamp(base + vec2<i32>(0, 1), vec2<i32>(0), size - 1), 0).rgb;
  let d = textureLoad(bokeh, clamp(base + vec2<i32>(1, 1), vec2<i32>(0), size - 1), 0).rgb;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  let center = textureLoad(source, vec2<i32>(input.position.xy), 0);
  let p = input.uv * 2.0 - 1.0;
  let border = disc_mask(p) * disc_mask(p * 0.8);
  if (border <= 0.0) {
    return center;
  }
  var flare = vec3<f32>(0.0);
  for (var i = 0u; i < ${LENS_FLARE_GHOST_COUNT}u; i += 1u) {
    let ghost = params.ghosts[i];
    if (abs(ghost.w) < 1e-4) {
      continue;
    }
    let g = p / (ghost.w * 2.0 * GUARD_BAND) + 0.5;
    if (any(g < vec2<f32>(0.0)) || any(g > vec2<f32>(1.0))) {
      continue;
    }
    flare += ghost.rgb * sample_bokeh(g);
  }
  return vec4<f32>(center.rgb + flare * params.tint.rgb * border, center.a);
}
`;

export const LENS_FLARE_PROGRAMS: readonly RenderFeatureFullscreenProgramDeclaration[] = [
  {
    kind: 'fullscreen-program',
    name: LENS_FLARE_PREFILTER_ID,
    source: prefilter,
    reads: ['scene-color'],
    params: { byteSize: LENS_FLARE_PARAMS_BYTES, defaultValue: packLensFlareParams(undefined) },
  },
  {
    kind: 'fullscreen-program',
    name: LENS_FLARE_BLUR_ID,
    source: blur,
    reads: ['lens-flare-prefilter'],
    params: { byteSize: LENS_FLARE_PARAMS_BYTES, defaultValue: packLensFlareParams(undefined) },
  },
  {
    kind: 'fullscreen-program',
    name: LENS_FLARE_COMPOSITE_ID,
    source: composite,
    reads: ['scene-color', 'lens-flare-bokeh'],
    params: { byteSize: LENS_FLARE_PARAMS_BYTES, defaultValue: packLensFlareParams(undefined) },
  },
];

/** Standard owns placement; the ordinary feature host owns shader preparation. */
export function createLensFlareRenderFeature(): RenderFeature<readonly string[]> {
  return {
    identity: LENS_FLARE_POST_PROCESS_ID,
    requiredCapabilities: ['rgba16floatRenderable'],
    requiredFullscreenPostProcesses: LENS_FLARE_PROGRAMS.map((program) => ({
      identity: program.name,
      source: program.source,
    })),
    extract: (context) =>
      ok(
        context.views
          .filter((view) => view.render && view.selectedCamera?.lensFlare !== undefined)
          .map((view) => view.identity),
      ),
    plan: (views) =>
      ok({
        work: views.map((view) => ({
          scope: { view },
          resources: LENS_FLARE_PROGRAMS,
          passes: [],
        })),
      }),
  };
}

export function isLensFlarePostProcess(identity: string): boolean {
  return (
    identity === LENS_FLARE_POST_PROCESS_ID ||
    LENS_FLARE_PROGRAMS.some((program) => program.name === identity)
  );
}

/** One layout serves all three programs; intensity folds into the tint. */
export function packLensFlareParams(input: LensFlareSnapshot | undefined): Uint8Array {
  const values = new Float32Array(LENS_FLARE_PARAMS_BYTES / 4);
  values[0] = input?.threshold ?? 8;
  values[1] = (input?.bokehSize ?? 3) / 100;
  const intensity = input?.intensity ?? 0;
  for (let channel = 0; channel < 3; channel += 1)
    values[4 + channel] = (input?.tint[channel] ?? 1) * intensity;
  for (let ghost = 0; ghost < LENS_FLARE_GHOST_COUNT; ghost += 1) {
    for (let channel = 0; channel < 3; channel += 1)
      values[8 + ghost * 4 + channel] = input?.ghostTints[ghost * 3 + channel] ?? 0;
    values[8 + ghost * 4 + 3] = input?.ghostScales[ghost] ?? 0;
  }
  return new Uint8Array(values.buffer);
}
