#define_import_path forgeax_material::terrain_layer_sampling
#import forgeax_material::surface_v1::{SurfaceInput}

struct TerrainLayerSample {
  color: vec4<f32>,
  normalHeight: vec4<f32>,
  orm: vec3<f32>,
  emission: vec3<f32>,
}
fn terrain_layer(index: i32, input: SurfaceInput) -> TerrainLayerSample {
  // The admitted roster uses -1 for the neutral layer; author indices start at 0.
  let layer = index + 1;
  return TerrainLayerSample(
    textureSampleLevel(terrainColorLayers, terrainColorLayers_sampler, input.uv0, layer, 0.0),
    textureSampleLevel(terrainNormalHeightLayers, terrainNormalHeightLayers_sampler, input.uv0, layer, 0.0),
    textureSampleLevel(terrainOrmLayers, terrainOrmLayers_sampler, input.uv0, layer, 0.0).xyz,
    textureSampleLevel(terrainEmissionLayers, terrainEmissionLayers_sampler, input.uv0, layer, 0.0).xyz,
  );
}
