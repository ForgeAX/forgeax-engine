#define_import_path forgeax_material::terrain_id_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_pbr::tbn::{applyTBN}

fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let uv = input.uv0;
  let size = textureDimensions(terrainWeightTexture, 0);
  // Material controls stay at mip0 independently of geometry LOD. IDs are
  // discrete: neither hardware bilinear filtering nor mip averaging is legal.
  let point = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(size - 1u);
  let cell = min(vec2<u32>(point), size - 2u);
  let local = point - vec2<f32>(cell);
  var offsets = array<vec2<u32>, 3>(vec2<u32>(0u), vec2<u32>(1u,0u), vec2<u32>(0u,1u));
  var bary = vec3<f32>(1.0-local.x-local.y,local.x,local.y);
  if (local.x + local.y > 1.0) {
    offsets = array<vec2<u32>, 3>(vec2<u32>(1u),vec2<u32>(0u,1u),vec2<u32>(1u,0u));
    bary = vec3<f32>(local.x+local.y-1.0,1.0-local.x,1.0-local.y);
  }
  var ids = array<u32,3>(255u,255u,255u);
  var weights = vec3<f32>(0.0);
  for (var vertex = 0; vertex < 3; vertex++) {
    let packed = vec4<u32>(round(textureLoad(terrainWeightTexture,vec2<i32>(cell+offsets[vertex]),0)*255.0));
    let blend = f32(packed.z*256u+packed.w)/65535.0;
    let pair = vec2<u32>(packed.x,packed.y);
    let pairWeights = vec2<f32>(1.0-blend,blend)*bary[vertex];
    for (var side = 0; side < 2; side++) {
      if (pairWeights[side] <= 0.0) { continue; }
      for (var slot = 0; slot < 3; slot++) {
        if (ids[slot] == pair[side] || weights[slot] == 0.0) {
          ids[slot] = pair[side];
          weights[slot] += pairWeights[side];
          break;
        }
      }
    }
  }
  let dx = dpdx(uv);
  let dy = dpdy(uv);
  var color = vec4<f32>(0.0);
  var normal = vec3<f32>(0.0);
  var orm = vec3<f32>(0.0);
  var emission = vec3<f32>(0.0);
  for (var slot = 0; slot < 3; slot++) {
    let weight = weights[slot];
    if (weight <= 0.0) { continue; }
    if (ids[slot] == 255u) {
      color += vec4<f32>(1.0)*weight;
      normal += vec3<f32>(0.0,0.0,1.0)*weight;
      orm += vec3<f32>(1.0,0.5,0.0)*weight;
    } else {
      let layer = i32(ids[slot]);
      color += textureSampleGrad(terrainColorLayers,terrainColorLayers_sampler,uv,layer,dx,dy)*weight;
      normal += textureSampleGrad(terrainNormalHeightLayers,terrainNormalHeightLayers_sampler,uv,layer,dx,dy).xyz*weight;
      orm += textureSampleGrad(terrainOrmLayers,terrainOrmLayers_sampler,uv,layer,dx,dy).xyz*weight;
      emission += textureSampleGrad(terrainEmissionLayers,terrainEmissionLayers_sampler,uv,layer,dx,dy).xyz*weight;
    }
  }
  normal = select(vec3<f32>(0.0,0.0,1.0),normalize(normal),dot(normal,normal)>1e-8);
  return SurfaceData(color.rgb,applyTBN(input.vertexNormalWS,input.tangentWS,normal)*select(-1.0,1.0,input.frontFacing),clamp(orm.z,0.0,1.0),clamp(orm.y,0.04,1.0),emission,clamp(orm.x,0.0,1.0),clamp(color.a,0.0,1.0),0.0);
}
