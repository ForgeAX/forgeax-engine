#define_import_path forgeax_view::volume_integrate
// forgeax_pbr::lighting_punctual remains the surface contract; the isolated
// attenuation module below provides its resource-free volume equivalents.
#import forgeax_pbr::lighting_attenuation::{projectSpotUv, evalDistanceAttenuation}
#import forgeax_view::common::{DirectLightSlot, View}
#import forgeax_atmosphere::optics::{atmosphere_solar_transmittance, atmosphere_position}
#import forgeax_cloud::layer::{cloud_apply_direct_solar}

// Volume reads the same full light_data payload as Standard surface Cluster;
// it has no secondary light mirror.
struct ClusterUniform {
  grid : vec4<u32>,
  near_far_log : vec4<f32>,
};
struct VolumeParams {
  bounds_min : vec4<f32>, bounds_max : vec4<f32>, extinction : vec4<f32>, albedo : vec4<f32>,
  emission : vec4<f32>, light_direction : vec4<f32>, light_color : vec4<f32>, optics : vec4<f32>,
  simulation : vec4<f32>,
};
const EPSILON : f32 = 1e-5;
const FOUR_PI : f32 = 12.566370614359172;
// The punctual light buffers carry the integrated surface-light value
// (color * candela * inverse-square attenuation).  The normalized HG phase
// below is a per-steradian distribution, so the volume boundary converts the
// shared light value into that basis exactly once.  This keeps public light
// units unchanged while matching the Three.js volume-lighting convention,
// which accumulates the same direct-light value before applying an
// unnormalized phase.
const VOLUME_LIGHT_PHASE_SCALE : f32 = FOUR_PI;

@group(0) @binding(0) var froxel : texture_2d_array<f32>;
@group(0) @binding(1) var scene_depth : texture_depth_2d;
@group(0) @binding(2) var resolved : texture_storage_2d<rgba16float, write>;
struct VolumeSet { scene : VolumeParams, members : array<VolumeParams, 11>, };
@group(0) @binding(3) var<uniform> volume_set : VolumeSet;
var<private> volume_params : VolumeParams;
var<private> volume_owner : u32;
@group(0) @binding(4) var<uniform> volume_view : View;
@group(0) @binding(5) var froxel_sampler : sampler;
@group(0) @binding(6) var density : texture_3d<f32>;
@group(0) @binding(7) var density_sampler : sampler;
@group(0) @binding(8) var history_seed : texture_storage_2d<rgba16float, write>;
@group(0) @binding(9) var temporal_seed : texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var<storage, read> light_data : array<DirectLightSlot, 256>;
@group(0) @binding(11) var<uniform> cluster_uniform : ClusterUniform;
@group(0) @binding(12) var projectorTexture : texture_2d<f32>;
@group(0) @binding(13) var projectorSampler : sampler;
@group(0) @binding(18) var density1 : texture_3d<f32>;
@group(0) @binding(19) var density2 : texture_3d<f32>;
@group(0) @binding(20) var density3 : texture_3d<f32>;
@group(0) @binding(21) var density4 : texture_3d<f32>;
@group(0) @binding(22) var density5 : texture_3d<f32>;
@group(0) @binding(23) var density6 : texture_3d<f32>;
@group(0) @binding(25) var atmosphere_transmittance : texture_2d<f32>;
@group(0) @binding(26) var atmosphere_sampler : sampler;
@group(0) @binding(24) var density7 : texture_3d<f32>;
@group(0) @binding(27) var density8 : texture_3d<f32>;
@group(0) @binding(28) var density9 : texture_3d<f32>;
@group(0) @binding(29) var density10 : texture_3d<f32>;

fn sample_volume_texture(source : texture_3d<f32>, coordinate : vec3<f32>) -> vec4<f32> {
  var uvw = coordinate;
  if (volume_params.bounds_max.w > 1.5) {
    // The new local optical field is finite, not periodic. Clamp at texel
    // centers using this owner's actual extent while retaining the shared
    // repeat sampler and the existing noise/scalar sampling behavior.
    let half_texel = vec3<f32>(0.5) / vec3<f32>(textureDimensions(source));
    uvw = clamp(uvw, half_texel, vec3<f32>(1.0) - half_texel);
  }
  return textureSampleLevel(source, density_sampler, uvw, 0.0);
}

fn sample_volume_source(coordinate : vec3<f32>) -> vec4<f32> {
  switch volume_owner {
    case 1u: { return sample_volume_texture(density1, coordinate); }
    case 2u: { return sample_volume_texture(density2, coordinate); }
    case 3u: { return sample_volume_texture(density3, coordinate); }
    case 4u: { return sample_volume_texture(density4, coordinate); }
    case 5u: { return sample_volume_texture(density5, coordinate); }
    case 6u: { return sample_volume_texture(density6, coordinate); }
    case 7u: { return sample_volume_texture(density7, coordinate); }
    case 8u: { return sample_volume_texture(density8, coordinate); }
    case 9u: { return sample_volume_texture(density9, coordinate); }
    case 10u: { return sample_volume_texture(density10, coordinate); }
    default: { return sample_volume_texture(density, coordinate); }
  }
}
fn hg(cos_theta : f32, anisotropy : f32) -> f32 {
  let g = clamp(anisotropy, -0.999, 0.999);
  let denominator = max(1.0 + g * g - 2.0 * g * clamp(cos_theta, -1.0, 1.0), EPSILON);
  return (1.0 - g * g) / (FOUR_PI * pow(denominator, 1.5));
}
fn reconstruct_world(uv : vec2<f32>, depth : f32) -> vec3<f32> {
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = volume_view.inverseViewProj * clip;
  return world.xyz / max(abs(world.w), 1e-30);
}
fn ray_box_interval(origin : vec3<f32>, direction : vec3<f32>) -> vec2<f32> {
  let safe_direction = select(direction, vec3<f32>(EPSILON), abs(direction) < vec3<f32>(EPSILON));
  let reciprocal = 1.0 / safe_direction;
  let a = (volume_params.bounds_min.xyz - origin) * reciprocal;
  let b = (volume_params.bounds_max.xyz - origin) * reciprocal;
  let near_distance = max(max(min(a.x, b.x), min(a.y, b.y)), min(a.z, b.z));
  let far_distance = min(min(max(a.x, b.x), max(a.y, b.y)), max(a.z, b.z));
  return vec2<f32>(max(near_distance, 0.0), max(far_distance, near_distance));
}

fn evalSpotAttenuation(
lightPos : vec3<f32>, lightDir : vec3<f32>, worldPos : vec3<f32>,
cosInner : f32, cosOuter : f32, invRangeSquared : f32,
) -> f32 {
  let toLight = lightPos - worldPos;
  let dSquared = dot(toLight, toLight);
  let safeDistance = max(dSquared, EPSILON);
  let window = clamp(1.0 - (safeDistance * invRangeSquared) * (safeDistance * invRangeSquared), 0.0, 1.0);
  let distance = window * window / safeDistance;
  let direction = normalize(select(vec3<f32>(0.0, 0.0, -1.0), toLight, dSquared > EPSILON));
  return distance * smoothstep(cosOuter, cosInner, dot(direction, -normalize(lightDir)));
}

fn shadowAtlasTile(light : DirectLightSlot) -> i32 {
  let encoded = light.metadata.y;
  if (encoded == 0xffffffffu) { return -1; }
  let tile = encoded & 0x3fffffffu;
  if (tile >= 4u) { return -1; }
  return i32(tile);
}

fn spotProjectorMatrix(light : DirectLightSlot) -> mat4x4<f32> {
  let tile = shadowAtlasTile(light);
  if (tile >= 0) {
    return volume_view.spotLightViewProj[tile];
  }
  return volume_view.spotLightViewProj[0];
}

fn selected_cluster_light_slot(value : f32) -> i32 {
  let slot = i32(round(value));
  if (slot < 0) { return -1; }
  let index = u32(slot);
  if (index >= cluster_uniform.grid.w || index >= 256u) { return -1; }
  return slot;
}

fn spot_attenuation_at(world_position : vec3<f32>) -> f32 {
  let slot = selected_cluster_light_slot(volume_params.light_color.w);
  if (slot < 0) { return 0.0; }
  let light = light_data[u32(slot)];
  let projectorUv = projectSpotUv(spotProjectorMatrix(light), world_position);
  if (any(projectorUv < vec2<f32>(0.0)) || any(projectorUv > vec2<f32>(1.0))) { return 0.0; }
  return evalSpotAttenuation(
  light.position.xyz,
  light.direction.xyz,
  world_position,
  light.colorTimesIntensity.w,
  light.direction.w,
  light.position.w,
  );
}

fn evalVolumePoint(
lightPos : vec3<f32>, colorTimesIntensity : vec3<f32>,
invRangeSquared : f32, decay : f32, worldPos : vec3<f32>,
) -> vec3<f32> {
  let toLight = lightPos - worldPos;
  return colorTimesIntensity * evalDistanceAttenuation(
    dot(toLight, toLight), invRangeSquared, decay, EPSILON,
  );
}

fn evalVolumeSpot(
lightPos : vec3<f32>, lightDir : vec3<f32>, colorTimesIntensity : vec3<f32>,
cosInner : f32, cosOuter : f32, invRangeSquared : f32, worldPos : vec3<f32>,
) -> vec3<f32> {
  return colorTimesIntensity * evalSpotAttenuation(
  lightPos, lightDir, worldPos, cosInner, cosOuter, invRangeSquared,
  );
}

fn volume_point_radiance(world_position : vec3<f32>) -> vec3<f32> {
  let pointSlot = selected_cluster_light_slot(volume_params.emission.w);
  if (pointSlot < 0) { return vec3<f32>(0.0); }
  let point = light_data[u32(pointSlot)];
  return evalVolumePoint(
  point.position.xyz, point.colorTimesIntensity.xyz, point.position.w, point.colorTimesIntensity.w, world_position,
  );
}

fn volume_spot_radiance(world_position : vec3<f32>) -> vec3<f32> {
  let spotSlot = selected_cluster_light_slot(volume_params.light_color.w);
  if (spotSlot < 0) { return vec3<f32>(0.0); }
  let spot = light_data[u32(spotSlot)];
  let radiance = evalVolumeSpot(
  spot.position.xyz, spot.direction.xyz, spot.colorTimesIntensity.xyz,
  spot.colorTimesIntensity.w, spot.direction.w, spot.position.w, world_position,
  );
  // Only the renderer-selected projector owner may consume the shared map.
  if (spot.metadata.y == 0xffffffffu || (spot.metadata.y & 0x40000000u) == 0u) {
    return radiance;
  }
  let projectorUv = projectSpotUv(spotProjectorMatrix(spot), world_position);
  if (!(projectorUv.x >= 0.0 && projectorUv.x <= 1.0 && projectorUv.y >= 0.0 && projectorUv.y <= 1.0)) {
    // A SpotLight map modulates the light only inside its projected tile.
    // Three keeps the cone/attenuation result outside that tile; the map is
    // not a second frustum mask.
    return radiance;
  }
  return radiance * textureSampleLevel(projectorTexture, projectorSampler, projectorUv, 0.0).rgb;
}

fn volume_spot_shadow_intensity() -> f32 {
  let spotSlot = selected_cluster_light_slot(volume_params.light_color.w);
  if (spotSlot < 0) { return 1.0; }
  return clamp(light_data[u32(spotSlot)].auxiliary.z, 0.0, 1.0);
}

fn volume_light_radiance(world_position : vec3<f32>) -> vec3<f32> {
  let mode = u32(round(volume_params.optics.z));
  if (mode == 0u) {
    var solar=vec3<f32>(1.0);
    if volume_view.atmosphereControl.w>0.5 {
      // The atmospheric sun is irradiance; cancel the legacy FOUR_PI phase
      // convention exactly once for this physical directional source.
      solar=atmosphere_solar_transmittance(volume_view.atmosphere,atmosphere_position(volume_view.atmosphere,world_position),normalize(-volume_view.lightDir),atmosphere_transmittance,atmosphere_sampler) / FOUR_PI;
    }
    return cloud_apply_direct_solar(
    volume_params.light_color.xyz*solar,
    world_position,
    volume_view.cloudShadowOrigin.xyz,
    volume_view.cloudShadowRight.xyz,
    volume_view.cloudShadowUp.xyz,
    volume_view.cloudShadowProjection,
    );
  }
  var radiance = vec3<f32>(0.0);
  if (mode == 1u || mode == 3u) {
    radiance = radiance + volume_point_radiance(world_position);
  }
  if (mode == 2u || mode == 3u) {
    radiance = radiance + volume_spot_radiance(world_position);
  }
  return radiance;
}

fn volume_light_radiance_pair(world_position : vec3<f32>, spot_visibility : f32) -> vec3<f32> {
  // Keep the pair's PointLight term independent from the SpotLight shadow.
  return volume_point_radiance(world_position) +
  volume_spot_radiance(world_position) *
  mix(1.0, spot_visibility, volume_spot_shadow_intensity());
}

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn finiteVec3(value : vec3<f32>) -> bool {
  return isFinite(value.x) && isFinite(value.y) && isFinite(value.z);
}

// Match the pinned Three.js VolumeNodeMaterial density expression while
// keeping the authored TextureAsset and its renderer-owned sampler intact.
fn volume_sample_grain(
position : vec3<f32>,
scale : f32,
time_scaled : vec3<f32>,
time_scale : f32,
) -> f32 {
  let coordinate = fract((position + time_scaled * time_scale) * scale);
  return sample_volume_source(coordinate).r + 0.5;
}

// RGB carries albedo * density and A carries density. Filtering these optical
// coefficients preserves color at field/vacuum boundaries without a second
// density multiplication. Legacy scalar sources have unit field albedo.
fn volume_optical_sample(position : vec3<f32>, world_time_seconds : f32) -> vec4<f32> {
  if (volume_params.bounds_max.w > 0.5) {
    let coordinate = (position - volume_params.bounds_min.xyz) /
    max(volume_params.bounds_max.xyz - volume_params.bounds_min.xyz, vec3<f32>(EPSILON));
    let field = sample_volume_source(clamp(coordinate, vec3<f32>(0.0), vec3<f32>(1.0)));
    if (volume_params.bounds_max.w > 1.5) {
      let density_value = max(field.a, 0.0);
      return vec4<f32>(clamp(field.rgb, vec3<f32>(0.0), vec3<f32>(density_value)), density_value);
    }
    return vec4<f32>(max(field.r, 0.0));
  }
  let time = world_time_seconds;
  let time_scaled = vec3<f32>(time, 0.0, time * 0.3);
  var grain = volume_sample_grain(position, 0.1, time_scaled, 1.0);
  grain = grain * volume_sample_grain(position, 0.05, time_scaled, 1.0);
  grain = grain * volume_sample_grain(position, 0.02, time_scaled, 2.0);
  // TSL's smokeAmount.mix(1, grain) expands to mix(1, grain, 2).
  return vec4<f32>(max(2.0 * grain - 1.0, 0.0));
}

fn packed_visibility_at(previous : vec4<f32>, current : vec4<f32>, next : vec4<f32>, channel : i32) -> f32 {
  if (channel < 0) { return previous.w; }
  if (channel > 3) { return next.x; }
  return current[channel];
}

@compute @workgroup_size(8, 8, 1)
fn volume_integrate(@builtin(global_invocation_id) id : vec3<u32>) {
  volume_params = volume_set.scene;
  let owner_count = clamp(u32(volume_params.bounds_min.w), 1u, 11u);
  let output_size = textureDimensions(resolved);
  if (any(id.xy >= output_size)) { return; }
  let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(output_size);
  let origin = reconstruct_world(uv, 1.0);
  let far_point = reconstruct_world(uv, 0.5);
  let ray_direction = normalize(far_point - origin);
  let interval = ray_box_interval(origin, ray_direction);
  let ray_near = interval.x;
  let ray_far = min(interval.y, volume_params.optics.x);
  let depth_size = textureDimensions(scene_depth);
  let pixel = min(vec2<u32>(uv * vec2<f32>(depth_size)), max(depth_size, vec2<u32>(1u)) - vec2<u32>(1u));
  let scene_depth_value = textureLoad(scene_depth, vec2<i32>(pixel), 0);
  let scene_world = reconstruct_world(uv, scene_depth_value);
  let scene_distance = select(ray_far, max(dot(scene_world - origin, ray_direction), 0.0), scene_depth_value > 0.0);
  let clipped_far = min(ray_far, scene_distance);
  let owner_layers = textureNumLayers(froxel) / owner_count;
  let visibility_depth = max(owner_layers * 4u, 1u);
  let ray_step_count = 96u;
  // Partition at local-volume boundaries so thin, separated volumes cannot
  // disappear between samples of their much larger union. Single-volume
  // sampling retains the upstream midpoint budget and final depth clip.
  var boundaries : array<f32, 22>;
  var boundary_count = 2u;
  boundaries[0] = ray_near;
  boundaries[1] = ray_far;
  if (owner_count > 1u) {
    boundary_count = 0u;
    for (var owner = 0u; owner < owner_count; owner += 1u) {
      volume_params = volume_set.members[owner];
      let member = ray_box_interval(origin, ray_direction);
      let end = min(min(member.y, volume_params.optics.x), scene_distance);
      if (end > member.x) {
        boundaries[boundary_count] = member.x;
        boundaries[boundary_count + 1u] = end;
        boundary_count += 2u;
      }
    }
    for (var i = 1u; i < boundary_count; i += 1u) {
      let value = boundaries[i];
      var j = i;
      while (j > 0u) {
        if (boundaries[j - 1u] <= value) { break; }
        boundaries[j] = boundaries[j - 1u];
        j -= 1u;
      }
      boundaries[j] = value;
    }
  }
  var transmittance = 1.0;
  var scattering = vec3<f32>(0.0);
  for (var interval_index = 1u; interval_index < boundary_count; interval_index += 1u) {
    let interval_start = boundaries[interval_index - 1u];
    let interval_end = boundaries[interval_index];
    if (interval_end <= interval_start) { continue; }
    let ray_step = (interval_end - interval_start) / f32(ray_step_count);
    for (var step = 0u; step < ray_step_count; step = step + 1u) {
      let segment_start = interval_start + f32(step) * ray_step;
      let segment_length = clamp(clipped_far - segment_start, 0.0, ray_step);
      if (segment_length > 0.0) {
        // Near a punctual source, inverse-square falloff and the spot cone
        // vary faster than the base interval. Refine only these short segments;
        // increasing the whole-ray budget would waste work away from the source.
        let midpoint = origin + ray_direction * (segment_start + segment_length * 0.5);
        var nearest_light_squared = 1e20;
        for (var owner = 0u; owner < owner_count; owner += 1u) {
          volume_params = volume_set.members[owner];
          let light_mode = u32(round(volume_params.optics.z));
          let point_slot = selected_cluster_light_slot(volume_params.emission.w);
          let spot_slot = selected_cluster_light_slot(volume_params.light_color.w);
          if ((light_mode == 1u || light_mode == 3u) && point_slot >= 0) {
            let offset = midpoint - light_data[u32(point_slot)].position.xyz;
            nearest_light_squared = min(nearest_light_squared, dot(offset, offset));
          }
          if ((light_mode == 2u || light_mode == 3u) && spot_slot >= 0) {
            let offset = midpoint - light_data[u32(spot_slot)].position.xyz;
            nearest_light_squared = min(nearest_light_squared, dot(offset, offset));
          }
        }
        let subdivisions = select(1u, 4u, nearest_light_squared < 16.0 * ray_step * ray_step);
        let sample_length = segment_length / f32(subdivisions);
        for (var substep = 0u; substep < subdivisions; substep = substep + 1u) {
          let sample_t = segment_start + (f32(substep) + 0.5) * sample_length;
          let world_position = origin + ray_direction * sample_t;
          var extinction = 0.0;
          var source = vec3<f32>(0.0);
          var emission = vec3<f32>(0.0);
          for (var owner = 0u; owner < owner_count; owner += 1u) {
            volume_owner = owner;
            volume_params = volume_set.members[owner];
            if (any(world_position < volume_params.bounds_min.xyz) ||
            any(world_position > volume_params.bounds_max.xyz) ||
            sample_t > volume_params.optics.x) { continue; }
            let member_interval = ray_box_interval(origin, ray_direction);
            let member_far = min(member_interval.y, volume_params.optics.x);
            let member_step = max(member_far - member_interval.x, EPSILON) / f32(visibility_depth);
            let phase = hg(dot(-normalize(volume_params.light_direction.xyz), ray_direction), volume_params.optics.y);
            let sigma_scale = max(dot(volume_params.extinction.xyz, vec3<f32>(0.3333333)), 0.0);
            // The exact Three.js smokeAmount transform can produce negative values
            // from its signed noise domain. Beer-Lambert optical depth is physical
            // extinction, so the renderer clamps only this consumed density while
            // retaining the authored source expression and its signed diagnostics.
            let optical_sample = volume_optical_sample(world_position, volume_params.simulation.x);
            let density_value = optical_sample.a;
            let sample_position = clamp(
            (sample_t - member_interval.x) / member_step - 0.5,
            0.0,
            f32(visibility_depth - 1u),
            );
            let lower_position = u32(floor(sample_position));
            let upper_position = min(lower_position + 1u, visibility_depth - 1u);
            let interpolation = sample_position - f32(lower_position);
            let slice_group = owner * owner_layers + lower_position / 4u;
            let upper_group = owner * owner_layers + upper_position / 4u;
            let lower_packed = textureSampleLevel(froxel, froxel_sampler, uv, i32(slice_group), 0.0);
            let upper_packed = textureSampleLevel(froxel, froxel_sampler, uv, i32(upper_group), 0.0);
            let lower_visibility = lower_packed[i32(lower_position % 4u)];
            let upper_visibility = upper_packed[i32(upper_position % 4u)];
            let shadow_visibility = clamp(mix(lower_visibility, upper_visibility, interpolation), 0.0, 1.0);
            // Apply the packed SpotLight shadow only to the spot contribution.
            // PointLight distance attenuation remains independent of the spot cone.
            let mode = u32(round(volume_params.optics.z));
            let visibility = select(
            shadow_visibility,
            mix(1.0, shadow_visibility, volume_spot_shadow_intensity()),
            mode == 2u || mode == 3u,
            );
            let radiance = select(
            volume_light_radiance(world_position) * visibility,
            volume_light_radiance_pair(world_position, visibility),
            mode == 3u,
            );
            let sigma = sigma_scale * density_value;
            extinction += sigma;
            source += radiance * volume_params.albedo.xyz * phase * VOLUME_LIGHT_PHASE_SCALE *
            (optical_sample.rgb * sigma_scale);
            emission += volume_params.emission.xyz * density_value;
          }
          // Add local optical coefficients before integration: overlap must not
          // depend on entity order or composite two separately integrated images.
          let local_transmittance = exp(-extinction * sample_length);
          let local_scatter = source * (1.0 - local_transmittance) / max(extinction, EPSILON) +
          emission * sample_length;
          scattering = scattering + transmittance * local_scatter;
          transmittance = transmittance * local_transmittance;
        }
      }
    }
  }
  let finite = isFinite(transmittance) && finiteVec3(scattering);
  let result = select(vec4<f32>(0.0, 0.0, 0.0, 1.0), vec4<f32>(scattering, transmittance), finite);
  textureStore(resolved, id.xy, result);
  if (volume_set.scene.optics.w < 0.5) {
    textureStore(history_seed, id.xy, result);
    textureStore(temporal_seed, id.xy, result);
  }
}
