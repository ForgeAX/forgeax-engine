/**
 * Renderer-owned raw-depth copy used by the single-layer medium producer.
 *
 * The source depth attachment is sampled only by this independent producer.
 * Medium materials bind the resulting r32float texture, so their color pass
 * never aliases the scene depth attachment that it writes.
 */
export const SINGLE_LAYER_MEDIUM_RAW_DEPTH_WGSL = /* wgsl */ `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
}

@group(1) @binding(0) var sourceColor : texture_2d<f32>;
@group(1) @binding(1) var sourceSampler : sampler;
@group(1) @binding(3) var sourceDepth : texture_depth_2d;
@group(1) @binding(4) var sourceDepthSampler : sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output : FullscreenOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(input : FullscreenOutput) -> @location(0) f32 {
  let dimensions = textureDimensions(sourceDepth);
  let pixel = vec2<i32>(
    clamp(input.position.xy, vec2<f32>(0.0), vec2<f32>(dimensions) - vec2<f32>(1.0)),
  );
  return textureLoad(sourceDepth, pixel, 0);
}
`;

const MEDIUM_MSAA_RESOLVE_INPUT = /* wgsl */ `
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
}

@group(1) @binding(0) var sourceColor : texture_multisampled_2d<f32>;
@group(1) @binding(1) var sourceSampler : sampler;
@group(1) @binding(3) var sourceDepth : texture_depth_multisampled_2d;
@group(1) @binding(4) var sourceDepthSampler : sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output : FullscreenOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return output;
}

`;

const MEDIUM_MSAA_RESOLVE_SELECTION = /* wgsl */ `
struct NearestSample {
  index: i32,
  depth: f32,
}

fn nearestSample(pixel: vec2<i32>) -> NearestSample {
  var result = NearestSample(0, textureLoad(sourceDepth, pixel, 0));
  for (var sample = 1; sample < 4; sample += 1) {
    let depth = textureLoad(sourceDepth, pixel, sample);
    if (depth > result.depth) {
      result = NearestSample(sample, depth);
    }
  }
  return result;
}

fn resolvePixel(input: FullscreenOutput) -> vec2<i32> {
  let dimensions = textureDimensions(sourceDepth);
  return vec2<i32>(
    clamp(input.position.xy, vec2<f32>(0.0), vec2<f32>(dimensions) - vec2<f32>(1.0)),
  );
}
`;

/** One depth scan publishes both outputs from the same MSAA sample. */
export const SINGLE_LAYER_MEDIUM_MSAA_PAIRED_WGSL = /* wgsl */ `
${MEDIUM_MSAA_RESOLVE_INPUT}
${MEDIUM_MSAA_RESOLVE_SELECTION}
struct PairedOutput {
  @location(0) color: vec4<f32>,
  @location(1) depth: f32,
}
@fragment
fn fs_main(input: FullscreenOutput) -> PairedOutput {
  let pixel = resolvePixel(input);
  let selected = nearestSample(pixel);
  return PairedOutput(textureLoad(sourceColor, pixel, selected.index), selected.depth);
}
`;

/** Resolve the color of the nearest hardware-depth sample. */
export const SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_WGSL = /* wgsl */ `
${MEDIUM_MSAA_RESOLVE_INPUT}
${MEDIUM_MSAA_RESOLVE_SELECTION}
@fragment
fn fs_main(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let pixel = resolvePixel(input);
  return textureLoad(sourceColor, pixel, nearestSample(pixel).index);
}
`;

/** Resolve the nearest hardware depth. */
export const SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL = /* wgsl */ `
${MEDIUM_MSAA_RESOLVE_INPUT}
${MEDIUM_MSAA_RESOLVE_SELECTION}
@fragment
fn fs_main(input: FullscreenOutput) -> @location(0) f32 {
  return nearestSample(resolvePixel(input)).depth;
}
`;
