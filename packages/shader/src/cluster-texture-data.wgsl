#define_import_path forgeax_standard::cluster_texture_data

// The shared no-storage transport. Optical lookups must not import the
// punctual-light evaluator, which itself consumes atmospheric solar light.
@group(2) @binding(3) var cluster_data_texture: texture_2d<u32>;

fn load_cluster_texel(texel: u32) -> vec4<u32> {
  let width=textureDimensions(cluster_data_texture).x;
  return textureLoad(cluster_data_texture,vec2<i32>(i32(texel%width),i32(texel/width)),0);
}
