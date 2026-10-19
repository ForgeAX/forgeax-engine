#define_import_path forgeax_view::tonemap

// @forgeax/engine-shader - Three r184 Output Transform module.
//
// The public modes and formulas are the Three.js r184 oracle. The numeric
// values are the binding contract mirrored by TONEMAP_SHADER_MODE in tonemap.ts.
// `reinhard-extended` remains Forgeax's existing luminance-domain curve; the
// distinct `reinhard` mode is Three's per-channel Reinhard curve.

#import forgeax_view::common::{FullscreenOutput, ditherUnorm8, fullscreen_triangle}
#import forgeax_view::output_encoding::{encodeOutput}
#import forgeax_view::tone_mapping::{mapTone}

// 32-byte layout mirrored by TONEMAP_PARAMS_LAYOUT in tonemap.ts.
struct TonemapParams {
  exposure   : f32,
  whitePoint : f32,
  mode       : u32,
  ditherEnabled : f32,
  // OUTPUT_GAMUT_* written by the renderer at record time.
  outputGamut : u32,
  // Used only by the fused LUT entry; the other entries retain this padding.
  lutStrength : f32,
  // Actual destination view extent, including its selected mip.
  outputSize : vec2<f32>,
};

@group(1) @binding(0) var hdr  : texture_2d<f32>;
@group(1) @binding(1) var samp : sampler;
@group(1) @binding(2) var<uniform> params : TonemapParams;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

fn mapTonemap(sample : vec3<f32>) -> vec3<f32> {
  return mapTone(sample, params.exposure, params.whitePoint, params.mode, params.outputGamut);
}

fn encodeFinal(linearColor : vec3<f32>, alpha : f32, position : vec4<f32>) -> vec4<f32> {
  let encoded = encodeOutput(linearColor, alpha, params.outputGamut);
  let outputRgb = select(
    encoded.rgb,
    ditherUnorm8(encoded.rgb, position.xy),
    params.ditherEnabled > 0.5,
  );
  return vec4<f32>(outputRgb, encoded.a);
}

fn sampleOutputSource(position : vec2<f32>) -> vec4<f32> {
  // Equal grids have exact texel correspondence, including binary16 endpoints.
  if all(vec2<f32>(textureDimensions(hdr)) == params.outputSize) {
    return textureLoad(hdr, vec2<i32>(position), 0);
  }
  return textureSample(hdr, samp, position / params.outputSize);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // Combined path: tone mapping and the one output encoding happen together.
  let source = sampleOutputSource(in.position.xy);
  return encodeFinal(mapTonemap(source.rgb), source.a, in.position);
}

@fragment
fn fs_tone_only(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // LUT-enabled path stops at linear LDR so the LUT never samples encoded data.
  let source = sampleOutputSource(in.position.xy);
  return vec4<f32>(mapTonemap(source.rgb), source.a);
}

@fragment
fn fs_encode_only(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // The final writer consumes linear LDR after LUT and optional FXAA.
  let source = sampleOutputSource(in.position.xy);
  return encodeFinal(source.rgb, source.a, in.position);
}

@fragment
fn fs_present(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // Receipt capture retains the encoded endpoint when the surface is not copyable.
  return sampleOutputSource(in.position.xy);
}

// The LUT path has the same two binary16 stores as tone -> LUT -> encode.
// Keep both rounding boundaries even though no intermediate textures are written.
@group(2) @binding(0) var outputLut : texture_3d<f32>;
@group(2) @binding(1) var outputLutSampler : sampler;

@fragment
fn fs_tone_lut_encode(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let source = sampleOutputSource(in.position.xy);
  let toned = quantizeToF16(vec4<f32>(mapTonemap(source.rgb), source.a));
  let mapped = textureSampleLevel(outputLut, outputLutSampler,
    clamp(toned.rgb, vec3<f32>(0.0), vec3<f32>(1.0)), 0.0);
  let graded = quantizeToF16(vec4<f32>(mix(toned.rgb, mapped.rgb, params.lutStrength), toned.a));
  return encodeFinal(graded.rgb, graded.a, in.position);
}
