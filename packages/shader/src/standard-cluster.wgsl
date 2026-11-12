// standard-cluster.wgsl — Standard clustered punctual light evaluation.
// feat-20260608-cluster-lighting M4 / w17.
//
// The cluster module owns membership and raw payload decoding only. Punctual
// BRDF, range, cone, PCF, and fail-open behavior live in lighting-punctual.
// ProbeBlendRecord is intentionally absent: probes are not DirectLightSlot
// members and this cluster owner never performs an all-probe loop.

#define_import_path forgeax_standard::cluster
#import forgeax_view::common::{DirectLightSlot, lightingChannelsMatch, view}
#import forgeax_pbr::brdf::{prepareDirectMultiScatterView, DirectMultiScatterView, directLightingAlpha}

#import forgeax_pbr::lighting_punctual::{evalDirectionalSlot, evalPoint, evalPointFlat, evalSpot, evalSpotFlat, evalSpotShadowed, punctualRangeReaches, spotConeReaches}
#import forgeax_pbr::lighting_spot_modifiers::{spotModifierFactors}
#import forgeax_pbr::lighting_ies_profile::{iesProfileFactor}
#import forgeax_pbr::lighting_rect_area::{evalRectAreaLtcGgx}
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
const KIND_DIRECTIONAL: u32 = 3u;
const KIND_MASK: u32 = 0xffu;
const PCF_SHIFT: u32 = 8u;
const PROJECTOR_FLAG: i32 = 0x40000000;
const TILE_MASK: i32 = 0x3fffffff;

struct ClusterUniform {
  grid         : vec4<u32>,
  near_far_log : vec4<f32>,
  // Optional no-storage AO region: base word, logical width/height, row stride.
  ao           : vec4<u32>,
  // Independently controlled AO attenuation for direct Forward lighting.
  direct_ao    : vec4<f32>,
  // No-storage Cluster texture addressing: slot texels, grid word offset,
  // index-list word offset, and physical texture width.
  texture      : vec4<u32>,
  // Producer-owned Cluster grid offset/count pair stride in u32 words.
  cluster_layout : vec4<u32>,
};

#ifdef STORAGE_BUFFER_AVAILABLE
@group(2) @binding(3) var<storage, read> light_data      : array<DirectLightSlot, 256>;
@group(2) @binding(4) var<storage, read> cluster_grid     : array<u32>;
@group(2) @binding(5) var<storage, read> light_index_list : array<u32>;
#else
// The CPU membership producer packs the same bytes into one rgba32uint texture:
// 256 light records, then grid offset/count pairs, then the complete index list.
#import forgeax_standard::cluster_texture_data::{cluster_data_texture, load_cluster_texel}

fn load_cluster_word(word: u32) -> u32 {
  return load_cluster_texel(word >> 2u)[word & 3u];
}

fn load_cluster_light(index: u32) -> DirectLightSlot {
  let first = index * cluster_uniform.texture.x;
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

fn get_ssao_direct_lighting_strength() -> f32 {
  return cluster_uniform.direct_ao.x;
}

// Native storage lighting reuses its existing AO sampled texture. The
// no-storage lane reads the identical half-float tiles from Cluster words.
fn standardScreenCoordinate(worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>, layer: u32) -> vec2<u32> {
  let size = vec2<u32>(cluster_uniform.direct_ao.zw);
  let clip = worldViewProjection * vec4<f32>(worldPosition, 1.0);
  let uv = clip.xy / clip.w * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  let pixel = vec2<u32>(clamp(uv * vec2<f32>(size), vec2<f32>(0.0), vec2<f32>(size - 1u)));
  return pixel + vec2<u32>(layer % 2u, layer / 2u) * size;
}
#ifdef STORAGE_BUFFER_AVAILABLE
fn sampleStandardScreenData(worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>, layer: u32, data: texture_2d<f32>) -> vec4<f32> {
  if (cluster_uniform.direct_ao.y <= 0.0) { return vec4<f32>(0.0); }
  return textureLoad(data, vec2<i32>(standardScreenCoordinate(worldPosition, worldViewProjection, layer)), 0);
}
fn sampleStandardContactShadow(worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>, data: texture_2d<f32>) -> f32 {
  if (cluster_uniform.direct_ao.y <= 0.0) { return 1.0; }
  return sampleStandardScreenData(worldPosition, worldViewProjection, 0u, data).g;
}
#else
fn sampleStandardScreenData(worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>, layer: u32) -> vec4<f32> {
  if (cluster_uniform.direct_ao.y <= 0.0) { return vec4<f32>(0.0); }
  let pixel = standardScreenCoordinate(worldPosition, worldViewProjection, layer);
  let width = u32(cluster_uniform.direct_ao.z) * 2u;
  let word = cluster_uniform.cluster_layout.z + (pixel.y * width + pixel.x) * 2u;
  return vec4<f32>(unpack2x16float(load_cluster_word(word)), unpack2x16float(load_cluster_word(word + 1u)));
}
fn sampleStandardContactShadow(worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>) -> f32 {
  if (cluster_uniform.direct_ao.y <= 0.0) { return 1.0; }
  return sampleStandardScreenData(worldPosition, worldViewProjection, 0u).g;
}
#endif

// DBuffer channels are premultiplied by their independent coverage. Preserve
// receiver metallic, emission, opacity and occlusion before the ordinary BRDF.
struct StandardDecalSurface { baseColor: vec3<f32>, normalWS: vec3<f32>, roughness: f32 }
fn applyStandardScreenDecals(baseColor: vec3<f32>, normalWS: vec3<f32>, baseRoughness: f32, color: vec4<f32>, normal: vec4<f32>, roughness: vec4<f32>) -> StandardDecalSurface {
  var finalNormal = normalWS;
  let normalSum = normal.xyz + normalWS * (1.0 - normal.a);
  if (dot(normalSum, normalSum) > 0.000001) { finalNormal = normalize(normalSum); }
  return StandardDecalSurface(color.rgb + baseColor * (1.0 - color.a), finalNormal, roughness.r + baseRoughness * (1.0 - roughness.a));
}

// Shared by static, skinned, and custom Standard surface programs.
// The AO producer already applied the intensity exponent before filtering;
// a non-zero intensity here only marks the texture as live.
#ifdef STORAGE_BUFFER_AVAILABLE
fn sampleStandardAmbientOcclusion(
  worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>,
  aoTexture: texture_2d<f32>, aoSampler: sampler,
) -> f32 {
  if (get_ssao_intensity() <= 0.0) { return 1.0; }
  if (cluster_uniform.direct_ao.y > 0.0) {
    return sampleStandardScreenData(worldPosition, worldViewProjection, 0u, aoTexture).r;
  }
  let clip = worldViewProjection * vec4<f32>(worldPosition, 1.0);
  let uv = clip.xy / clip.w * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  return clamp(textureSampleLevel(aoTexture, aoSampler, uv, 0.0).r, 0.0, 1.0);
}
#else
fn sampleStandardAmbientOcclusion(
  worldPosition: vec3<f32>, worldViewProjection: mat4x4<f32>,
) -> f32 {
  let width = cluster_uniform.ao.y;
  let height = cluster_uniform.ao.z;
  if (get_ssao_intensity() <= 0.0 || width == 0u || height == 0u) { return 1.0; }
  let clip = worldViewProjection * vec4<f32>(worldPosition, 1.0);
  let uv = clip.xy / max(abs(clip.w), 1e-6) * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  let coordinate = clamp(
    uv * vec2<f32>(f32(width), f32(height)) - vec2<f32>(0.5),
    vec2<f32>(0.0),
    vec2<f32>(f32(width - 1u), f32(height - 1u)),
  );
  let low = vec2<u32>(floor(coordinate));
  let high = min(low + vec2<u32>(1u), vec2<u32>(width - 1u, height - 1u));
  let weight = fract(coordinate);
  let rowWords = cluster_uniform.ao.w;
  let base = cluster_uniform.ao.x;
  let a = f32(load_cluster_word(base + low.y * rowWords + low.x)) / 4294967295.0;
  let b = f32(load_cluster_word(base + low.y * rowWords + high.x)) / 4294967295.0;
  let c = f32(load_cluster_word(base + high.y * rowWords + low.x)) / 4294967295.0;
  let d = f32(load_cluster_word(base + high.y * rowWords + high.x)) / 4294967295.0;
  return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
}
#endif

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
  ms: DirectMultiScatterView,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let kind = light.metadata.x & KIND_MASK;
  // Exact-zero gates: skip lights whose range (or cone) cannot reach this
  // fragment before IES, modifiers, BRDF or shadow taps run.
  if ((kind == KIND_POINT || kind == KIND_SPOT)
      && !punctualRangeReaches(light.position.xyz, world_pos, light.position.w)) {
    return vec3<f32>(0.0);
  }
  if (kind == KIND_POINT) {
#ifdef LEAN_LIGHTING
    // LEAN_LIGHTING frames carry no IES slice: the factor is the identity.
    let radiance = light.colorTimesIntensity.xyz;
#else
    let radiance = light.colorTimesIntensity.xyz * iesProfileFactor(
      light.position.xyz, light.auxiliary.xyz, light.direction.xyz, world_pos, light.metadata.z,
    );
    if (flat_2d) {
      return evalPointFlat(
        light.position.xyz, radiance, light.position.w, light.colorTimesIntensity.w,
        world_pos, base_color,
      );
    }
#endif
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
    ms, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
      );
    }
#endif
    return evalPoint(
      light.position.xyz, radiance, light.position.w, light.colorTimesIntensity.w,
      world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
    ms, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
    );
  }
  if (kind == KIND_SPOT) {
#ifndef LEAN_LIGHTING
    if (flat_2d) {
      return evalSpotFlat(
        light.position.xyz, light.direction.xyz, light.colorTimesIntensity.xyz,
        light.colorTimesIntensity.w, light.direction.w, light.position.w,
        world_pos, base_color,
      );
    }
#endif
    if (!spotConeReaches(
      light.position.xyz, light.direction.xyz,
      light.colorTimesIntensity.w, light.direction.w, world_pos,
    )) {
      return vec3<f32>(0.0);
    }
#ifdef LEAN_LIGHTING
    // LEAN_LIGHTING frames carry no IES, Cookie or projector spot: every
    // modifier is the identity and the shadow lane is a plain tile or -1.
    let tile = bitcast<i32>(light.metadata.y);
    if (receive_shadows && tile >= 0 && tile < 4) {
      return evalSpotShadowed(
        light.position.xyz, light.direction.xyz, light.colorTimesIntensity.xyz,
        light.colorTimesIntensity.w, light.direction.w, light.position.w,
        world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
        view.spotLightViewProj[tile], tile, light.auxiliary.x, light.auxiliary.y,
#ifdef POINT_SHADOW_AVAILABLE
        shadowParams[8 + tile],
#else
        vec4<f32>(f32(max(light.metadata.x >> PCF_SHIFT, 1u)), 0.0, 6.0, 1.0),
#endif
        light.auxiliary.z, pixel,
    ms, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
      );
    }
    return evalSpot(
      light.position.xyz, light.direction.xyz, light.colorTimesIntensity.xyz,
      light.colorTimesIntensity.w, light.direction.w, light.position.w,
      world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
    ms, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
    );
#else
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
    var lit : vec3<f32>;
    // A non-receiver keeps the projector cookie; only the shadow tile is skipped.
    if (receive_shadows && tile >= 0 && tile < 4) {
      // Row 3 xyz carries the live depth bias, normal bias and shadow opacity.
      lit = evalSpotShadowed(
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
    ms, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
      ) * modifier;
    } else {
      lit = evalSpot(
        light.position.xyz, light.direction.xyz, light.colorTimesIntensity.xyz,
        light.colorTimesIntensity.w, light.direction.w, light.position.w,
        world_pos, normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
    ms, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
      ) * modifier;
    }
#ifdef PROJECTOR_AVAILABLE
    // Only a marked spot samples the projector (a real branch, not a select
    // that evaluates the projection for every spot). The unshadowed path
    // keeps the same tile bound it always applied.
    if (projector_selected && tile >= 0 && tile < 4 && any(lit != vec3<f32>(0.0))) {
      lit = lit * sampleStandardSpotProjector(view.spotLightViewProj[tile], world_pos, light.metadata);
    }
#endif
    return lit;
#endif
  }
#ifndef LEAN_LIGHTING
  // LEAN_LIGHTING frames carry neither rect-area nor additional directional
  // slots; their decode is absent from that variant.
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
  if (kind == KIND_DIRECTIONAL) {
    if (flat_2d) {
      return base_color * light.colorTimesIntensity.xyz;
    }
    return evalDirectionalSlot(
      light.direction.xyz, light.colorTimesIntensity.xyz,
      normal, view_dir, base_color, metallic, alpha_sq, f0, transmission,
    ms, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
    );
  }
#endif
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

  // Look the cell up from the fragment's own screen position. A per-vertex
  // NDC varying is interpolated perspective-correctly, which is not the
  // screen-linear NDC of the fragment, so large or near triangles would read a
  // neighbouring cell; the membership producer culls each cell to its froxel
  // and that neighbour need not hold the lights reaching this fragment.
  // `pixel` is @builtin(position).xy in the View's viewport (the View UBO
  // carries the colour target extent), so its screen-linear NDC equals the
  // fragment's projected position without a per-pixel worldViewProj product.
  let fragment_ndc = vec3<f32>(
    pixel / vec2<f32>(view.viewportWidth, view.viewportHeight) * vec2<f32>(2.0, -2.0)
      + vec2<f32>(-1.0, 1.0),
    ndc.z,
  );
  let cluster_idx = ndc_position_to_cluster(fragment_ndc, view_z, gx, gy, gz, near, far, log_far);
  let cluster_linear = cluster_idx.z * gy * gx + cluster_idx.y * gx + cluster_idx.x;
  let grid_offset = cluster_linear * cluster_uniform.cluster_layout.x;
#ifdef STORAGE_BUFFER_AVAILABLE
  let list_offset = cluster_grid[grid_offset];
  let list_count = cluster_grid[grid_offset + cluster_uniform.cluster_layout.y];
#else
  let list_offset = load_cluster_word(cluster_uniform.texture.y + grid_offset);
  let list_count = load_cluster_word(
    cluster_uniform.texture.y + grid_offset + cluster_uniform.cluster_layout.y,
  );
  let list_word_offset = cluster_uniform.texture.z;
#endif
  if (list_count == 0u) {
    return total_radiance;
  }
  // Per-pixel view terms of the direct multi-scatter lobe (nDotV, the view
  // DFG sample, E_avg/F_avg), hoisted out of the light loop.
  let ms = prepareDirectMultiScatterView(directLightingAlpha(alpha_sq), max(dot(normal, view_dir), 1e-5), f0,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
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
      pixel, ms,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
    );
  }
  return total_radiance;
}

#endif // CLUSTER_FORWARD_AVAILABLE
