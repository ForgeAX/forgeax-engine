#define_import_path forgeax_pbr::lighting_spot_projector

// Clustered Standard owns the light membership/decode, while this helper
// keeps projector projection and resource sampling in one module. Keeping the
// projection/sample pair out of standard-cluster avoids a naga-oil scope edge
// when the low-resource projector path is composed with the shared cluster.
#import forgeax_pbr::lighting_attenuation::{projectSpotUv}
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{spotModifierSampler, cookieTexture}
#else
#import forgeax_view::common::{projectorTexture, projectorSampler}
#endif

fn sampleStandardSpotProjector(
  lightViewProj : mat4x4<f32>,
  world_pos    : vec3<f32>,
  metadata     : vec4<u32>,
) -> vec3<f32> {
  let uv = projectSpotUv(lightViewProj, world_pos);
  if (!(uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0)) {
    return vec3<f32>(1.0);
  }
#ifdef EXTENDED_LIGHTING_AVAILABLE
  if (metadata.w == 0xffffffffu) {
    return vec3<f32>(1.0);
  }
  return textureSampleLevel(cookieTexture, spotModifierSampler, uv, metadata.w, 0.0).rgb;
#else
  return textureSampleLevel(projectorTexture, projectorSampler, uv, 0.0).rgb;
#endif
}
