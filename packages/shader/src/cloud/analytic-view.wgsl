#define ATMOSPHERE_AVAILABLE
#define_import_path forgeax_cloud::analytic_view
#import forgeax_view::common::{View, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray}
#import forgeax_cloud::aerial::{cloud_height_transport, cloud_aerial_transport}
#import forgeax_cloud::geometry::{CLOUD_UNTRACED_DEPTH_METERS}
#import forgeax_cloud::medium::{MediumSample}
#import forgeax_cloud::lighting::{cloud_henyey_greenstein}
#import forgeax_cloud::trace::{trace_uniform_cloud}
#import forgeax_cloud::depth_minmax::{cloud_scene_depth_range_meters}

struct AnalyticCloudParams {
  layer: vec4f, // bottom, thickness, entry limit, trace limit (meters)
  albedoExtinction: vec4f,
  emissionAo: vec4f,
  mode0: vec4f,
};

@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var<uniform> cloud: AnalyticCloudParams;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;

struct CloudOutputs {
  @location(0) composited: vec4f,
  @location(1) radianceTransmittance: vec4f,
  @location(2) depthMeters: vec4f, // entry, exit, scene, representative
};

@vertex fn vs_main(@builtin(vertex_index) id: u32) -> FullscreenOutput {
  return fullscreen_triangle(id);
}

struct CloudMode0Trace { result: CloudOutputs, farPosition: vec3f, nearPosition: vec3f }
fn trace_mode_zero(input: FullscreenOutput) -> CloudMode0Trace {
  let pixel = min(vec2i(input.position.xy) * 4 + vec2i(cloud.mode0.xy) * 2, vec2i(cloud.mode0.zw) - 1);
  let uv = (vec2f(pixel)+0.5)/cloud.mode0.zw;
  let ray = atmosphere_view_ray(view,uv);
  let z = textureLoad(sceneDepth,pixel,0);
  var meters = CLOUD_UNTRACED_DEPTH_METERS;
  if (z > 0.0) {
    let world = view.inverseViewProj * vec4f(uv*vec2f(2.0,-2.0)+vec2f(-1.0,1.0),z,1.0);
    meters = distance(world.xyz/world.w,ray.origin);
  }
  let range = cloud_scene_depth_range_meters(sceneDepth,vec2i(input.position.xy)*4,vec2u(4u),view.inverseViewProj,ray.origin);
  let radius = 6360000.0;
  let sample = MediumSample(cloud.albedoExtinction.w,cloud.albedoExtinction.xyz,cloud.emissionAo.xyz,cloud.emissionAo.w);
  let scatter = view.lightColor*cloud_henyey_greenstein(0.15,dot(ray.direction,-view.lightDir));
  let far = trace_uniform_cloud(ray.origin+vec3f(0.0,radius,0.0),ray.direction,radius,cloud.layer.x,cloud.layer.y,cloud.layer.z,cloud.layer.w,true,range.y,sample,scatter);
  let near = trace_uniform_cloud(ray.origin+vec3f(0.0,radius,0.0),ray.direction,radius,cloud.layer.x,cloud.layer.y,cloud.layer.z,cloud.layer.w,true,range.x,sample,scatter);
  return CloudMode0Trace(CloudOutputs(vec4f(far.radiance,far.transmittance),vec4f(near.radiance,near.transmittance),vec4f(far.representativeDepthMeters,meters,range)),
    ray.origin + ray.direction * far.representativeDepthMeters,
    ray.origin + ray.direction * near.representativeDepthMeters);
}
@fragment fn fs_trace_mode_zero(input: FullscreenOutput) -> CloudOutputs {
  let traced = trace_mode_zero(input);
  return CloudOutputs(cloud_height_transport(view, traced.farPosition, traced.result.composited),
    cloud_height_transport(view, traced.nearPosition, traced.result.radianceTransmittance), traced.result.depthMeters);
}

@fragment fn fs_trace_mode_zero_air(input: FullscreenOutput) -> CloudOutputs {
  let traced = trace_mode_zero(input);
  return CloudOutputs(cloud_aerial_transport(view, traced.farPosition, traced.result.composited),
    cloud_aerial_transport(view, traced.nearPosition, traced.result.radianceTransmittance), traced.result.depthMeters);
}


@fragment fn fs_main(input: FullscreenOutput) -> CloudOutputs {
  let pixel = vec2i(input.position.xy);
  let scene = textureLoad(sceneColor, pixel, 0);
  let z = textureLoad(sceneDepth, pixel, 0);
  let ray = atmosphere_view_ray(view, input.uv);
  var sceneMeters = CLOUD_UNTRACED_DEPTH_METERS;
  if z > 0.0 {
    let ndc = input.uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
    let world = view.inverseViewProj * vec4f(ndc, z, 1.0);
    sceneMeters = distance(world.xyz / world.w, ray.origin);
  }
  let radius = 6360000.0;
  let planetRelative = ray.origin + vec3f(0.0, radius, 0.0);
  let sample = MediumSample(cloud.albedoExtinction.w, cloud.albedoExtinction.xyz,
    cloud.emissionAo.xyz, cloud.emissionAo.w);
  let scatter = view.lightColor * cloud_henyey_greenstein(0.15, dot(ray.direction, -view.lightDir));
  let traced = trace_uniform_cloud(planetRelative, ray.direction, radius, cloud.layer.x,
    cloud.layer.y, cloud.layer.z, cloud.layer.w, true, sceneMeters, sample, scatter);
  return CloudOutputs(
    vec4f(scene.rgb * traced.transmittance + traced.radiance, scene.a),
    vec4f(traced.radiance, traced.transmittance),
    vec4f(traced.entryMeters, traced.exitMeters, traced.sceneDepthMeters,
      traced.representativeDepthMeters),
  );
}
