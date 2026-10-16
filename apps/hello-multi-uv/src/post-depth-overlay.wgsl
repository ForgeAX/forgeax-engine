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
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

@group(1) @binding(0) var screenTexture : texture_2d<f32>;
@group(1) @binding(1) var screenSampler : sampler;
struct DepthParams {
  strength : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
};
@group(1) @binding(2) var<uniform> params : DepthParams;
@group(1) @binding(3) var sceneDepth : texture_depth_2d;
@group(1) @binding(4) var depthSampler : sampler;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let color = textureSample(screenTexture, screenSampler, in.uv);
  let depthPosition = vec2<i32>(in.position.xy);
  let depth = textureLoad(sceneDepth, depthPosition, 0);
  let proximity = clamp(depth * 40.0, 0.0, 1.0);
  let depthColor = vec3<f32>(proximity, 0.35 + proximity * 0.65, 1.0 - proximity);
  let strength = clamp(0.72 + params.strength * 0.0, 0.0, 1.0);
  return vec4<f32>(mix(color.rgb, depthColor, strength), 1.0);
}
