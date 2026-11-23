#define_import_path forgeax_material::terrain_detail_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::terrain_surface::{evaluate_terrain_surface, terrain_authored_weights}

fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let uv = input.positionOS.xz * material.terrainWeightDetailParams.x;
  let detail = textureSample(terrainWeightDetail, terrainWeightDetail_sampler, uv);
  let layerBias = exp2((detail * 2.0 - 1.0) * material.terrainWeightDetailParams.y);
  let authored = terrain_authored_weights(input.uv0);
  var weights = authored;
  for (var i = 0; i < 4; i++) {
    let authorLayer = i32(material.terrainLayerIndices[i]);
    if (authorLayer >= 0) {
      weights[i] *= layerBias[authorLayer];
    }
  }
  let total = dot(weights, vec4<f32>(1.0));
  if (total > 0.0) {
    weights *= dot(authored, vec4<f32>(1.0)) / total;
  }
  return evaluate_terrain_surface(input, weights);
}
