import type { CloudParameter, CloudParameterValue } from '../contracts';

export const CLOUD_RENDERER_PARAMETER_OFFSET = 240;

export function cloudRendererParameterNames(
  parameters: Readonly<Record<string, CloudParameter>>,
): readonly string[] {
  return Object.keys(parameters)
    .sort()
    .filter((name) => parameters[name]?.kind !== 'static');
}

/** Pack the declared scalar/vector structure using WGSL natural alignment. */
export function encodeCloudRendererParameters(
  parameters: Readonly<Record<string, CloudParameter>>,
  values: Readonly<Record<string, CloudParameterValue>>,
): Float32Array {
  const names = cloudRendererParameterNames(parameters);
  let cursor = 0;
  const offsets = names.map((name) => {
    const parameter = parameters[name];
    const width = parameter?.kind === 'vector' ? parameter.default.length : 1;
    const alignment = width > 1 ? 4 : 1;
    cursor = Math.ceil(cursor / alignment) * alignment;
    const offset = cursor;
    cursor += width;
    return offset;
  });
  const data = new Float32Array(Math.max(4, Math.ceil(cursor / 4) * 4));
  for (const [index, name] of names.entries()) {
    const parameter = parameters[name];
    const value = values[name];
    if (parameter?.kind === 'scalar' && typeof value === 'number' && Number.isFinite(value))
      data[offsets[index] ?? 0] = value;
    else if (
      parameter?.kind === 'vector' &&
      Array.isArray(value) &&
      value.length === parameter.default.length &&
      value.every(Number.isFinite)
    )
      data.set(value, offsets[index] ?? 0);
    else throw new Error(`Invalid cooked cloud renderer parameter ${name}`);
  }
  return data;
}

export function cloudRendererProgram(
  source: string,
  parameters: Readonly<Record<string, CloudParameter>>,
  switches: Readonly<Record<string, boolean>>,
): string {
  if (Object.values(parameters).some((parameter) => parameter.kind === 'texture'))
    throw new Error('Textureless cloud renderer received texture parameters');
  const fields = cloudRendererParameterNames(parameters).map((name) => {
    const parameter = parameters[name];
    return `${name}: ${parameter?.kind === 'vector' ? `vec${parameter.default.length}f` : 'f32'},`;
  });
  return `
#define ATMOSPHERE_AVAILABLE
#import forgeax_view::common::{view, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray}
#import forgeax_cloud::aerial::{cloud_height_transport, cloud_aerial_transport}
#import forgeax_cloud::geometry::{cloud_shell_interval, CLOUD_UNTRACED_DEPTH_METERS}
#import forgeax_cloud::lighting::{cloud_double_henyey_greenstein, cloud_optical_octaves, cloud_solar_light, cloud_sky_light}
#import forgeax_cloud::shadow::{cloud_bsm_trace_interval, cloud_shadow_segment, cloud_shadow_ray_octave_tau, cloud_shadow_map_octave_tau, cloud_shadow_map_load, cloud_shadow_optical_depth, cloud_shadow_accumulate, cloud_shadow_finish}
#import forgeax_cloud::depth_minmax::{cloud_scene_depth_range_meters}
#import forgeax_cloud::trace::{cloud_one_minus_beer}
struct CloudMediumContext { positionMeters: vec3f, heightFraction: f32, sampleDxMeters: vec3f, sampleDyMeters: vec3f, cameraRelativeMeters: vec3f, windOffsetMeters: vec3f, }
struct CloudMediumSample { extinctionPerMeter: f32, albedo: vec3f, emissivePerMeter: vec3f, materialAO: f32, }
struct CloudParameters { ${fields.length ? fields.join('\n') : 'unused: f32,'} }
${Object.entries(switches)
  .map(([name, value]) => `const ${name} = ${value};`)
  .join('\n')}
${source}
struct CloudRendererUniforms {
  layer: vec4f,
  wind: vec4f,
  sampling: vec4f,
  phase: vec4f,
  multipleScattering: vec4f,
  shadow: vec4f,
  shadowOrigin: vec4f,
  shadowAxisU: vec4f,
  shadowAxisV: vec4f,
  shadowDirection: vec4f,
  shadowEncoding: vec4f,
  reserved: vec4f,
  skyAmbient: vec4f,
  environment: vec4f,
  groundSolar: vec4f,
  material: CloudParameters,
}
@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var<uniform> cloud: CloudRendererUniforms;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var cloudShadowMap: texture_2d<f32>;
@group(1) @binding(6) var solarTransmittance: texture_2d<f32>;
@group(1) @binding(7) var distantSky: texture_2d<f32>;
fn renderer_medium(position: vec3f, camera: vec3f, dx: vec3f, dy: vec3f) -> CloudMediumSample {
  let radius = 6360000.0;
  let radial = length(position + vec3f(0.0, radius, 0.0));
  let altitude = (dot(position, position) + 2.0 * radius * position.y) / (radial + radius);
  var medium = evaluateCloudMedium(CloudMediumContext(position, (altitude - cloud.layer.x) / cloud.layer.y, dx, dy, position - camera, cloud.wind.xyz), cloud.material);
  if cloud.sampling.w >= 0.0 && medium.extinctionPerMeter > 0.0 { medium.extinctionPerMeter = cloud.sampling.w; }
  return medium;
}
fn renderer_valid_medium(medium: CloudMediumSample) -> bool {
  return medium.extinctionPerMeter >= 0.0 && medium.extinctionPerMeter <= 3.402823e38 && all(medium.albedo >= vec3f(0.0)) && all(medium.albedo <= vec3f(1.0)) && all(medium.emissivePerMeter >= vec3f(0.0)) && all(medium.emissivePerMeter <= vec3f(3.402823e38)) && medium.materialAO >= 0.0 && medium.materialAO <= 1.0;
}
fn renderer_interval(origin: vec3f, direction: vec3f, limit: f32) -> vec2f {
  return cloud_shell_interval(origin + vec3f(0.0, 6360000.0, 0.0), direction, 6360000.0, cloud.layer.x, cloud.layer.y, cloud.layer.z, limit, true, 0.0, CLOUD_UNTRACED_DEPTH_METERS);
}
fn renderer_light_tau(position: vec3f, camera: vec3f, light: vec3f, dx: vec3f, dy: vec3f) -> vec2f {
  if cloud.shadow.x < 0.5 { return vec2f(0.0); }
  if cloud.shadowEncoding.w > 0.5 {
    let relative = position - cloud.shadowOrigin.xyz;
    let uv = vec2f(dot(relative, cloud.shadowAxisU.xyz) / dot(cloud.shadowAxisU.xyz, cloud.shadowAxisU.xyz), dot(relative, cloud.shadowAxisV.xyz) / dot(cloud.shadowAxisV.xyz, cloud.shadowAxisV.xyz)) * 0.5 + 0.5;
    let encoded = cloud_shadow_map_load(cloudShadowMap, clamp(uv, vec2f(0.0), vec2f(1.0)));
    if any(encoded < vec3f(0.0)) { return vec2f(-1.0); }
    let depth = clamp(dot(relative, normalize(cloud.shadowDirection.xyz)), 0.0, cloud.shadowDirection.w);
    return vec2f(cloud_shadow_optical_depth(encoded, depth), 1.0);
  }
  let interval = renderer_interval(position, light, cloud.shadow.z);
  if interval.x < 0.0 { return vec2f(0.0); }
  let count = u32(clamp(cloud.shadow.y, 1.0, 64.0));
  var tau = 0.0;
  for (var i = 0u; i < count; i++) {
    let step = cloud_shadow_segment(i, count, interval.y - interval.x);
    let medium = renderer_medium(position + light * (interval.x + step.x), camera, dx, dy);
    if !renderer_valid_medium(medium) { return vec2f(-1.0); }
    tau += medium.extinctionPerMeter * step.y;
  }
  return vec2f(tau, 0.0);
}
struct CloudRendererOutputs { @location(0) composited: vec4f, @location(1) lt: vec4f, @location(2) depth: vec4f, }
@vertex fn vs_main(@builtin(vertex_index) id: u32) -> FullscreenOutput { return fullscreen_triangle(id); }
struct CloudRendererTrace { result: CloudRendererOutputs, farPosition: vec3f, nearPosition: vec3f }
fn renderer_trace(input: FullscreenOutput, mode0: bool) -> CloudRendererTrace {
  let dimensions = textureDimensions(sceneDepth);
  let fullPixel = select(vec2i(input.position.xy), min(vec2i(input.position.xy) * 4 + vec2i(cloud.reserved.xy) * 2, vec2i(dimensions) - 1), mode0);
  var sampleInput = input;
  sampleInput.uv = (vec2f(fullPixel) + 0.5) / vec2f(dimensions);
  let scene = textureLoad(sceneColor, fullPixel, 0);
  let z = textureLoad(sceneDepth, fullPixel, 0);
  let ray = atmosphere_view_ray(view, sampleInput.uv);
  let originDx = dpdx(ray.origin);
  let originDy = dpdy(ray.origin);
  let rayDx = dpdx(ray.direction);
  let rayDy = dpdy(ray.direction);
  var sceneMeters = CLOUD_UNTRACED_DEPTH_METERS;
  if z > 0.0 {
    let world = view.inverseViewProj * vec4f(sampleInput.uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), z, 1.0);
    sceneMeters = distance(world.xyz / world.w, ray.origin);
  }
  var interval = renderer_interval(ray.origin, ray.direction, cloud.layer.w);
  var depthRange = vec2f(sceneMeters);
  if mode0 { depthRange = cloud_scene_depth_range_meters(sceneDepth, vec2i(input.position.xy) * 4, vec2u(4), view.inverseViewProj, ray.origin); }
  interval.y = min(interval.y, depthRange.y);
  var radiance = vec3f(0.0);
  var nearRadiance = vec3f(0.0);
  var nearTransmittance = 1.0;
  var transmittance = 1.0;
  var representative = CLOUD_UNTRACED_DEPTH_METERS;
  var nearRepresentative = CLOUD_UNTRACED_DEPTH_METERS;
  if interval.x >= 0.0 && interval.y > interval.x {
    let count = u32(clamp(cloud.sampling.x, 1.0, 768.0));
    let ds = (interval.y - interval.x) / f32(count);
    let light = -view.lightDir;
    let basePhase = cloud_double_henyey_greenstein(cloud.phase.x, cloud.phase.y, cloud.phase.z, dot(ray.direction, light));
    var weight = 0.0;
    var weightedDepth = 0.0;
    var nearWeight = 0.0;
    var nearWeightedDepth = 0.0;
    for (var i = 0u; i < count; i++) {
      let distance = interval.x + (f32(i) + 0.5) * ds;
      let position = ray.origin + ray.direction * distance;
      let dx = originDx + rayDx * distance;
      let dy = originDy + rayDy * distance;
      let medium = renderer_medium(position, ray.origin, dx, dy);
      if !renderer_valid_medium(medium) { return CloudRendererTrace(CloudRendererOutputs(vec4f(1.0, 0.0, 1.0, 1.0), vec4f(0.0, 0.0, 0.0, 1.0), vec4f(-1.0)), ray.origin, ray.origin); }
      let sigma = max(0.0, medium.extinctionPerMeter);
      var contribution = vec3f(0.0);
      // Absorption and emission do not require an incident-light shadow query.
      if sigma > 0.0 && any(medium.albedo > vec3f(0.0)) {
      let octaves = cloud_optical_octaves(sigma, medium.albedo, basePhase, cloud.multipleScattering.x, cloud.multipleScattering.y, cloud.multipleScattering.z, u32(cloud.multipleScattering.w), false, true);
      let lightTau = renderer_light_tau(position, ray.origin, light, dx, dy);
      let solar = cloud_solar_light(view.atmosphere, position, cloud.groundSolar.rgb, light,
        cloud.skyAmbient.w > 0.5, cloud.environment.x > 0.5, solarTransmittance, sceneSampler);
      let sky = cloud_sky_light(cloud.skyAmbient, cloud.environment.y > 0.5,
        view.lightColor, distantSky) * medium.materialAO;
      if lightTau.x < 0.0 { return CloudRendererTrace(CloudRendererOutputs(vec4f(1.0, 0.0, 1.0, 1.0), vec4f(0.0, 0.0, 0.0, 1.0), vec4f(-1.0)), ray.origin, ray.origin); }
      for (var m = 0u; m <= u32(cloud.multipleScattering.w); m++) {
        let optical = octaves[m];
        var integral = ds;
        let opticalDepth = optical.extinctionPerMeter * ds;
        if opticalDepth > 0.0 { integral *= cloud_one_minus_beer(opticalDepth, exp(-opticalDepth)) / opticalDepth; }
        var octaveTau = cloud_shadow_ray_octave_tau(lightTau.x, cloud.multipleScattering.y, m);
        if lightTau.y > 0.5 { octaveTau = cloud_shadow_map_octave_tau(lightTau.x, cloud.multipleScattering.y, m); }
        contribution += optical.scatteringPerMeter * view.lightColor * solar * optical.phase * exp(-octaveTau) * integral;
        if m == 0u { contribution += (medium.emissivePerMeter + optical.scatteringPerMeter * sky) * integral; }
      }
      } else {
        var emissionLength = ds;
        let opticalDepth = sigma * ds;
        if opticalDepth > 0.0 { emissionLength *= cloud_one_minus_beer(opticalDepth, exp(-opticalDepth)) / opticalDepth; }
        contribution = medium.emissivePerMeter * emissionLength;
      }
      if sigma > 0.0 {
        weight += transmittance; weightedDepth += distance * transmittance;
        if distance <= depthRange.x { nearWeight += transmittance; nearWeightedDepth += distance * transmittance; }
      }
      radiance += transmittance * contribution;
      if distance <= depthRange.x { nearRadiance += transmittance * contribution; }
      if distance < depthRange.x { nearTransmittance *= exp(-sigma * ds); }
      transmittance *= exp(-sigma * ds);
      if cloud.sampling.z > 0.0 && transmittance < cloud.sampling.z { break; }
    }
    representative = select(interval.y, weightedDepth / max(weight, 1e-20), weight > 0.0);
    nearRepresentative = select(min(interval.y, depthRange.x), nearWeightedDepth / max(nearWeight, 1e-20), nearWeight > 0.0);
  } else { interval = vec2f(CLOUD_UNTRACED_DEPTH_METERS); }
  if mode0 { return CloudRendererTrace(CloudRendererOutputs(vec4f(radiance, transmittance), vec4f(nearRadiance, nearTransmittance), vec4f(representative, sceneMeters, depthRange)),
    ray.origin + ray.direction * representative, ray.origin + ray.direction * nearRepresentative); }
  return CloudRendererTrace(CloudRendererOutputs(vec4f(scene.rgb * transmittance + radiance, scene.a), vec4f(radiance, transmittance), vec4f(interval, sceneMeters, representative)), ray.origin, ray.origin);
}
@fragment fn fs_main(input: FullscreenOutput) -> CloudRendererOutputs { return renderer_trace(input, false).result; }
@fragment fn fs_trace_mode_zero(input: FullscreenOutput) -> CloudRendererOutputs {
  let traced = renderer_trace(input, true);
  return CloudRendererOutputs(cloud_height_transport(view, traced.farPosition, traced.result.composited),
    cloud_height_transport(view, traced.nearPosition, traced.result.lt), traced.result.depth);
}
@fragment fn fs_trace_mode_zero_air(input: FullscreenOutput) -> CloudRendererOutputs {
  let traced = renderer_trace(input, true);
  return CloudRendererOutputs(cloud_aerial_transport(view, traced.farPosition, traced.result.composited),
    cloud_aerial_transport(view, traced.nearPosition, traced.result.lt), traced.result.depth);
}
@fragment fn fs_shadow(input: FullscreenOutput) -> @location(0) vec4f {
  let origin = cloud.shadowOrigin.xyz + cloud.shadowAxisU.xyz * (input.uv.x * 2.0 - 1.0) + cloud.shadowAxisV.xyz * (input.uv.y * 2.0 - 1.0);
  let direction = normalize(cloud.shadowDirection.xyz);
  let dx = dpdx(origin);
  let dy = dpdy(origin);
  let interval = cloud_bsm_trace_interval(origin + vec3f(0.0, 6360000.0, 0.0), direction,
    6360000.0, cloud.layer.x, cloud.layer.y);
  if interval.x < 0.0 { return vec4f(cloud.shadowDirection.w, 0.0, 0.0, 1.0); }
  if interval.y <= interval.x { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var acc = vec4f(interval.y, 0.0, 0.0, 0.0);
  var step = 0.0;
  if interval.x >= 0.0 {
    let count = u32(clamp(cloud.shadowEncoding.x, 1.0, 768.0));
    step = (interval.y - interval.x) / f32(count);
    for (var i = 0u; i < count; i++) {
      let distance = interval.x + (f32(i) + 0.5) * step;
      let medium = renderer_medium(origin + direction * distance, view.cameraPos, dx, dy);
      if !renderer_valid_medium(medium) { return vec4f(-1.0); }
      acc = cloud_shadow_accumulate(acc, distance, vec3f(max(0.0, medium.extinctionPerMeter)));
    }
  }
  return vec4f(cloud_shadow_finish(acc, interval.y, step, cloud.shadowEncoding.y, cloud.shadowEncoding.z), 1.0);
}
`;
}
