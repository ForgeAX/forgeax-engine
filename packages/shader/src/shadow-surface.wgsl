#define_import_path forgeax_shadow::surface
#import forgeax_view::common::{View, ShadowCasterCascade, view, shadowCasterCascade, directionalShadowCasterBias}

fn shadowLightMatrix() -> mat4x4<f32> {
  switch shadowCasterCascade.index {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

// Preserve x/y coverage for directional blockers beyond the fitted near plane.
// Host culling uses the matching five-plane volume. Perspective point/spot and
// explicit authored projections retain their ordinary clipping contract.
fn projectShadowPosition(worldPosition: vec4<f32>, worldNormal: vec3<f32>) -> vec4<f32> {
  if (shadowCasterCascade.isSpot == 1u) {
    return shadowCasterCascade.spotLightViewProj * worldPosition;
  }
  let matrix = shadowLightMatrix();
  var clip = matrix * worldPosition;
  // Point faces borrow the same View matrix slot and caster header. Detect
  // their perspective projection before applying the directional policy.
  let orthographic = all(vec4<f32>(matrix[0].w, matrix[1].w, matrix[2].w, matrix[3].w) == vec4<f32>(0.0, 0.0, 0.0, 1.0));
  if (shadowCasterCascade.clampNear != 0u && orthographic) {
    clip.z = min(clip.z, clip.w);
    if (view.splitPlanes[0].w > 0.5) { return clip; }
    let cascade = shadowCasterCascade.index;
    let depthSpan = view.splitPlanes[cascade].z;
    let normalLength = dot(worldNormal, worldNormal);
    let cosine = abs(dot(worldNormal * inverseSqrt(max(normalLength, 0.00000001)), normalize(-view.lightDir)));
    let casterBias = directionalShadowCasterBias(cosine, view.splitPlanes[cascade].y, depthSpan);
    clip.z = clip.z - casterBias * clip.w;
  }
  return clip;
}
