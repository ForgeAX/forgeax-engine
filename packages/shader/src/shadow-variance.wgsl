// Two separable passes store Three r184's mean and standard deviation in RG16F.
struct Params { extent : vec2<f32>, radius : f32, samples : u32, outputToSource : vec4<f32> };
@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var depth : texture_depth_2d;
@group(0) @binding(2) var distribution : texture_2d<f32>;
@group(0) @binding(3) var linearSampler : sampler;
@vertex
fn vs_main(@builtin(vertex_index) vertex : u32) -> @builtin(position) vec4<f32> {
  let corners = array<vec2<f32>, 3>(vec2<f32>(-1, -1), vec2<f32>(3, -1), vec2<f32>(-1, 3));
  return vec4<f32>(corners[vertex], 0, 1);
}
fn offset(index : u32) -> f32 {
  if (params.samples <= 1u) { return 0.0; }
  return (-1.0 + f32(index) * 2.0 / f32(params.samples - 1u)) * params.radius;
}
@fragment
fn fs_vertical(@builtin(position) pixel : vec4<f32>) -> @location(0) vec2<f32> {
  var mean = 0.0;
  var squared = 0.0;
  for (var i = 0u; i < params.samples; i++) {
    let coord = vec2<i32>(clamp(floor(pixel.xy + vec2<f32>(0, offset(i))), vec2<f32>(0), params.extent - 1.0));
    // Native depth is reversed; retain source depth before half-float rounding.
    let value = 1.0 - textureLoad(depth, coord, 0);
    mean += value;
    squared += value * value;
  }
  mean /= f32(params.samples);
  squared /= f32(params.samples);
  return vec2<f32>(mean, sqrt(max(0.0, squared - mean * mean)));
}
@fragment
fn fs_horizontal(@builtin(position) pixel : vec4<f32>) -> @location(0) vec2<f32> {
  var mean = 0.0;
  var squared = 0.0;
  let size = vec2<f32>(textureDimensions(distribution));
  for (var i = 0u; i < params.samples; i++) {
    let coord = clamp(pixel.xy * params.outputToSource.x + vec2<f32>(offset(i), 0), vec2<f32>(0.5), params.extent - 0.5);
    let value = textureSampleLevel(distribution, linearSampler, coord / size, 0.0).rg;
    mean += value.x;
    squared += dot(value, value);
  }
  mean /= f32(params.samples);
  squared /= f32(params.samples);
  return vec2<f32>(mean, sqrt(max(0.0, squared - mean * mean)));
}
