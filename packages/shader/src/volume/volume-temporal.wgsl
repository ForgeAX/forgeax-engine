#define_import_path forgeax_view::volume_temporal

struct VolumeTemporalView {
  _prefix : array<vec4<f32>, 6>, cameraPos : vec4<f32>, _lightViewProjA : mat4x4<f32>, inverseViewProj : mat4x4<f32>,
  _middle : array<vec4<f32>, 34>, temporalCurrentViewProj : mat4x4<f32>, temporalPreviousViewProj : mat4x4<f32>,
  temporalProjection : vec4<f32>, temporalPreviousCameraPos : vec4<f32>,
};
struct VolumeParams {
  bounds_min : vec4<f32>, bounds_max : vec4<f32>, extinction : vec4<f32>, albedo : vec4<f32>,
  emission : vec4<f32>, light_direction : vec4<f32>, light_color : vec4<f32>, optics : vec4<f32>,
  simulation : vec4<f32>,
};

@group(0) @binding(0) var current : texture_2d<f32>;
@group(0) @binding(1) var accepted : texture_2d<f32>;
@group(0) @binding(2) var pending : texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var<uniform> volume_params : VolumeParams;
@group(0) @binding(4) var<uniform> volume_view : VolumeTemporalView;

fn bilinear(uv : vec2<f32>, size : vec2<u32>) -> vec4<f32> {
  let p = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(p));
  let f = fract(p);
  let max_coord = vec2<i32>(size) - vec2<i32>(1);
  let c00 = textureLoad(accepted, clamp(base, vec2<i32>(0), max_coord), 0);
  let c10 = textureLoad(accepted, clamp(base + vec2<i32>(1, 0), vec2<i32>(0), max_coord), 0);
  let c01 = textureLoad(accepted, clamp(base + vec2<i32>(0, 1), vec2<i32>(0), max_coord), 0);
  let c11 = textureLoad(accepted, clamp(base + vec2<i32>(1), vec2<i32>(0), max_coord), 0);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn reproject_uv(uv : vec2<f32>) -> vec2<f32> {
  let current_ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let world_h = volume_view.inverseViewProj * current_ndc;
  let world = world_h.xyz / max(abs(world_h.w), 1e-30);
  let previous_clip = volume_view.temporalPreviousViewProj * vec4<f32>(world, 1.0);
  if (previous_clip.w <= 1e-5) {
    return vec2<f32>(-1.0);
  }
  let previous_ndc = previous_clip.xyz / previous_clip.w;
  return vec2<f32>(previous_ndc.x * 0.5 + 0.5, 1.0 - (previous_ndc.y * 0.5 + 0.5));
}

@compute @workgroup_size(8, 8, 1)
fn volume_temporal(@builtin(global_invocation_id) id : vec3<u32>) {
  let size = textureDimensions(current);
  if (any(id.xy >= size)) { return; }
  let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(size);
  let center = textureLoad(current, vec2<i32>(id.xy), 0);
  var lower = center;
  var upper = center;
  for (var oy = -1i; oy <= 1i; oy = oy + 1i) {
    for (var ox = -1i; ox <= 1i; ox = ox + 1i) {
      let coord = clamp(vec2<i32>(id.xy) + vec2<i32>(ox, oy), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
      let neighbor = textureLoad(current, coord, 0);
      lower = min(lower, neighbor);
      upper = max(upper, neighbor);
    }
  }
  var output = center;
  let historyValid = volume_params.optics.w >= 0.5 && volume_view.temporalPreviousCameraPos.w >= 0.5;
  if (historyValid) {
    let previous_uv = reproject_uv(uv);
    if (all(previous_uv >= vec2<f32>(0.0)) && all(previous_uv <= vec2<f32>(1.0))) {
      let prior = bilinear(previous_uv, size);
      let clamped = clamp(prior, lower, upper);
      // Bound history age in seconds at low frame rates; retain spatial clipping
      // for the moving multi-scale density field (which has no single velocity).
      let history_weight = pow(0.875, max(1.0, volume_params.simulation.y * 60.0));
      output = mix(center, clamped, history_weight);
    }
  }
  textureStore(pending, id.xy, output);
}
