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

/**
 * Resolve a four-sample opaque/nearest pair without divorcing color from depth.
 * The nearest hardware-depth sample owns both outputs: this shader publishes
 * its color while {@link SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL} publishes
 * the matching depth through an independent r32float target.
 */
export const SINGLE_LAYER_MEDIUM_MSAA_PAIRED_COLOR_WGSL = /* wgsl */ `
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

fn nearestSample(pixel : vec2<i32>) -> i32 {
  var selected = 0;
  var nearestDepth = textureLoad(sourceDepth, pixel, 0);
  for (var sample = 1; sample < 4; sample += 1) {
    let depth = textureLoad(sourceDepth, pixel, sample);
    if (depth > nearestDepth) {
      nearestDepth = depth;
      selected = sample;
    }
  }
  return selected;
}

@fragment
fn fs_main(input : FullscreenOutput) -> @location(0) vec4<f32> {
  let dimensions = textureDimensions(sourceDepth);
  let pixel = vec2<i32>(
    clamp(input.position.xy, vec2<f32>(0.0), vec2<f32>(dimensions) - vec2<f32>(1.0)),
  );
  return textureLoad(sourceColor, pixel, nearestSample(pixel));
}
`;

/** Publish the depth selected by the paired four-sample color resolver. */
export const SINGLE_LAYER_MEDIUM_MSAA_RAW_DEPTH_WGSL = /* wgsl */ `
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

@fragment
fn fs_main(input : FullscreenOutput) -> @location(0) f32 {
  let dimensions = textureDimensions(sourceDepth);
  let pixel = vec2<i32>(
    clamp(input.position.xy, vec2<f32>(0.0), vec2<f32>(dimensions) - vec2<f32>(1.0)),
  );
  var nearestDepth = textureLoad(sourceDepth, pixel, 0);
  for (var sample = 1; sample < 4; sample += 1) {
    nearestDepth = max(nearestDepth, textureLoad(sourceDepth, pixel, sample));
  }
  return nearestDepth;
}
`;
