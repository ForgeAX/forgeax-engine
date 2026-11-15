#define_import_path forgeax_view::volume_composite
// This is a view-UBO projection, not a second matrix source. The fields and
// padding preserve common::View camera/inverse-projection byte offsets.
struct VolumeDepthView {
  _prefix : array<vec4<f32>, 6>,
  cameraPos : vec4<f32>,
  _lightViewProjA : mat4x4<f32>,
  inverseViewProj : mat4x4<f32>,
};

struct VolumeOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@group(0) @binding(0) var resolved_volume : texture_2d<f32>;
@group(0) @binding(1) var volume_sampler : sampler;
@group(0) @binding(2) var scene_depth : texture_depth_2d;
@group(0) @binding(3) var<uniform> volume_view : VolumeDepthView;
// Low quality uses center + one symmetric axis, stratified per output pixel.
// Four axial neighbors remain supported; standalone/high retain all eight.
// The fixed spatial pattern has no temporal reconstruction or output history.
override VOLUME_COMPOSITE_NEIGHBORS : u32 = 8u;

@vertex
fn volume_vs(@builtin(vertex_index) index : u32) -> VolumeOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output : VolumeOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  output.uv = vec2<f32>(
    positions[index].x * 0.5 + 0.5,
    0.5 - positions[index].y * 0.5,
  );
  return output;
}

fn composite_resolved_volume(sample : vec4<f32>) -> vec4<f32> {
  let transmittance = clamp(sample.a, 0.0, 1.0);
  return vec4<f32>(sample.rgb, 1.0 - transmittance);
}

fn linear_scene_depth(uv : vec2<f32>) -> f32 {
  let dimensions = max(vec2<f32>(textureDimensions(scene_depth)), vec2<f32>(1.0));
  let pixel = vec2<i32>(clamp(uv * dimensions, vec2<f32>(0.0), dimensions - vec2<f32>(1.0)));
  let device_depth = textureLoad(scene_depth, pixel, 0);
  // WebGPU's framebuffer Y is opposite the view UBO's NDC Y.
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, device_depth, 1.0);
  let world = volume_view.inverseViewProj * clip;
  let world_position = world.xyz / max(abs(world.w), 1e-30);
  return distance(world_position, volume_view.cameraPos.xyz);
}

fn radiance_luma(sample : vec4<f32>) -> f32 {
  return max(dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.0);
}

fn radiance_luma_weight(center : vec4<f32>, neighbor : vec4<f32>) -> f32 {
  let center_luma = radiance_luma(center);
  let neighbor_luma = radiance_luma(neighbor);
  let relative_luma = abs(neighbor_luma - center_luma) /
    max(max(neighbor_luma, center_luma), 1e-4);
  return exp(-relative_luma * 8.0);
}

fn vacuum_volume_neighborhood(
  uv : vec2<f32>,
  center : vec4<f32>,
  offsets : array<vec2<f32>, 8>,
) -> bool {
  let vacuum = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  if (any(center != vacuum)) { return false; }
  // A vacuum center alone cannot reject an edge: the original reconstruction
  // also sees the eight filtered neighbors, including clamped border samples.
  for (var index = 0u; index < clamp(VOLUME_COMPOSITE_NEIGHBORS, 2u, 8u); index += 1u) {
    let neighbor_uv = clamp(uv + offsets[index], vec2<f32>(0.0), vec2<f32>(1.0));
    let neighbor = textureSampleLevel(resolved_volume, volume_sampler, neighbor_uv, 0.0);
    if (any(neighbor != vacuum)) { return false; }
  }
  return true;
}

// Relative view-depth rejection keeps the silhouette transition local;
// a fixed world-unit threshold creates halos at far occluders. One threshold
// serves both the neighbour weights and the footprint edge decision.
fn surface_depth_threshold(center_depth : f32) -> f32 {
  return max(center_depth * 0.08, 0.25);
}

fn surface_depth_weight(neighbor_depth : f32, center_depth : f32) -> f32 {
  let delta = abs(neighbor_depth - center_depth);
  return select(0.0, exp(-delta * 0.08), delta <= surface_depth_threshold(center_depth));
}

// An infinite far plane reconstructs sky as an infinite (or NaN) distance.
// The edge decision compares depths capped at a finite ceiling, so sky vs sky
// is one surface (delta 0) and sky vs geometry is an edge. `select` maps NaN to
// the ceiling without relying on NaN ordering in min/max. Finite depths below
// the ceiling are unchanged.
const SURFACE_DEPTH_CEILING : f32 = 1e30;

fn surface_edge_depth(depth : f32) -> f32 {
  return select(SURFACE_DEPTH_CEILING, depth, depth < SURFACE_DEPTH_CEILING);
}

// Another surface only when the relative threshold says so. A zero weight is
// not that signal: exp underflows on one far continuous surface.
fn surface_depth_rejected(neighbor_depth : f32, center_depth : f32) -> bool {
  let center = surface_edge_depth(center_depth);
  return abs(surface_edge_depth(neighbor_depth) - center) > surface_depth_threshold(center);
}

struct ResolvedFootprint {
  value : vec4<f32>,
  crosses_surface : bool,
};

// Each resolved texel was integrated to the scene depth of the one pixel that
// contains its centre (volume-integrate.wgsl). When the hardware-bilinear
// footprint of this pixel holds a texel integrated to another surface, the
// filtered value would place the fog edge on the texel grid. Reweight the same
// 2x2 texels by surface similarity instead (joint-bilateral upsample), falling
// back to the texel whose integration depth is nearest this pixel's depth.
fn reconstruct_resolved_footprint(
  uv : vec2<f32>,
  center_depth : f32,
) -> ResolvedFootprint {
  let dimensions = max(vec2<i32>(textureDimensions(resolved_volume)), vec2<i32>(1));
  let position = uv * vec2<f32>(dimensions) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(position));
  let fraction = position - floor(position);
  let corners = array<vec2<i32>, 4>(
    vec2<i32>(0, 0),
    vec2<i32>(1, 0),
    vec2<i32>(0, 1),
    vec2<i32>(1, 1),
  );
  let bilinear = array<f32, 4>(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y,
  );
  var weights : array<f32, 4>;
  var crosses_surface = false;
  var nearest = 0u;
  var nearest_gap = SURFACE_DEPTH_CEILING;
  for (var index = 0u; index < 4u; index += 1u) {
    let texel = clamp(base + corners[index], vec2<i32>(0), dimensions - vec2<i32>(1));
    // The same texel-centre pixel the integrator clipped this texel's ray at.
    let texel_depth = linear_scene_depth((vec2<f32>(texel) + vec2<f32>(0.5)) /
      vec2<f32>(dimensions));
    let rejected = surface_depth_rejected(texel_depth, center_depth);
    // Below the 8-bit filtering fraction a texel does not contribute.
    crosses_surface = crosses_surface || (bilinear[index] > 1.0 / 256.0 && rejected);
    // Same-surface texels keep a positive similarity even where exp underflows.
    weights[index] = select(
      bilinear[index] * max(surface_depth_weight(texel_depth, center_depth), 1e-4),
      0.0,
      rejected,
    );
    let gap = abs(surface_edge_depth(texel_depth) - surface_edge_depth(center_depth));
    if (gap < nearest_gap) {
      nearest = index;
      nearest_gap = gap;
    }
  }
  var output : ResolvedFootprint;
  output.crosses_surface = crosses_surface;
  output.value = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  if (!crosses_surface) { return output; }
  var accumulated = vec4<f32>(0.0);
  var total_weight = 0.0;
  for (var index = 0u; index < 4u; index += 1u) {
    if (weights[index] > 0.0) {
      let texel = clamp(base + corners[index], vec2<i32>(0), dimensions - vec2<i32>(1));
      accumulated += textureLoad(resolved_volume, texel, 0) * weights[index];
      total_weight += weights[index];
    }
  }
  // Nearest-depth texel only when every contributing texel is another surface.
  if (total_weight > 0.0) {
    output.value = accumulated / total_weight;
  } else {
    let texel = clamp(base + corners[nearest], vec2<i32>(0), dimensions - vec2<i32>(1));
    output.value = textureLoad(resolved_volume, texel, 0);
  }
  return output;
}

fn edge_aware_resolved_volume(uv : vec2<f32>) -> vec4<f32> {
  let dimensions = max(vec2<f32>(textureDimensions(resolved_volume)), vec2<f32>(1.0));
  let texel = 1.0 / dimensions;
  let center = textureSampleLevel(resolved_volume, volume_sampler, uv, 0.0);
  var offsets = array<vec2<f32>, 8>(
    vec2<f32>(texel.x, 0.0),
    vec2<f32>(-texel.x, 0.0),
    vec2<f32>(0.0, texel.y),
    vec2<f32>(0.0, -texel.y),
    vec2<f32>(texel.x, texel.y),
    vec2<f32>(-texel.x, texel.y),
    vec2<f32>(texel.x, -texel.y),
    vec2<f32>(-texel.x, -texel.y),
  );
  let neighbor_count = clamp(VOLUME_COMPOSITE_NEIGHBORS, 2u, 8u);
  if (neighbor_count == 2u) {
    let pixel = vec2<u32>(uv * vec2<f32>(textureDimensions(scene_depth)));
    let hash = (pixel.x * 1597334677u) ^ (pixel.y * 3812015801u);
    if (((hash ^ (hash >> 16u)) & 1u) != 0u) {
      offsets[0] = vec2<f32>(0.0, texel.y);
      offsets[1] = vec2<f32>(0.0, -texel.y);
    }
  }
  // Every original weight combines the same optical identity here, so the
  // optical result is vacuum regardless of depth or edge weights. Keep the
  // selected profile's reconstruction for every non-vacuum neighbor.
  if (vacuum_volume_neighborhood(uv, center, offsets)) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }
  let center_depth = linear_scene_depth(uv);
  // Pixels whose footprint stays on one surface keep the filtered
  // reconstruction below unchanged; only depth-edge footprints are rebuilt.
  let footprint = reconstruct_resolved_footprint(uv, center_depth);
  if (footprint.crosses_surface) { return footprint.value; }
  var accumulated = center * 4.0;
  var total_weight = 4.0;
  let spatial_weights = array<f32, 8>(2.0, 2.0, 2.0, 2.0, 1.0, 1.0, 1.0, 1.0);
  for (var index = 0u; index < clamp(VOLUME_COMPOSITE_NEIGHBORS, 2u, 8u); index += 1u) {
    let neighbor_uv = clamp(uv + offsets[index], vec2<f32>(0.0), vec2<f32>(1.0));
    let neighbor = textureSampleLevel(
      resolved_volume,
      volume_sampler,
      neighbor_uv,
      0.0,
    );
    let neighbor_depth = linear_scene_depth(neighbor_uv);
    let depth_weight = surface_depth_weight(neighbor_depth, center_depth);
    // Transmittance is the available edge signal: retain hard depth/occluder
    // boundaries while reconstructing smooth low-frequency scattering.
    let spatial_weight = select(spatial_weights[index], 4.0, neighbor_count == 2u);
    let edge_weight = spatial_weight * depth_weight * exp(-abs(neighbor.a - center.a) * 6.0) *
      radiance_luma_weight(center, neighbor);
    accumulated += neighbor * edge_weight;
    total_weight += edge_weight;
  }
  return accumulated / max(total_weight, 1e-5);
}

@fragment
fn volume_fs(input : VolumeOutput) -> @location(0) vec4<f32> {
  // Injection zeroes samples behind the observed scene depth. Sampling the
  // cumulative far slice therefore applies the full ray integral while the
  // depth test remains owned by the injection path.
  let sample = edge_aware_resolved_volume(input.uv);
  return composite_resolved_volume(sample);
}
