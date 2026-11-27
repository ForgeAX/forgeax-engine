#define_import_path forgeax_view::smaa_blend

// SMAA 1x Medium, adapted from Three.js r184 SMAANode and SMAA v2.8.
// See the Three.js and SMAA licenses in packages/shader/NOTICE.
fn smaaWeight(blendTexture: texture_2d<f32>, p: vec2<i32>) -> vec4<f32> {
  return textureLoad(blendTexture, clamp(p, vec2<i32>(0), vec2<i32>(textureDimensions(blendTexture)) - 1), 0);
}
fn smaaBlend(
  source: texture_2d<f32>,
  blendTexture: texture_2d<f32>,
  p: vec2<i32>,
) -> vec4<f32> {
  let current = smaaWeight(blendTexture, p);
  let a = vec4<f32>(current.r, smaaWeight(blendTexture, p + vec2<i32>(0, 1)).g, current.b, smaaWeight(blendTexture, p + vec2<i32>(1, 0)).a);
  let color = textureLoad(source, p, 0);
  if (dot(a, vec4<f32>(1.0)) < 0.00001) { return color; }
  var offset = vec2<f32>(select(-a.b, a.a, a.a > a.b), select(-a.r, a.g, a.g > a.r));
  if (abs(offset.x) > abs(offset.y)) { offset.y = 0.0; } else { offset.x = 0.0; }
  let q = clamp(p + vec2<i32>(sign(offset)), vec2<i32>(0), vec2<i32>(textureDimensions(source)) - 1);
  // Standard supplies linear LDR; preserve that domain, including alpha, until its one OETF.
  return mix(color, textureLoad(source, q, 0), max(abs(offset.x), abs(offset.y)));
}
