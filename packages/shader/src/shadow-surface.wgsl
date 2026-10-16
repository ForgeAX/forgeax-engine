#define_import_path forgeax_shadow::surface
#import forgeax_view::common::{View, ShadowCasterCascade, view, shadowCasterCascade}

// All geometry producers use the shadow owner's selected light view. Point
// faces supply their face view through View; spots use the caster uniform.
fn projectShadowPosition(worldPosition: vec4<f32>) -> vec4<f32> {
  if (shadowCasterCascade.isSpot == 1u) {
    return shadowCasterCascade.spotLightViewProj * worldPosition;
  }
  switch shadowCasterCascade.index {
    case 0u: { return view.lightViewProj_A * worldPosition; }
    case 1u: { return view.lightViewProj_B * worldPosition; }
    case 2u: { return view.lightViewProj_C * worldPosition; }
    default: { return view.lightViewProj_D * worldPosition; }
  }
}
