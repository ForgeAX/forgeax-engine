#define_import_path forgeax_material::texture_coordinates

// CPU-owned coefficients are shared by color, coverage, displacement and rays.
// Offsets do not affect derivatives; keep the linear operation independently usable.
fn materialUvLinear(source : vec2<f32>, transform : vec4<f32>, rotation : vec4<f32>) -> vec2<f32> {
  let scaled = source * transform.zw;
  return vec2<f32>(scaled.x * rotation.x - scaled.y * rotation.y,
    scaled.x * rotation.y + scaled.y * rotation.x);
}
