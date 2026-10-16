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

fn edge_aware_resolved_volume(uv : vec2<f32>) -> vec4<f32> {
  let dimensions = max(vec2<f32>(textureDimensions(resolved_volume)), vec2<f32>(1.0));
  let texel = 1.0 / dimensions;
  let center = textureSampleLevel(resolved_volume, volume_sampler, uv, 0.0);
  let center_depth = linear_scene_depth(uv);
  var accumulated = center * 4.0;
  var total_weight = 4.0;
  let offsets = array<vec2<f32>, 8>(
    vec2<f32>(texel.x, 0.0),
    vec2<f32>(-texel.x, 0.0),
    vec2<f32>(0.0, texel.y),
    vec2<f32>(0.0, -texel.y),
    vec2<f32>(texel.x, texel.y),
    vec2<f32>(-texel.x, texel.y),
    vec2<f32>(texel.x, -texel.y),
    vec2<f32>(-texel.x, -texel.y),
  );
  let spatial_weights = array<f32, 8>(2.0, 2.0, 2.0, 2.0, 1.0, 1.0, 1.0, 1.0);
  for (var index = 0u; index < 8u; index += 1u) {
    let neighbor_uv = clamp(uv + offsets[index], vec2<f32>(0.0), vec2<f32>(1.0));
    let neighbor = textureSampleLevel(
      resolved_volume,
      volume_sampler,
      neighbor_uv,
      0.0,
    );
    let neighbor_depth = linear_scene_depth(neighbor_uv);
    // Relative view-depth rejection keeps the silhouette transition local;
    // a fixed world-unit threshold creates halos at far occluders.
    let depth_weight = select(0.0, exp(-abs(neighbor_depth - center_depth) * 0.08),
      abs(neighbor_depth - center_depth) <= max(center_depth * 0.08, 0.25));
    // Transmittance is the available edge signal: retain hard depth/occluder
    // boundaries while reconstructing smooth low-frequency scattering.
    let edge_weight = spatial_weights[index] * depth_weight * exp(-abs(neighbor.a - center.a) * 6.0) *
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
