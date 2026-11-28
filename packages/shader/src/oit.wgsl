#define_import_path forgeax_material::oit
#import forgeax_depth_pyramid::sample::{linearizeViewDepth}

// Three.js r187 OITPassNode uses McGuire-Bavoil equation (9) on linear view
// depth. Scale both weighted sums by 1/8 to leave headroom in the FP16 targets:
// 64 layers * 2.0 radiance * 3000 / 8 = 48000, below the FP16 limit of 65504.
// The composite's denominator floor is scaled by the same factor.
const OIT_WEIGHT_MIN : f32 = 0.01;
const OIT_WEIGHT_MAX : f32 = 3000.0;
const OIT_WEIGHT_NUMERATOR : f32 = 0.03;
const OIT_WEIGHT_DEPTH_SCALE : f32 = 200.0;
const OIT_WEIGHT_BIAS : f32 = 0.00001;
const OIT_STORAGE_SCALE : f32 = 0.125;

struct OitOutput {
  // rgb = sum(c * a * w); alpha is blended as revealage prod(1 - a).
  @location(0) accum : vec4<f32>,
  // r = sum(a * w) on the r16float weight target.
  @location(1) weight : vec4<f32>,
};

fn oitDepthWeight(viewDepth : f32) -> f32 {
  let depth = max(viewDepth, 0.0) / OIT_WEIGHT_DEPTH_SCALE;
  let depthSquared = depth * depth;
  let denominator = OIT_WEIGHT_BIAS + depthSquared * depthSquared;
  return clamp(OIT_WEIGHT_NUMERATOR / denominator, OIT_WEIGHT_MIN, OIT_WEIGHT_MAX);
}

// `premultipliedColor` is c * a. Every OIT target shares one blend state:
// color one/one, alpha zero/one-minus-src-alpha.
fn oitAccumulate(premultipliedColor : vec3<f32>, alpha : f32, depth : f32, projection : vec4<f32>) -> OitOutput {
  if (!(alpha > 0.0)) {
    discard;
  }
  let a = min(alpha, 1.0);
  // A rasterized fragment at zero reversed depth lies on the far plane.
  let viewDepth = select(linearizeViewDepth(depth, projection), projection.y, depth == 0.0);
  let w = a * oitDepthWeight(viewDepth) * OIT_STORAGE_SCALE;
  var output : OitOutput;
  output.accum = vec4<f32>(premultipliedColor * w, a);
  output.weight = vec4<f32>(a * w, 0.0, 0.0, a);
  return output;
}
