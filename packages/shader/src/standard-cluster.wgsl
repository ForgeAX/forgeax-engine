// standard-cluster.wgsl — Standard clustered punctual light evaluation.
// feat-20260608-cluster-lighting M4 / w17.
//
// The cluster module owns membership and raw payload decoding only. Punctual
// BRDF, range, cone, PCF, and fail-open behavior live in lighting-punctual.
// ProbeBlendRecord is intentionally absent: probes are not DirectLightSlot
// members and this cluster owner never performs an all-probe loop.

#define_import_path forgeax_standard::cluster
#import forgeax_view::common::{lightingChannelsMatch}

#import forgeax_pbr::lighting_punctual::{evalPoint, evalPointFlat, evalSpot, evalSpotFlat, evalSpotShadowed}
#import forgeax_pbr::lighting_spot_modifiers::{spotModifierFactors}
#import forgeax_pbr::lighting_ies_profile::{iesProfileFactor}
#import forgeax_pbr::lighting_rect_area::{evalRectAreaLtcGgx}
#import forgeax_view::common::{view}
#ifdef PROJECTOR_AVAILABLE
#import forgeax_pbr::lighting_spot_projector::{sampleStandardSpotProjector}
#endif
#ifdef POINT_SHADOW_AVAILABLE
#import forgeax_pbr::lighting_punctual::{evalPointShadowed}
#import forgeax_view::common::{shadowParams}
#endif

#ifdef CLUSTER_FORWARD_AVAILABLE

const KIND_POINT: u32 = 0u;
const KIND_SPOT: u32 = 1u;
const KIND_RECT_AREA: u32 = 2u;
const KIND_MASK: u32 = 0xffu;
const PCF_SHIFT: u32 = 8u;
const PROJECTOR_FLAG: i32 = 0x40000000;
const TILE_MASK: i32 = 0x3fffffff;

// DirectLightSlot is the byte-frozen 96B std430/std140 transport contract.
// The named rows match the host packer; metadata carries kind and identities.
struct DirectLightSlot {
  position            : vec4<f32>,
  colorTimesIntensity : vec4<f32>,
  direction           : vec4<f32>,
  auxiliary           : vec4<f32>,
  metadata            : vec4<u32>,
  channels            : vec4<u32>,
};

const DIRECT_LIGHT_SLOT_BYTE_SIZE: u32 = 96u;

struct ClusterUniform {
  grid         : vec4<u32>,
  near_far_log : vec4<f32>,
};

#ifdef STORAGE_BUFFER_AVAILABLE
@group(2) @binding(3) var<storage, read> light_data      : array<DirectLightSlot, 256>;
@group(2) @binding(4) var<storage, read> cluster_grid     : array<u32>;
@group(2) @binding(5) var<storage, read> light_index_list : array<u32>;
#else
// The CPU membership producer packs the same bytes into one rgba32uint texture:
// 256 light records, then grid offset/count pairs, then the complete index list.
@group(2) @binding(3) var cluster_data_texture : texture_2d<u32>;

const CLUSTER_TEXTURE_WIDTH: u32 = 1024u;
const CLUSTER_TEXTURE_GRID_WORD_OFFSET: u32 = 256u * (DIRECT_LIGHT_SLOT_BYTE_SIZE / 4u);

fn load_cluster_texel(texel: u32) -> vec4<u32> {
  return textureLoad(cluster_data_texture, vec2<i32>(
    i32(texel % CLUSTER_TEXTURE_WIDTH), i32(texel / CLUSTER_TEXTURE_WIDTH),
  ), 0);
}

fn load_cluster_word(word: u32) -> u32 {
  return load_cluster_texel(word >> 2u)[word & 3u];
}

fn load_cluster_light(index: u32) -> DirectLightSlot {
  let first = index * (DIRECT_LIGHT_SLOT_BYTE_SIZE / 16u);
  return DirectLightSlot(
    bitcast<vec4<f32>>(load_cluster_texel(first)),
    bitcast<vec4<f32>>(load_cluster_texel(first + 1u)),
    bitcast<vec4<f32>>(load_cluster_texel(first + 2u)),
    bitcast<vec4<f32>>(load_cluster_texel(first + 3u)),
    load_cluster_texel(first + 4u),
    load_cluster_texel(first + 5u),
  );
}
#endif
@group(2) @binding(6) var<uniform> cluster_uniform : ClusterUniform;

fn get_ssao_intensity() -> f32 {
  return cluster_uniform.near_far_log.w;
}

// Shared by static, skinned, and custom Standard surface programs.
fn sampleStandardAmbientOcclusion(
  worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>,
  aoTexture: texture_2d<f32>, aoSampler: sampler,
) -> f32 {
  let strength = get_ssao_intensity();
  if (strength <= 0.0) { return 1.0; }
  let clip = worldViewProjection * vec4<f32>(worldPosition, 1.0);
  let uv = clip.xy / clip.w * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  return pow(clamp(textureSampleLevel(aoTexture, aoSampler, uv, 0.0).r, 0.0, 1.0), strength);
}

fn view_z_to_z_slice(
  view_z : f32,
  grid_z : u32,
  near   : f32,
  far    : f32,
  log_far_over_near : f32,
) -> u32 {
  if (view_z >= -near) {
    return 0u;
  }
  let slice = floor(log(-view_z / near) / log_far_over_near * f32(grid_z));
  let u_slice = u32(slice);
  if (u_slice >= grid_z) {
    return grid_z - 1u;
  }
  return u_slice;
}

fn ndc_position_to_cluster(
  ndc     : vec3<f32>,
  view_z  : f32,
  grid_x  : u32,
  grid_y  : u32,
  grid_z  : u32,
  near    : f32,
  far     : f32,
  log_far : f32,
) -> vec3<u32> {
  let cx = clamp(u32(floor((ndc.x * 0.5 + 0.5) * f32(grid_x))), 0u, grid_x - 1u);
  let cy = clamp(u32(floor((ndc.y * 0.5 + 0.5) * f32(grid_y))), 0u, grid_y - 1u);
  let cz = view_z_to_z_slice(view_z, grid_z, near, far, log_far);
  return vec3(cx, cy, cz);
}

// Decode one kind first, then delegate the complete evaluation to the shared
// punctual owner. Unknown kinds are explicitly zero contribution.
fn evaluate_cluster_light(
  light      : DirectLightSlot,
  world_pos  : vec3<f32>,
  normal     : vec3<f32>,
  view_dir   : vec3<f32>,
  base_color : vec3<f32>,
  metallic   : f32,
  alpha_sq   : f32,
  f0         : vec3<f32>,
  transmission : vec3<f32>,
  flat_2d    : bool,
  receive_shadows : bool,
  pixel: vec2<f32>,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let kind = light.metadata.x & KIND_MASK;
  if (kind == KIND_POINT) {
    let radiance = light.colorTimesIntensity.xyz * iesProfileFactor(
      light.position.xyz, light.auxiliary.xyz, light.direction.xyz, world_pos, light.metadata.z,
    );
    if (flat_2d) {
      return evalPointFlat(
        light.position.xyz, radiance, light.position.w, light.colorTimesIntensity.w,
        world_pos, base_color,
      );
    }
#ifdef POINT_SHADOW_AVAILABLE
    let layer = bitcast<i32>(light.metadata.y);
    if (receive_shadows && layer >= 0) {
      let shadow = shadowParams[layer];
      return evalPointShadowed(
        light.position.xyz, radiance, light.position.w, light.colorTimesIntensity.w,
        world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
        layer,
        shadow.x,
        shadow.y,
        shadow.z, shadow.w,
        shadowParams[4 + layer], shadowParams[12 + layer].xyz, pixel,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
      );
    }
#endif
    return evalPoint(
      light.position.xyz, radiance, light.position.w, light.colorTimesIntensity.w,
      world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
    );
  }
  if (kind == KIND_SPOT) {
    if (flat_2d) {
      return evalSpotFlat(
        light.position.xyz, light.direction.xyz, light.colorTimesIntensity.xyz,
        light.colorTimesIntensity.w, light.direction.w, light.position.w,
        world_pos, base_color,
      );
    }
    let modifierFactors = spotModifierFactors(
      light.position.xyz,
      light.direction.xyz,
      light.direction.w,
      world_pos,
      light.auxiliary.w,
      light.metadata,
    );
    let modifier = vec3<f32>(modifierFactors.x) * modifierFactors.yzw;
    let encoded_tile = bitcast<i32>(light.metadata.y);
    // The optional projector marker shares the non-negative shadow identity
    // lane. The direct-light packer keeps the lower tile bits intact.
    var projector_selected = false;
    var tile : i32 = encoded_tile;
    if (encoded_tile >= 0 && (encoded_tile & PROJECTOR_FLAG) != 0) {
      projector_selected = true;
      tile = encoded_tile & TILE_MASK;
    }
    // A non-receiver keeps the projector cookie; only the shadow tile is skipped.
    if (receive_shadows && tile >= 0 && tile < 4) {
      // Row 3 xyz carries the live depth bias, normal bias and shadow opacity.
      return evalSpotShadowed(
        light.position.xyz, light.direction.xyz, light.colorTimesIntensity.xyz,
        // DirectLightSlot packs cosInner in color.w and cosOuter in direction.w;
        // keep the evaluator's named cone order intact at the decode boundary.
        light.colorTimesIntensity.w, light.direction.w, light.position.w,
          world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
        view.spotLightViewProj[tile], tile, light.auxiliary.x, light.auxiliary.y,
#ifdef POINT_SHADOW_AVAILABLE
        shadowParams[8 + tile],
#else
        vec4<f32>(f32(max(light.metadata.x >> PCF_SHIFT, 1u)), 0.0, 6.0, 1.0),
#endif
        light.auxiliary.z, pixel,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
      ) * modifier
#ifdef PROJECTOR_AVAILABLE
        * select(
          vec3<f32>(1.0),
          sampleStandardSpotProjector(view.spotLightViewProj[tile], world_pos, light.metadata),
          projector_selected,
        )
#endif
      ;
    }
    return evalSpot(
      light.position.xyz, light.direction.xyz, light.colorTimesIntensity.xyz,
      light.colorTimesIntensity.w, light.direction.w, light.position.w,
      world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
    ) * modifier
#ifdef PROJECTOR_AVAILABLE
      * select(
        vec3<f32>(1.0),
        sampleStandardSpotProjector(view.spotLightViewProj[max(tile, 0)], world_pos, light.metadata),
        projector_selected && tile >= 0 && tile < 4,
      )
#endif
    ;
  }
  if (kind == KIND_RECT_AREA) {
    let radiance = light.colorTimesIntensity.xyz * iesProfileFactor(
      light.position.xyz, light.auxiliary.xyz, light.direction.xyz, world_pos, light.metadata.z,
    );
    return evalRectAreaLtcGgx(
      light.position.xyz,
      radiance,
      light.auxiliary.xyz,
      light.direction.xyz,
      light.colorTimesIntensity.w,
      light.direction.w,
      light.position.w,
      world_pos,
      normal,
      view_dir,
      base_color,
      metallic,
      alpha_sq,
      f0,
      transmission,
      light.metadata.w,
    );
  }
  return vec3<f32>(0.0);
}

fn evaluateStandardClusterLights(
  ndc        : vec3<f32>,
  pixel      : vec2<f32>,
  view_z     : f32,
  world_pos  : vec3<f32>,
  normal     : vec3<f32>,
  view_dir   : vec3<f32>,
  base_color : vec3<f32>,
  metallic   : f32,
  alpha_sq   : f32,
  f0         : vec3<f32>,
  transmission : vec3<f32>,
  flat_2d    : bool,
  receive_shadows : bool,
  receiver_channels : u32,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  if (cluster_uniform.grid.w == 0u) {
    return vec3<f32>(0.0);
  }
  let gx = cluster_uniform.grid.x;
  let gy = cluster_uniform.grid.y;
  let gz = cluster_uniform.grid.z;
  let near = cluster_uniform.near_far_log.x;
  let far = cluster_uniform.near_far_log.y;
  let log_far = cluster_uniform.near_far_log.z;
  var total_radiance = vec3<f32>(0.0);

  let cluster_idx = ndc_position_to_cluster(ndc, view_z, gx, gy, gz, near, far, log_far);
  let cluster_linear = cluster_idx.z * gy * gx + cluster_idx.y * gx + cluster_idx.x;
  let grid_offset = cluster_linear * 2u;
#ifdef STORAGE_BUFFER_AVAILABLE
  let list_offset = cluster_grid[grid_offset];
  let list_count = cluster_grid[grid_offset + 1u];
#else
  let list_offset = load_cluster_word(CLUSTER_TEXTURE_GRID_WORD_OFFSET + grid_offset);
  let list_count = load_cluster_word(CLUSTER_TEXTURE_GRID_WORD_OFFSET + grid_offset + 1u);
  let list_word_offset = CLUSTER_TEXTURE_GRID_WORD_OFFSET + gx * gy * gz * 2u;
#endif
  for (var i = 0u; i < list_count; i = i + 1u) {
#ifdef STORAGE_BUFFER_AVAILABLE
    let light = light_data[light_index_list[list_offset + i]];
#else
    let light = load_cluster_light(load_cluster_word(list_word_offset + list_offset + i));
#endif
    if (!lightingChannelsMatch(light.channels.x, receiver_channels)) { continue; }
    total_radiance += evaluate_cluster_light(
      light, world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0,
      transmission, flat_2d, receive_shadows,
      pixel,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
    );
  }
  return total_radiance;
}

#endif // CLUSTER_FORWARD_AVAILABLE
