#define_import_path forgeax_material::terrain_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_pbr::tbn::{applyTBN}

fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let uv=input.uv0;
  let controlSize=vec2<f32>(textureDimensions(terrainWeightTexture,0));
  let controlUv=(clamp(uv,vec2<f32>(0.0),vec2<f32>(1.0))*(controlSize-1.0)+0.5)/controlSize;
  let authored=textureSampleLevel(terrainWeightTexture,terrainWeightTexture_sampler,controlUv,0.0);
  var w=authored;
  var colors: array<vec4<f32>,4>;
  var normals: array<vec4<f32>,4>;
  var orm: array<vec4<f32>,4>;
  var emissions: array<vec4<f32>,4>;
  var heightBlend=false;
  for(var i=0;i<4;i++) {
    colors[i]=textureSample(terrainColorLayers,terrainColorLayers_sampler,uv,i);
    normals[i]=textureSample(terrainNormalHeightLayers,terrainNormalHeightLayers_sampler,uv,i);
    orm[i]=textureSample(terrainOrmLayers,terrainOrmLayers_sampler,uv,i);
    emissions[i]=textureSample(terrainEmissionLayers,terrainEmissionLayers_sampler,uv,i);
    if(material.terrainLayerModes[i] == 1.0) {
      w[i]=clamp(authored[i]*2.0-1.0+normals[i].w,0.0001,1.0);
      heightBlend=true;
    }
    if(material.terrainLayerModes[i] >= 2.0) {w[i]=0.0;}
  }
  let sum=w.x+w.y+w.z+w.w;
  if(heightBlend && sum>0.0) {w/=sum;}
  var defaults=select(0.0,1.0,sum==0.0);
  for(var i=0;i<4;i++) {
    if(material.terrainLayerModes[i] == 2.0) {
      w*=1.0-authored[i]; defaults*=1.0-authored[i]; w[i]=authored[i];
    }
  }
  var color=vec4<f32>(1.0)*defaults;
  var normal=vec3<f32>(0.0,0.0,1.0)*defaults;
  var occlusion=defaults;
  var roughness=0.5*defaults;
  var metallic=0.0;
  var emission=vec3<f32>(0.0);
  for(var i=0;i<4;i++) {
    color+=colors[i]*w[i]; normal+=normals[i].xyz*w[i];
    occlusion+=orm[i].x*w[i]; roughness+=orm[i].y*w[i]; metallic+=orm[i].z*w[i]; emission+=emissions[i].xyz*w[i];
  }
  normal=select(vec3<f32>(0.0,0.0,1.0),normalize(normal),dot(normal,normal)>1e-8);
  return SurfaceData(color.rgb,applyTBN(input.vertexNormalWS,input.tangentWS,normal)*select(-1.0,1.0,input.frontFacing),clamp(metallic,0.0,1.0),clamp(roughness,0.04,1.0),emission,clamp(occlusion,0.0,1.0),clamp(color.a,0.0,1.0),0.0);
}
