#define_import_path forgeax_material::opaque_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}

// The default depth coverage requires no material values or lighting model.
// Cutout materials select their shared Surface explicitly on every Pass.
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(1.0), input.vertexNormalWS, 0.0, 1.0,
    vec3<f32>(0.0), 1.0, 1.0, 0.0);
}
