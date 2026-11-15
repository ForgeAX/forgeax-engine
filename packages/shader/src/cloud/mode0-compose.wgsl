#define_import_path forgeax_cloud::mode0_compose
#import forgeax_view::common::{View, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray}
#import forgeax_cloud::reconstruct::{CloudReconstructionSample}
#import forgeax_cloud::compose::{cloud_bilateral_upsample, cloud_compose_transport}
#import forgeax_cloud::geometry::{CLOUD_UNTRACED_DEPTH_METERS, cloud_shell_interval}
#import forgeax_cloud::depth_minmax::{cloud_scene_depth_meters}
struct Mode0Params {
  previousViewProjection: mat4x4f,
  phaseSize: vec4f,
  historyExposure: vec4f,
  displayProbe: vec4f,
  layer: vec4f, // bottom, thickness, entry limit, trace limit (meters)
}
@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var<uniform> params: Mode0Params;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var farTexture: texture_2d<f32>;
@group(1) @binding(6) var nearTexture: texture_2d<f32>;
@group(1) @binding(7) var meterTexture: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) id: u32) -> FullscreenOutput { return fullscreen_triangle(id); }
@fragment fn fs_main(input: FullscreenOutput) -> @location(0) vec4f {
  let pixel = vec2i(input.position.xy);
  let background = textureLoad(sceneColor,pixel,0);
  let z = textureLoad(sceneDepth,pixel,0);
  var meters = CLOUD_UNTRACED_DEPTH_METERS;
  var canSeeCloud = true;
  if (z > 0.0) {
    let ray = atmosphere_view_ray(view,input.uv);
    meters = cloud_scene_depth_meters(z,input.uv,view.inverseViewProj,ray.origin);
    // Reconstructed near transport can contain neighboring sky radiance.
    // Test visibility against this pixel's opaque surface before sampling it.
    let radius = 6360000.0;
    let interval = cloud_shell_interval(ray.origin + vec3f(0.0,radius,0.0),ray.direction,
      radius,params.layer.x,params.layer.y,params.layer.z,params.layer.w,true,0.0,meters);
    canSeeCloud = interval.x >= 0.0;
  }
  var transport = vec4f(0.0,0.0,0.0,1.0);
  if (canSeeCloud) {
    let center = pixel / 2;
    let offset = select(vec2i(1),vec2i(-1),(pixel % vec2i(2)) == vec2i(0));
    let coords = array<vec2i,4>(center,center+vec2i(offset.x,0),center+offset,center+vec2i(0,offset.y));
    var samples: array<CloudReconstructionSample,4>;
    for (var i=0u;i<4u;i+=1u) {
      let c = clamp(coords[i],vec2i(0),vec2i(textureDimensions(farTexture))-1);
      samples[i] = CloudReconstructionSample(textureLoad(farTexture,c,0),textureLoad(nearTexture,c,0),textureLoad(meterTexture,c,0));
    }
    transport = cloud_bilateral_upsample(samples,meters,vec4f(0.5625,0.1875,0.0625,0.1875),params.historyExposure.w);
  }
  if (params.displayProbe.x == 3.0) { return vec4f(vec3f(transport.a), 1.0); }
  if (params.displayProbe.x == 4.0) { return vec4f(vec3f(select(0.0, 1.0, 1.0 - transport.a > 0.05)), 1.0); }
  if (transport.a >= 1.0 && all(transport.rgb == vec3f(0.0))) { return background; }
  // Both depth lanes already contain their own AP and height fog contribution.
  return vec4f(cloud_compose_transport(background.rgb, transport), background.a);
}
