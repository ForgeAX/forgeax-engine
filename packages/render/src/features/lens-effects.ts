// Chromatic aberration follows UE's scene color fringe (PostProcessTonemap.usf:318-341,
// parameters PostProcessTonemap.cpp:709-733): a radial lens model where red and green are
// pulled toward the centre in proportion to wavelength and blue is the anchor. UE applies it
// to the linear scene color before Bloom is added and before tonemapping
// (Bloom is added at :525-526), so it is a separate linear-HDR pass ahead of Bloom.
// FilmShader noise mixing is adapted from
// Three.js b745e6cb7b098e4b56bb9a3dbb1ab0b480f35aa2 (MIT; see ../../NOTICE).
// VignetteShader supplies the centered RGB-mix model; the camera adds a soft edge.
import type { LensEffectsSnapshot } from '../components/lens-effects';
import type { RenderFeatureFullscreenProgramDeclaration } from './types';

export const LENS_EFFECTS_POST_PROCESS_ID = 'forgeax.lens-effects';
export const CHROMATIC_ABERRATION_POST_PROCESS_ID = 'forgeax.chromatic-aberration';

const CHROMATIC_ABERRATION_WGSL = /* wgsl */ `
struct Params {
  redScale: f32,
  greenScale: f32,
  startOffset: f32,
  _pad: f32,
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
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  // Blue and alpha stay at the pixel centre; the lens viewport spans [-1, 1].
  let center = textureLoad(scene, vec2<i32>(input.position.xy), 0);
  let lens = input.uv * 2.0 - 1.0;
  let pull = sign(lens) * saturate(abs(lens) - params.startOffset);
  let redUv = (lens - pull * params.redScale) * 0.5 + 0.5;
  let greenUv = (lens - pull * params.greenScale) * 0.5 + 0.5;
  return vec4<f32>(
    textureSampleLevel(scene, sceneSampler, redUv, 0.0).r,
    textureSampleLevel(scene, sceneSampler, greenUv, 0.0).g,
    center.b,
    center.a,
  );
}
`;

const LENS_EFFECTS_WGSL = /* wgsl */ `
struct Params {
  vignette: vec4<f32>,
  grainIntensity: f32,
  grainSize: f32,
  frame: u32,
  _pad: f32,
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
  // Input and output extents match; preserve the pixel without resampling.
  let center = textureLoad(scene, vec2<i32>(input.position.xy), 0);
  var color = center.rgb;
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

// Primary wavelengths in nm; lens aberration is roughly linear in wavelength (PostProcessTonemap.cpp:724-731).
const FRINGE_SCALE_RED = 0.007 * (611.3 - 464.3);
const FRINGE_SCALE_GREEN = 0.007 * (549.1 - 464.3);

export const LENS_EFFECTS_PROGRAM: RenderFeatureFullscreenProgramDeclaration = {
  kind: 'fullscreen-program',
  name: LENS_EFFECTS_POST_PROCESS_ID,
  source: LENS_EFFECTS_WGSL,
  reads: ['scene-color'],
  params: { byteSize: 48, defaultValue: packLensEffectsParams(undefined, 0) },
};

export const CHROMATIC_ABERRATION_PROGRAM: RenderFeatureFullscreenProgramDeclaration = {
  kind: 'fullscreen-program',
  name: CHROMATIC_ABERRATION_POST_PROCESS_ID,
  source: CHROMATIC_ABERRATION_WGSL,
  reads: ['scene-color'],
  params: { byteSize: 16, defaultValue: packChromaticAberrationParams(undefined) },
};

/** The fringe has work only at positive intensity; vignette and grain do not schedule it. */
export function chromaticAberrationActive(input: LensEffectsSnapshot | undefined): boolean {
  return (input?.chromaticAberration ?? 0) > 0;
}

/** Vignette and grain share the post-tonemap pass; the fringe alone does not schedule it. */
export function outputLensEffectsActive(input: LensEffectsSnapshot | undefined): boolean {
  return (input?.vignetteIntensity ?? 0) > 0 || (input?.grainIntensity ?? 0) > 0;
}

/** Percent intensity to per-channel lens-space scales, as UE's ChromaticAberrationParams. */
export function chromaticAberrationScales(
  intensity: number,
  startOffset: number,
): readonly [red: number, green: number] {
  if (startOffset >= 1) return [0, 0];
  const offset = (intensity * 0.01) / (1 - startOffset);
  return [offset * FRINGE_SCALE_RED, offset * FRINGE_SCALE_GREEN];
}

/** Red scale, green scale and start offset in lens-viewport units. */
export function packChromaticAberrationParams(input: LensEffectsSnapshot | undefined): Uint8Array {
  const startOffset = input?.chromaticAberrationStartOffset ?? 0;
  const [red, green] = chromaticAberrationScales(input?.chromaticAberration ?? 0, startOffset);
  return new Uint8Array(new Float32Array([red, green, startOffset, 0]).buffer);
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
    0,
    input?.grainIntensity ?? 0,
    input?.grainSize ?? 1,
    0,
    0,
    input?.vignetteColor[0] ?? 0,
    input?.vignetteColor[1] ?? 0,
    input?.vignetteColor[2] ?? 0,
    0,
  ]);
  new DataView(values.buffer).setUint32(24, frame >>> 0, true);
  return new Uint8Array(values.buffer);
}
