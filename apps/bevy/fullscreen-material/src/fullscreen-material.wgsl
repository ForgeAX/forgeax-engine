struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

struct FullscreenParams {
  intensity : f32,
  _pad0 : f32,
  _pad1 : f32,
  _pad2 : f32,
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

@group(1) @binding(0) var sceneTexture : texture_2d<f32>;
@group(1) @binding(1) var sceneSampler : sampler;
@group(1) @binding(2) var<uniform> params : FullscreenParams;

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let shift = params.intensity;
  return vec4<f32>(
    textureSample(sceneTexture, sceneSampler, in.uv + vec2<f32>(shift, -shift)).r,
    textureSample(sceneTexture, sceneSampler, in.uv + vec2<f32>(-shift, 0.0)).g,
    textureSample(sceneTexture, sceneSampler, in.uv + vec2<f32>(0.0, shift)).b,
    1.0,
  );
}
