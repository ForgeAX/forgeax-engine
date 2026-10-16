#define_import_path forgeax_pbr::lighting_ies_profile

#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{iesProfileTexture, spotModifierSampler}
#endif

// The cooked Type-C grid includes both polar endpoints and one periodic turn
// of azimuth. Sample their texel centers so the repeating shared sampler never
// blends opposite poles or shifts an asymmetric profile by half a texel.
fn sampleIesProfile(localDirection : vec3<f32>, slice : u32) -> f32 {
#ifdef EXTENDED_LIGHTING_AVAILABLE
  if (slice == 0xffffffffu) { return 1.0; }
  let lengthSquared = dot(localDirection, localDirection);
  if (lengthSquared <= 1e-12) { return 1.0; }
  let outgoing = localDirection * inverseSqrt(lengthSquared);
  var azimuth = 0.0;
  if (dot(outgoing.xy, outgoing.xy) > 1e-12) {
    azimuth = atan2(outgoing.y, outgoing.x) / 6.283185307;
  }
  let polar = acos(clamp(outgoing.z, -1.0, 1.0)) / 3.14159265;
  let uv = vec2<f32>(azimuth + 0.5 / 256.0, (polar * 127.0 + 0.5) / 128.0);
  return max(textureSampleLevel(iesProfileTexture, spotModifierSampler, uv, slice, 0.0).r, 0.0);
#else
  return 1.0;
#endif
}

// Point and Rect use the authored Transform frame. Re-orthogonalization makes
// photometry independent of scale/shear; Rect still retains its LTC dimensions.
fn iesProfileFactor(
  lightPos : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  worldPos : vec3<f32>, slice : u32,
) -> f32 {
#ifdef EXTENDED_LIGHTING_AVAILABLE
  if (slice == 0xffffffffu) { return 1.0; }
  let normal = cross(axisX, axisY);
  if (dot(axisX, axisX) <= 1e-12 || dot(normal, normal) <= 1e-12) { return 1.0; }
  let x = normalize(axisX);
  let z = normalize(normal);
  let y = cross(z, x);
  let outgoing = worldPos - lightPos;
  return sampleIesProfile(vec3<f32>(dot(outgoing, x), dot(outgoing, y), dot(outgoing, z)), slice);
#else
  return 1.0;
#endif
}
