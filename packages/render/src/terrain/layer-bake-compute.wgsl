@group(0) @binding(3) var colors: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var normals: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var orms: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var emissions: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn bakeLayers(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= bake.destination.yz)) { return; }
  let value = bakeLayer(id.xy);
  let position = vec2<i32>(id.xy);
  let plane = i32(bake.destination.x);
  textureStore(colors, position, plane, value.color);
  textureStore(normals, position, plane, value.normalHeight);
  textureStore(orms, position, plane, value.orm);
  textureStore(emissions, position, plane, value.emission);
}
