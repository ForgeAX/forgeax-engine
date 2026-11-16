#define ATMOSPHERE_AVAILABLE
#define_import_path forgeax_cloud::sampled_view
#import forgeax_view::common::{View, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray}
#import forgeax_cloud::aerial::{cloud_height_transport, cloud_aerial_transport}
#import forgeax_cloud::geometry::{CLOUD_UNTRACED_DEPTH_METERS}
#import forgeax_cloud::geometry::{cloud_shell_interval}
#import forgeax_cloud::medium::{CloudDensityControls, CloudDensityPoint, evaluate_reference_conservative, evaluate_reference_medium}
#import forgeax_cloud::coordinates::{cloud_height_fraction}
#import forgeax_cloud::shadow::{cloud_bsm_trace_interval, cloud_shadow_accumulate, cloud_shadow_finish}
#import forgeax_cloud::lighting::{cloud_henyey_greenstein}
#import forgeax_cloud::depth_minmax::{cloud_scene_depth_range_meters, cloud_scene_depth_meters}
#import forgeax_cloud::trace::{CloudSampledTraceSettings, CloudTraceLighting, trace_sampled_cloud_lit}

struct SampledCloudParams {
  layer: vec4f, // bottom, thickness, entry limit, trace limit (meters)
  optical: vec4f, // layout scale, signed coverage, extinction, skip
  albedo: vec4f,
  weights: vec4f, // layout, mask, profile, body
  windErosion: vec4f, // XYZ wind offset meters, erosion weight
  probe: vec4f, // mode (0=none,1=C4/sigma,2=counts/witness), pixel x, pixel y
  sampling: vec4f, // maximum budget, loop cap, stop transmittance, reserved
  phase: vec4f,
  multipleScattering: vec4f,
  shadow: vec4f,
  mode0: vec4f, // phase XY, full extent XY
  mapOrigin: vec4f, // XYZ origin, extent m
  mapRight: vec4f, // XYZ axis, full depth m
  mapUp: vec4f, // XYZ axis, bias m
  mapDirection: vec4f, // XYZ direction to light, strength
  mapSettings: vec4f, // mode, external cast, map samples, surface strength
  skyAmbient: vec4f,
  environment: vec4f,
  groundSolar: vec4f,
};

@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var wrapSampler: sampler;
@group(1) @binding(2) var<uniform> cloud: SampledCloudParams;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var layoutPattern: texture_2d<f32>;
@group(1) @binding(6) var layoutMask: texture_2d<f32>;
@group(1) @binding(7) var heightProfile: texture_2d<f32>;
@group(1) @binding(8) var bodyNoise: texture_3d<f32>;
@group(1) @binding(9) var cloudBsm: texture_2d<f32>;
@group(1) @binding(10) var solarTransmittance: texture_2d<f32>;
@group(1) @binding(11) var distantSky: texture_2d<f32>;

struct CloudOutputs {
  @location(0) composited: vec4f,
  @location(1) radianceTransmittance: vec4f,
  @location(2) depthMeters: vec4f,
};

@vertex fn vs_main(@builtin(vertex_index) id: u32) -> FullscreenOutput {
  return fullscreen_triangle(id);
}

struct CloudMode0Outputs {
  @location(0) far: vec4f,
  @location(1) near: vec4f,
  @location(2) depthMeters: vec4f,
};

struct CloudMode0Trace { result: CloudMode0Outputs, farPosition: vec3f, nearPosition: vec3f }
fn trace_mode_zero(input: FullscreenOutput) -> CloudMode0Trace {
  let fullSize = vec2i(cloud.mode0.zw);
  let origin = vec2i(input.position.xy) * 4;
  let pixel = min(origin + vec2i(cloud.mode0.xy) * 2, fullSize - vec2i(1));
  let uv = (vec2f(pixel) + 0.5) / vec2f(fullSize);
  let ray = atmosphere_view_ray(view, uv);
  let rangeMeters = cloud_scene_depth_range_meters(sceneDepth, origin, vec2u(4u),
    view.inverseViewProj, ray.origin);
  let sceneMeters = cloud_scene_depth_meters(textureLoad(sceneDepth, pixel, 0), uv,
    view.inverseViewProj, ray.origin);
  let radius = 6360000.0;
  let controls = CloudDensityControls(cloud.optical.x, cloud.optical.y, cloud.optical.z,
    cloud.albedo, cloud.weights.x, cloud.weights.y, cloud.weights.z, cloud.weights.w,
    cloud.windErosion.w);
  let settings = CloudSampledTraceSettings(cloud.layer, radius, rangeMeters.y, 15000.0,
    2u, u32(cloud.sampling.x), u32(cloud.sampling.y), true,
    cloud.optical.w > 0.5, CLOUD_DETAIL, cloud.sampling.z, 0.5);
  let lighting = CloudTraceLighting(-view.lightDir, view.lightColor, cloud.phase,
    cloud.multipleScattering, cloud.shadow, true,
    cloud.mapOrigin, cloud.mapRight, cloud.mapUp, cloud.mapDirection, cloud.mapSettings,
    view.atmosphere, cloud.skyAmbient, cloud.environment, cloud.groundSolar);
  let result = trace_sampled_cloud_lit(ray.origin, ray.origin + vec3f(0.0, radius, 0.0),
    ray.direction, cloud.windErosion.xyz, controls, layoutPattern, layoutMask, heightProfile,
    bodyNoise, wrapSampler, vec3f(0.0), settings, rangeMeters.x, lighting, cloudBsm, solarTransmittance, distantSky);
  return CloudMode0Trace(CloudMode0Outputs(vec4f(result.trace.radiance, result.trace.transmittance),
    vec4f(result.near.radiance, result.near.transmittance),
    vec4f(result.trace.representativeDepthMeters, sceneMeters, rangeMeters)),
    ray.origin + ray.direction * result.trace.representativeDepthMeters,
    ray.origin + ray.direction * result.nearRepresentativeDepthMeters);
}
@fragment fn fs_trace_mode_zero(input: FullscreenOutput) -> CloudMode0Outputs {
  let traced = trace_mode_zero(input);
  return CloudMode0Outputs(cloud_height_transport(view, traced.farPosition, traced.result.far),
    cloud_height_transport(view, traced.nearPosition, traced.result.near), traced.result.depthMeters);
}

@fragment fn fs_trace_mode_zero_air(input: FullscreenOutput) -> CloudMode0Outputs {
  let traced = trace_mode_zero(input);
  return CloudMode0Outputs(cloud_aerial_transport(view, traced.farPosition, traced.result.far),
    cloud_aerial_transport(view, traced.nearPosition, traced.result.near), traced.result.depthMeters);
}


fn sampled_view_output(input: FullscreenOutput) -> CloudOutputs {
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
  let controls = CloudDensityControls(
    cloud.optical.x, cloud.optical.y, cloud.optical.z, cloud.albedo,
    cloud.weights.x, cloud.weights.y, cloud.weights.z, cloud.weights.w, cloud.windErosion.w,
  );
  let settings = CloudSampledTraceSettings(cloud.layer, radius, sceneMeters, 15000.0,
    2u, u32(cloud.sampling.x), u32(cloud.sampling.y), true,
    cloud.optical.w > 0.5, CLOUD_DETAIL, cloud.sampling.z, 0.5);
  let scatter = view.lightColor * cloud_henyey_greenstein(0.15, dot(ray.direction, -view.lightDir));
  let lighting = CloudTraceLighting(-view.lightDir, view.lightColor, cloud.phase,
    cloud.multipleScattering, cloud.shadow, true,
    cloud.mapOrigin, cloud.mapRight, cloud.mapUp, cloud.mapDirection, cloud.mapSettings,
    view.atmosphere, cloud.skyAmbient, cloud.environment, cloud.groundSolar);
  let result = trace_sampled_cloud_lit(ray.origin, planetRelative, ray.direction, cloud.windErosion.xyz,
    controls, layoutPattern, layoutMask, heightProfile, bodyNoise, wrapSampler, scatter, settings,
    sceneMeters, lighting, cloudBsm, solarTransmittance, distantSky);
  let traced = result.trace;
  var lt = vec4f(traced.radiance, traced.transmittance);
  var meters = vec4f(traced.entryMeters, traced.exitMeters, traced.sceneDepthMeters,
    traced.representativeDepthMeters);
  // Diagnostics repurpose the two readback lanes at one selected pixel only.
  // The actual rendered scene and transport calculation remain identical.
  if all(pixel == vec2i(cloud.probe.yz)) {
    if cloud.probe.x == 1.0 {
      lt = result.conservative;
      meters.w = result.extinctionPerMeter;
    } else if cloud.probe.x == 2.0 {
      lt = vec4f(result.counts);
      meters.w = result.witnessDistanceMeters;
    }
  }
  var composited = vec4f(scene.rgb * traced.transmittance + traced.radiance, scene.a);
  if cloud.probe.x == 3.0 {
    composited = vec4f(vec3f(traced.transmittance), 1.0);
  } else if cloud.probe.x == 4.0 {
    composited = vec4f(vec3f(select(0.0, 1.0, 1.0 - traced.transmittance > 0.05)), 1.0);
  }
  return CloudOutputs(composited, lt, meters);
}

@fragment fn fs_main(input: FullscreenOutput) -> CloudOutputs { return sampled_view_output(input); }

@fragment fn fs_probe(input: FullscreenOutput) -> CloudOutputs {
  var probeInput = input;
  probeInput.position = vec4f(cloud.probe.yz + 0.5, input.position.zw);
  probeInput.uv = (cloud.probe.yz + 0.5) / vec2f(textureDimensions(sceneDepth));
  return sampled_view_output(probeInput);
}

@fragment fn fs_shadow(input: FullscreenOutput) -> @location(0) vec4f {
  let radius = 6360000.0;
  let uv = input.uv - vec2f(0.5);
  let origin = cloud.mapOrigin.xyz + cloud.mapOrigin.w *
    (uv.x * cloud.mapRight.xyz + uv.y * cloud.mapUp.xyz);
  let direction = -cloud.mapDirection.xyz;
  let planetPosition = origin + vec3f(0.0, radius, 0.0);
  let interval = cloud_bsm_trace_interval(planetPosition, direction, radius,
    cloud.layer.x, cloud.layer.y);
  if interval.x < 0.0 { return vec4f(cloud.mapRight.w, 0.0, 0.0, 1.0); }
  if interval.y <= interval.x { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let controls = CloudDensityControls(cloud.optical.x, cloud.optical.y, cloud.optical.z,
    cloud.albedo, cloud.weights.x, cloud.weights.y, cloud.weights.z, cloud.weights.w,
    cloud.windErosion.w);
  let count = u32(clamp(cloud.mapSettings.z, 1.0, 256.0));
  let stepMeters = (interval.y - interval.x) / f32(count);
  var acc = vec4f(interval.y, 0.0, 0.0, 0.0);
  for (var index = 0u; index < count; index += 1u) {
    let t = interval.x + (f32(index) + 0.5) * stepMeters;
    let position = origin + direction * t;
    let radial = length(planetPosition + direction * t);
    let eyeRadial = length(planetPosition);
    let height = eyeRadial - radius + t * (t + 2.0 * dot(planetPosition, direction)) / (radial + eyeRadial);
    let point = CloudDensityPoint(position, position - view.cameraPos,
      cloud_height_fraction(height, cloud.layer.x, cloud.layer.y), cloud.windErosion.xyz);
    let c4 = evaluate_reference_conservative(point, controls, layoutPattern, layoutMask,
      heightProfile, bodyNoise, wrapSampler, CLOUD_DETAIL);
    let medium = evaluate_reference_medium(point, controls, c4);
    acc = cloud_shadow_accumulate(acc, t, vec3f(medium.extinctionPerMeter));
  }
  return vec4f(cloud_shadow_finish(acc, interval.y, stepMeters,
    cloud.mapDirection.w, cloud.mapUp.w), 1.0);
}
