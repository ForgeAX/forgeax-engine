#define_import_path forgeax_view::volume_inject
#import forgeax_pbr::shadow_pcf::{sample_shadow_2d_kernel, sample_shadow_2d_vogel}
#import forgeax_pbr::lighting_attenuation::{projectSpotUv}
#import forgeax_view::common::{DirectLightSlot}
// forgeax_pbr::lighting_punctual exports the surface-equivalent
// evalVolumePoint and evalVolumeSpot contract; this stage consumes their
// shared projector and shadow visibility facts without a second light owner.

struct View {
  worldViewProj : mat4x4<f32>, lightDir : vec3<f32>, lightColor : vec3<f32>, cameraPos : vec3<f32>,
  lightViewProj_A : mat4x4<f32>, inverseViewProj : mat4x4<f32>, lightViewProj_B : mat4x4<f32>,
  lightViewProj_C : mat4x4<f32>, lightViewProj_D : mat4x4<f32>, splitPlanes : array<vec4<f32>,4>,
  cascadeCount : f32, cascadeBlend : f32, depthBias : f32, normalBias : f32,
  directionalShadowFilter : vec4<f32>,
  spotLightViewProj : array<mat4x4<f32>,4>, temporalCurrentViewProj : mat4x4<f32>,
  temporalPreviousViewProj : mat4x4<f32>, temporalProjection : vec4<f32>, temporalPreviousCameraPos : vec4<f32>,
};

@group(0) @binding(3) var shadowMap : texture_depth_2d_array;
@group(0) @binding(4) var shadowSampler : sampler_comparison;

struct VolumeParams {
  bounds_min : vec4<f32>,
  bounds_max : vec4<f32>,
  extinction : vec4<f32>,
  albedo : vec4<f32>,
  emission : vec4<f32>,
  light_direction : vec4<f32>,
  light_color : vec4<f32>,
  optics : vec4<f32>,
  simulation : vec4<f32>,
};

const DIRECT_LIGHT_METADATA_SENTINEL : u32 = 0xffffffffu;
const DIRECT_LIGHT_TILE_MASK : u32 = 0x3fffffffu;

struct ClusterUniform {
  grid : vec4<u32>,
  near_far_log : vec4<f32>,
};

struct VolumeSet { scene : VolumeParams, members : array<VolumeParams, 11>, };
@group(0) @binding(5) var<uniform> volume_set : VolumeSet;
var<private> volume_params : VolumeParams;
@group(0) @binding(6) var volume_froxel : texture_storage_2d_array<rgba8unorm, write>;
@group(0) @binding(7) var<storage, read> light_data : array<DirectLightSlot, 256>;
@group(0) @binding(8) var<uniform> cluster_uniform : ClusterUniform;
@group(0) @binding(9) var spotShadowMap : texture_depth_2d_array;
@group(0) @binding(0) var<uniform> view : View;

fn reconstruct_world(uv : vec2<f32>, depth : f32) -> vec3<f32> {
  // WebGPU NDC depth is already [0, 1]; only XY needs the [-1, 1] remap.
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = view.inverseViewProj * ndc;
  return world.xyz / max(abs(world.w), 1e-30);
}

fn ray_box_interval(
  origin : vec3<f32>,
  direction : vec3<f32>,
  box_min : vec3<f32>,
  box_max : vec3<f32>,
) -> vec2<f32> {
  let safe_direction = select(direction, vec3<f32>(1e-5), abs(direction) < vec3<f32>(1e-5));
  let reciprocal = 1.0 / safe_direction;
  let near_point = (box_min - origin) * reciprocal;
  let far_point = (box_max - origin) * reciprocal;
  let near_distance = max(max(min(near_point.x, far_point.x), min(near_point.y, far_point.y)), min(near_point.z, far_point.z));
  let far_distance = min(min(max(near_point.x, far_point.x), max(near_point.y, far_point.y)), max(near_point.z, far_point.z));
  return vec2<f32>(max(near_distance, 0.0), max(far_distance, near_distance));
}

fn camera_view_depth(world_position : vec3<f32>) -> f32 {
  let clip = view.temporalCurrentViewProj * vec4<f32>(world_position, 1.0);
  let ndc_depth = clip.z / max(abs(clip.w), 1e-5);
  let orthographic_depth = view.temporalProjection.y -
    ndc_depth * (view.temporalProjection.y - view.temporalProjection.x);
  return select(max(clip.w, 0.0), max(orthographic_depth, 0.0), view.temporalProjection.z >= 0.5);
}

fn volume_cascade(world_position : vec3<f32>, view_depth : f32) -> f32 {
  if (view.cascadeCount < 1.0) { return 1.0; }
  let count = u32(max(view.cascadeCount, 1.0));
  if (view_depth > view.splitPlanes[count - 1u].x) { return 1.0; }
  var layer = count - 1u;
  for (var index = 0u; index < count - 1u; index = index + 1u) {
    if (view_depth < view.splitPlanes[index].x) { layer = index; break; }
  }
  var light_matrix = view.lightViewProj_D;
  switch (layer) {
    case 0u: { light_matrix = view.lightViewProj_A; }
    case 1u: { light_matrix = view.lightViewProj_B; }
    case 2u: { light_matrix = view.lightViewProj_C; }
    default: { }
  }
  let clip = light_matrix * vec4<f32>(world_position, 1.0);
  let projected = clip.xyz / max(abs(clip.w), 1e-5);
  let tile_uv = vec2<f32>(projected.x * 0.5 + 0.5, -projected.y * 0.5 + 0.5);
  if (!(tile_uv.x >= 0.0 && tile_uv.x <= 1.0 && tile_uv.y >= 0.0 && tile_uv.y <= 1.0 && projected.z >= 0.0 && projected.z <= 1.0)) { return 1.0; }
  let shadow_size = vec2<f32>(textureDimensions(shadowMap, 0));
  let filter_profile = clamp(u32(round(view.directionalShadowFilter.x)), 1u, 6u);
  if (filter_profile == 6u) {
    return sample_shadow_2d_vogel(shadowMap, shadowSampler, tile_uv, i32(layer),
      1.0 / shadow_size, projected.z + view.depthBias, vec2<f32>(0.0), tile_uv * shadow_size);
  }
  // Volumetric injection currently owns a depth-only PCF receiver. Directional
  // PCSS profiles remain an explicit capability fallback here: the surface
  // directional owner performs blocker search, while volume keeps the same
  // accepted filter carrier and uses the stable PCF3 receiver instead of
  // misreading profiles 4/5 as a kernel width.
  let volume_kernel = select(
    select(select(3.0, 5.0, filter_profile == 3u), 1.0, filter_profile == 1u),
    3.0,
    filter_profile >= 4u,
  );
  return sample_shadow_2d_kernel(
    shadowMap, shadowSampler, tile_uv, i32(layer), 1.0 / shadow_size, projected.z,
    0.0, view.depthBias, 1.0, volume_kernel,
  );
}

fn shadowAtlasTile(light : DirectLightSlot) -> i32 {
  let encoded = light.metadata.y;
  if (encoded == DIRECT_LIGHT_METADATA_SENTINEL) { return -1; }
  // Projector-selected spots carry the marker in bit 30 and retain the
  // selected shadow tile in the lower 30 bits. A projector-only spot uses
  // tile zero, matching the surface projector contract.
  let tile = encoded & DIRECT_LIGHT_TILE_MASK;
  if (tile >= 4u) { return -1; }
  return i32(tile);
}

fn selected_cluster_light_slot(value : f32) -> i32 {
  let slot = i32(round(value));
  if (slot < 0) { return -1; }
  let index = u32(slot);
  if (index >= cluster_uniform.grid.w || index >= 256u) { return -1; }
  return slot;
}

fn spot_shadow_visibility_at(world_position : vec3<f32>) -> f32 {
  let slot = selected_cluster_light_slot(volume_params.light_color.w);
  if (slot < 0) { return 0.0; }
  let light = light_data[u32(slot)];
  let encodedTile = shadowAtlasTile(light);
  if (encodedTile < 0) { return 1.0; }
  let tile = u32(encodedTile);
  let projectorUv = projectSpotUv(view.spotLightViewProj[tile], world_position);
  // The accepted projector tuple is sampled with textureSampleLevel by the
  // surface and volume owners when a projector texture is present.
  let projectorRevision = volume_params.light_color.w;
  let clip = view.spotLightViewProj[tile] * vec4<f32>(world_position, 1.0);
  // Shadow filtering is fail-open outside the light frustum. The map owns
  // occlusion inside its tile; it must not darken samples behind the light or
  // beyond the far plane, matching the surface SpotLight shadow contract.
  if (clip.w <= 1e-5) { return 1.0; }
  let projected = clip.xyz / clip.w;
  let local_uv = vec2<f32>(projected.x * 0.5 + 0.5, -projected.y * 0.5 + 0.5);
  if (any(projectorUv < vec2<f32>(0.0)) || any(projectorUv > vec2<f32>(1.0))) { return 1.0; }
  if (any(local_uv < vec2<f32>(0.0)) || any(local_uv > vec2<f32>(1.0)) || projected.z < 0.0 || projected.z > 1.0) {
    return 1.0;
  }
  let shadow_size = vec2<f32>(textureDimensions(spotShadowMap, 0));
  return sample_shadow_2d_kernel(
    spotShadowMap, shadowSampler, local_uv, i32(tile), 1.0 / shadow_size, projected.z,
    light.auxiliary.y, light.auxiliary.x, 1.0, 3.0,
  );
}

fn shadow_visibility_at(world_position : vec3<f32>) -> f32 {
  let in_bounds = all(world_position >= volume_params.bounds_min.xyz) &&
    all(world_position <= volume_params.bounds_max.xyz);
  if (!in_bounds) { return 0.0; }
  let view_depth = camera_view_depth(world_position);
  return volume_cascade(world_position, view_depth);
}

@compute @workgroup_size(8, 8, 1)
fn volume_inject(@builtin(global_invocation_id) id : vec3<u32>) {
  let owner_count = clamp(u32(volume_set.scene.bounds_min.w), 1u, 11u);
  let owner_layers = textureNumLayers(volume_froxel) / owner_count;
  let owner = id.z / owner_layers;
  if (owner >= owner_count) { return; }
  volume_params = volume_set.members[owner];
  let volume_size = textureDimensions(volume_froxel);
  if (id.x >= volume_size.x || id.y >= volume_size.y) { return; }
  let froxel_size = vec2<f32>(textureDimensions(volume_froxel).xy);
  // Stable cell centers match the integration grid. Frame-varying offsets
  // move shadow boundaries even when the scene and camera are stationary.
  let depth_uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / froxel_size;
  let ray_origin = reconstruct_world(depth_uv, 1.0);
  let ray_endpoint = reconstruct_world(depth_uv, 0.0);
  let ray_direction = normalize(ray_endpoint - ray_origin);
  let interval = ray_box_interval(
    ray_origin,
    ray_direction,
    volume_params.bounds_min.xyz,
    volume_params.bounds_max.xyz,
  );
  let ray_near = interval.x;
  let ray_limit = max(ray_near, min(interval.y, volume_params.optics.x));
  let mode = u32(round(volume_params.optics.z));
  let uses_spot_shadow = mode == 2u || mode == 3u;
  // Directional misses already contribute zero. Clear retained texels before
  // returning; the integrate stage linearly samples this visibility field.
  // Spot misses retain their original values for neighboring covered rays.
  if (!uses_spot_shadow && ray_limit <= ray_near) {
    textureStore(volume_froxel, id.xy, id.z, vec4<f32>(0.0));
    return;
  }
  let logical_depth = max(owner_layers * 4u, 1u);
  var visibility = vec4<f32>(0.0);
  for (var channel = 0u; channel < 4u; channel = channel + 1u) {
    let logical_slice = (id.z % owner_layers) * 4u + channel;
    if (logical_slice >= logical_depth) { continue; }
    let slice = clamp((f32(logical_slice) + 0.5) / f32(logical_depth), 0.0, 1.0);
    let slice_world = ray_origin + ray_direction * mix(ray_near, ray_limit, slice);
    // A paired Point+Spot volume owns two radiance terms. The spot shadow is
    // stored for the spot term; the integrate stage applies it only to that
    // term so PointLight radiance remains visible outside the spot cone.
    // select evaluates both arguments, including the unused shadow receiver.
    if (uses_spot_shadow) {
      visibility[channel] = spot_shadow_visibility_at(slice_world);
    } else {
      visibility[channel] = shadow_visibility_at(slice_world);
    }
  }
  textureStore(volume_froxel, id.xy, id.z, visibility);
}
