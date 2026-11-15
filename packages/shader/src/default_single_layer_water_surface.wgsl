#define_import_path forgeax_material::default_single_layer_water_surface
#import forgeax_material::single_layer_water_surface_v1::{SingleLayerWaterSurfaceInput, SingleLayerWaterSurfaceData}

fn evaluate_surface(input: SingleLayerWaterSurfaceInput) -> SingleLayerWaterSurfaceData {
  return SingleLayerWaterSurfaceData(normalize(input.geometricNormalWS), 0.02, 1.0, 0.0,
    vec3<f32>(1.25, 0.0833333333, 0.0357142857), vec3<f32>(0.05), 1.30990195, 0.1, 1000.0,
    1.15, 0.0, vec3<f32>(1.0), vec3<f32>(0.85), 0.0, vec3<f32>(0.0));
}
