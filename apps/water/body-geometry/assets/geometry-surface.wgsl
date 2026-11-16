#define_import_path water_r1::geometry_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material}

// River COLOR_0 stores encoded flow, not a display color or opacity.
// The geometry exhibit keeps the original cooked mesh and shades its shape.
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let contour = 0.94 + 0.06 * cos(input.positionWS.y * 30.0);
  return SurfaceData(material.baseColor.rgb * contour, normalize(input.vertexNormalWS),
    0.02, material.roughness, vec3<f32>(0.0), 1.0, 1.0, 0.0, 0.0);
}
