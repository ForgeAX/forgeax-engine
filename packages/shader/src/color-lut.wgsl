// Standard output 3D LUT sampling. The sampler is fixed to clamp and linear.

struct ColorLutParams {
  strength: f32,
};

fn sampleColorLut(
  source: texture_3d<f32>,
  lutSampler: sampler,
  color: vec3<f32>,
  params: ColorLutParams,
) -> vec4<f32> {
  let clamped = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  let sampled = textureSampleLevel(source, lutSampler, clamped, 0.0);
  let amount = clamp(params.strength, 0.0, 1.0);
  return vec4<f32>(mix(color, sampled.rgb, amount), sampled.a);
}
