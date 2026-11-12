#import forgeax_lighting::light_texture_resample_kernel::{ResampleParams, reconstructPixel, reducePixel}
@group(0) @binding(0) var<uniform> params : ResampleParams;
@group(0) @binding(1) var source : texture_2d<f32>;
@group(0) @binding(2) var previous : texture_2d<f32>;

struct ResampleVertexOutput {
  @builtin(position) position : vec4<f32>,
}

struct ResampleFragmentOutput {
  @location(0) floating : vec4<f32>,
  @location(1) normalized : vec4<f32>,
}

@vertex
fn light_texture_fullscreen(@builtin(vertex_index) vertexIndex : u32) -> ResampleVertexOutput {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  var output : ResampleVertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return output;
}

@fragment
fn light_texture_resample_fragment(@builtin(position) position : vec4<f32>) -> ResampleFragmentOutput {
  let pixel = vec2<u32>(floor(position.xy)) - params.viewportOrigin;
  var value = vec4<f32>(0.0);
  if (params.level == 0u) {
    value = reconstructPixel(
      source, params.sourceSize, params.grayscale, pixel,
      params.outputSizeAndRowAlignWords.x,
    );
  } else {
    value = reducePixel(previous, pixel);
  }
  var output : ResampleFragmentOutput;
  output.floating = value;
  output.normalized = clamp(value, vec4<f32>(0.0), vec4<f32>(1.0));
  return output;
}
