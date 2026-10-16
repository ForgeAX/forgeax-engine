#define_import_path preview::shore_sand
#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}

fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let p = input.positionWS.xz;
  let ripple = sin(p.x * 10.0 + sin(p.y * 1.7) * 1.2);
  let grain = sin(p.x * 57.0) * sin(p.y * 63.0);
  let wet = 1.0 - smoothstep(-0.05, 0.35, input.positionWS.y);
  let color = material.sandColor.rgb * (0.92 + ripple * 0.035 + grain * 0.012) * (1.0 - wet * 0.18);
  return SurfaceData(color, input.vertexNormalWS, 0.0, 0.9, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}
