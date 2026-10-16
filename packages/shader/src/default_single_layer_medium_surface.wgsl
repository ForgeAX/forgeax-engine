#define_import_path forgeax_material::default_single_layer_medium_surface
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}

// Neutral producer-owned Surface for a model-only material smoke. Projects
// replace this module with an imported Surface that reads their declared values.
fn evaluate_surface(input : SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  return SingleLayerMediumSurfaceData(
    normalize(input.geometricNormalWS),
    0.35,
    1.0,
    0.0,
    vec3<f32>(0.0),
    vec3<f32>(0.0),
    1.333,
    0.0,
    1000.0,
  );
}
