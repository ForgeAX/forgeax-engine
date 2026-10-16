// sharpen.wgsl — 3×3 sharpen-kernel post-process shader.
// Kernel: [-1,-1,-1; -1,9,-1; -1,-1,-1]. texelSize via textureDimensions.

struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) i : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; }
  if (i == 2u) { y = 3.0; }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let dims = vec2<f32>(textureDimensions(screenTexture, 0));
  let texelSize = 1.0 / dims;
  let uv = in.uv;

  let offsets = array<vec2<f32>, 9>(
    vec2<f32>(-texelSize.x,  texelSize.y), // top-left
    vec2<f32>( 0.0,           texelSize.y), // top-center
    vec2<f32>( texelSize.x,   texelSize.y), // top-right
    vec2<f32>(-texelSize.x,   0.0),         // center-left
    vec2<f32>( 0.0,           0.0),         // center
    vec2<f32>( texelSize.x,   0.0),         // center-right
    vec2<f32>(-texelSize.x,  -texelSize.y), // bottom-left
    vec2<f32>( 0.0,          -texelSize.y), // bottom-center
    vec2<f32>( texelSize.x,  -texelSize.y), // bottom-right
  );

  let kernel = array<f32, 9>(
    -1.0, -1.0, -1.0,
    -1.0,  9.0, -1.0,
    -1.0, -1.0, -1.0,
  );

  var col = vec3<f32>(0.0);
  for (var k = 0u; k < 9u; k++) {
    col += textureSample(screenTexture, screenSampler, uv + offsets[k]).rgb * kernel[k];
  }
  return vec4<f32>(col, 1.0);
}