#define_import_path forgeax_hdrp::gtao_compute
#import forgeax_hdrp::ssao::{gtaoRawVisibility}

@group(0) @binding(9) var gtao_output : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_gtao_calc(@builtin(global_invocation_id) invocation : vec3<u32>) {
  let dimensions = textureDimensions(gtao_output);
  if (invocation.x >= dimensions.x || invocation.y >= dimensions.y) { return; }
  let pixel = vec2<i32>(invocation.xy);
  let uv = (vec2<f32>(invocation.xy) + 0.5) / vec2<f32>(dimensions);
  textureStore(gtao_output, pixel, gtaoRawVisibility(uv));
}
