#define_import_path forgeax_material::oit

// Weighted blended order-independent transparency (McGuire and Bavoil 2013,
// depth weight eq. 7 family). The renderer's CPU reference
// (packages/render/src/oit/weight.ts) implements this exact formula; a unit test
// parses the constants below and fails on any drift.
//
// `viewDistance` is the linear world-space distance from the camera origin. It
// is independent of the depth-buffer convention (the Standard lanes use
// reversed-Z) and identical for the Unlit and Standard programs.
//
// The upper clamp keeps the accumulated sum fp16-finite: the high-overdraw
// workload (64 layers) times the fixtures' maximum premultiplied radiance (2.0)
// times OIT_WEIGHT_MAX stays below 65504.
const OIT_WEIGHT_MIN : f32 = 0.01;
const OIT_WEIGHT_MAX : f32 = 500.0;
const OIT_WEIGHT_SCALE : f32 = 10.0;
const OIT_WEIGHT_NEAR : f32 = 5.0;
const OIT_WEIGHT_FAR : f32 = 200.0;
const OIT_WEIGHT_BIAS : f32 = 0.00001;
// Fragments below this opacity add nothing visible and are discarded.
const OIT_MIN_ALPHA : f32 = 0.001;

struct OitOutput {
  // rgb = sum(c * a * w); alpha is blended as revealage prod(1 - a).
  @location(0) accum : vec4<f32>,
  // r = sum(a * w) on the r16float weight target.
  @location(1) weight : vec4<f32>,
};

fn oitDepthWeight(viewDistance : f32) -> f32 {
  let d = max(viewDistance, 0.0);
  let near = d / OIT_WEIGHT_NEAR;
  let far = d / OIT_WEIGHT_FAR;
  let far2 = far * far;
  let denominator = OIT_WEIGHT_BIAS + near * near + far2 * far2 * far2;
  return clamp(OIT_WEIGHT_SCALE / denominator, OIT_WEIGHT_MIN, OIT_WEIGHT_MAX);
}

// `premultipliedColor` is c * a. Every OIT target shares one blend state:
// color one/one, alpha zero/one-minus-src-alpha.
fn oitAccumulate(premultipliedColor : vec3<f32>, alpha : f32, viewDistance : f32) -> OitOutput {
  if (!(alpha >= OIT_MIN_ALPHA)) {
    discard;
  }
  let a = min(alpha, 1.0);
  let w = oitDepthWeight(viewDistance);
  var output : OitOutput;
  output.accum = vec4<f32>(premultipliedColor * w, a);
  output.weight = vec4<f32>(a * w, 0.0, 0.0, a);
  return output;
}
