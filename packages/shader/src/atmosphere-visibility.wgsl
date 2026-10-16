#define_import_path forgeax_atmosphere::visibility
#import forgeax_view::common::{AtmosphereMedium, View}
#ifdef ATMOSPHERE_UTILITY_SHADOWS
@group(1) @binding(0) var visibilityShadow: texture_depth_2d_array;
@group(1) @binding(1) var visibilityCompare: sampler_comparison;
@group(1) @binding(2) var visibilityCloud: texture_2d<f32>;
@group(1) @binding(3) var visibilityFilter: sampler;
@group(1) @binding(4) var<uniform> visibilityView: View;
#else
#ifdef ATMOSPHERE_AVAILABLE
#import forgeax_view::common::{view, shadowMap, shadowSampler}
#import forgeax_cloud::layer::{cloudShadowMap, cloudShadowSampler}
#endif
#endif

// Only direct solar scattering is shadowed. The low-frequency multiple
// scattering closure remains the spherical, unoccluded approximation.
fn atmosphere_visibility_sample(v:View, m:AtmosphereMedium, p:vec3<f32>, depth:texture_depth_2d_array, comparison:sampler_comparison, cloud:texture_2d<f32>, filtering:sampler)->f32 {
  let world=(p-vec3<f32>(0.0,m.originRadius.w,0.0)+m.originRadius.xyz)*1000.0;
  var visibility=1.0;
  let count=min(u32(max(v.cascadeCount,0.0)),4u);
  // Find the tightest cascade containing the sample. Air has no surface
  // normal: use only the depth bias, never a fictitious normal offset.
  for(var layer=0u;layer<count;layer+=1u) {
    var matrix=v.lightViewProj_A;
    if layer==1u {matrix=v.lightViewProj_B;}
    if layer==2u {matrix=v.lightViewProj_C;}
    if layer==3u {matrix=v.lightViewProj_D;}
    let clip=matrix*vec4<f32>(world,1.0);
    let ndc=clip.xyz/clip.w;
    let uv=ndc.xy*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5);
    if all(uv>=vec2<f32>(0.0)) && all(uv<=vec2<f32>(1.0)) && ndc.z>=0.0 && ndc.z<=1.0 {
      visibility=textureSampleCompareLevel(depth,comparison,uv,i32(layer),ndc.z+v.depthBias);
      break;
    }
  }
  if v.cloudShadowProjection.y>0.5 && v.cloudShadowProjection.z<0.5 && v.cloudShadowProjection.x>0.0 {
    let offset=world-v.cloudShadowOrigin.xyz;
    let uv=vec2<f32>(dot(offset,v.cloudShadowRight.xyz),dot(offset,v.cloudShadowUp.xyz))/v.cloudShadowProjection.x+vec2<f32>(0.5);
    if all(uv>=vec2<f32>(0.0)) && all(uv<=vec2<f32>(1.0)) {
      let column=textureSampleLevel(cloud,filtering,uv,0.0);
      var factor=clamp(column.r,0.0,1.0);
      if v.cloudShadowRight.w>0.0 && column.r<1.0 {
        let height=(world.y-v.cloudShadowOrigin.w)/v.cloudShadowRight.w;
        // Same occupied-column approximation as the cloud transport owner.
        let remaining=clamp((column.b-height)/max(column.b-column.g,0.0001),0.0,1.0);
        factor=exp(-max(column.a,0.0)*remaining);
      }
      visibility*=factor;
    }
  }
  return visibility;
}
fn atmosphere_scene_visibility(m:AtmosphereMedium, p:vec3<f32>)->f32 {
#ifdef ATMOSPHERE_UTILITY_SHADOWS
  return atmosphere_visibility_sample(visibilityView,m,p,visibilityShadow,visibilityCompare,visibilityCloud,visibilityFilter);
#else
#ifdef ATMOSPHERE_AVAILABLE
  return atmosphere_visibility_sample(view,m,p,shadowMap,shadowSampler,cloudShadowMap,cloudShadowSampler);
#else
  return 1.0;
#endif
#endif
}
