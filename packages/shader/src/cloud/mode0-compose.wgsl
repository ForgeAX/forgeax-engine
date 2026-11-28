#define_import_path forgeax_cloud::mode0_compose
#import forgeax_view::common::{View, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray}
#import forgeax_cloud::reconstruct::{CloudReconstructionSample}
#import forgeax_cloud::compose::{cloud_bilateral_upsample, cloud_compose_transport, cloud_ue_upsample_choice}
#import forgeax_cloud::geometry::{CLOUD_UNTRACED_DEPTH_METERS, cloud_shell_interval}
#import forgeax_cloud::depth_minmax::{cloud_scene_depth_meters}
struct Mode0Params {
  previousViewProjection: mat4x4f,
  phaseSize: vec4f,
  historyExposure: vec4f,
  displayProbe: vec4f,
  layer: vec4f, // bottom, thickness, entry limit, trace limit (meters)
}
@group(1) @binding(0) var primaryTexture: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var<uniform> params: Mode0Params;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var secondaryTexture: texture_2d<f32>;
@group(1) @binding(6) var tertiaryTexture: texture_2d<f32>;
@group(1) @binding(7) var cloudDepthTexture: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) id: u32) -> FullscreenOutput { return fullscreen_triangle(id); }
fn compose_scene_distance(input: FullscreenOutput, pixel: vec2i) -> vec2f {
  let z = textureLoad(sceneDepth,pixel,0);
  var meters = CLOUD_UNTRACED_DEPTH_METERS;
  var canSeeCloud = true;
  if (z > 0.0) {
    let ray = atmosphere_view_ray(view,input.uv);
    meters = cloud_scene_depth_meters(z,input.uv,view.inverseViewProj,ray.origin);
    // Reconstructed near transport can contain neighboring sky radiance.
    // Test visibility against this pixel's opaque surface before sampling it.
    let radius = 6360000.0;
    let interval = cloud_shell_interval(ray.origin + vec3f(0.0,radius,0.0),ray.direction,
      radius,params.layer.x,params.layer.y,params.layer.z,params.layer.w,true,0.0,meters);
    canSeeCloud = interval.x >= 0.0;
  }
  return vec2f(meters, select(0.0, 1.0, canSeeCloud));
}

fn compose_history_coords(pixel: vec2i, maxCoord: vec2i) -> array<vec2i, 4> {
  let center = pixel / 2;
  let offset = select(vec2i(1), vec2i(-1), (pixel % vec2i(2)) == vec2i(0));
  return array<vec2i, 4>(
    clamp(center, vec2i(0), maxCoord),
    clamp(center + vec2i(offset.x, 0), vec2i(0), maxCoord),
    clamp(center + offset, vec2i(0), maxCoord),
    clamp(center + vec2i(0, offset.y), vec2i(0), maxCoord));
}

fn compose_legacy_transport(input: FullscreenOutput, pixel: vec2i) -> vec4f {
  let scene = compose_scene_distance(input, pixel);
  if scene.y == 0.0 { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let coords = compose_history_coords(pixel, vec2i(textureDimensions(secondaryTexture)) - 1);
  var samples: array<CloudReconstructionSample, 4>;
  for (var i = 0u; i < 4u; i += 1u) {
    let c = coords[i];
    samples[i] = CloudReconstructionSample(textureLoad(secondaryTexture, c, 0),
      textureLoad(tertiaryTexture, c, 0), textureLoad(cloudDepthTexture, c, 0));
  }
  return cloud_bilateral_upsample(samples, scene.x, vec4f(0.5625, 0.1875, 0.0625, 0.1875),
    params.historyExposure.w);
}

fn compose_ue_transport(input: FullscreenOutput, pixel: vec2i, far: texture_2d<f32>,
    near: texture_2d<f32>, depths: texture_2d<f32>) -> vec4f {
  let scene = compose_scene_distance(input, pixel);
  if scene.y == 0.0 { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let sceneKm = scene.x * 0.001;
  let dimensions = textureDimensions(far);
  let coords = compose_history_coords(pixel, vec2i(dimensions) - 1);
  var depthsKm: array<vec4f, 4>;
  for (var i = 0u; i < 4u; i += 1u) { depthsKm[i] = textureLoad(depths, coords[i], 0); }
  let choice = cloud_ue_upsample_choice(depthsKm, sceneKm, params.displayProbe.y);
  if choice == -2 { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if choice == -1 {
    // Offset by a quarter of a history texel on either side of its center.
    let center = vec2f(pixel / 2) + select(vec2f(0.75), vec2f(0.25),
      (pixel % vec2i(2)) == vec2i(0));
    return textureSampleLevel(far, colorSampler, center / vec2f(dimensions), 0.0);
  }
  let coord = coords[u32(choice) / 2u];
  if (choice & 1) != 0 { return textureLoad(near, coord, 0); }
  return textureLoad(far, coord, 0);
}

fn compose_debug_rgb(transport: vec4f) -> vec3f {
  if params.displayProbe.x == 3.0 { return vec3f(transport.a); }
  return vec3f(select(0.0, 1.0, 1.0 - transport.a > 0.05));
}

fn compose_scene_color(pixel: vec2i, transport: vec4f) -> vec4f {
  if params.displayProbe.x == 3.0 || params.displayProbe.x == 4.0 {
    return vec4f(compose_debug_rgb(transport), 1.0);
  }
  let background = textureLoad(primaryTexture, pixel, 0);
  return vec4f(cloud_compose_transport(background.rgb, transport), background.a);
}

@fragment fn fs_main(input: FullscreenOutput) -> @location(0) vec4f {
  let pixel = vec2i(input.position.xy);
  return compose_scene_color(pixel, compose_legacy_transport(input, pixel));
}

@fragment fn fs_ue_mode(input: FullscreenOutput) -> @location(0) vec4f {
  let pixel = vec2i(input.position.xy);
  return compose_scene_color(pixel, compose_ue_transport(input, pixel, secondaryTexture,
    tertiaryTexture, cloudDepthTexture));
}

@fragment fn fs_ue_blend(input: FullscreenOutput) -> @location(0) vec4f {
  let pixel = vec2i(input.position.xy);
  let transport = compose_ue_transport(input, pixel, primaryTexture, secondaryTexture,
    tertiaryTexture);
  if params.displayProbe.x == 3.0 || params.displayProbe.x == 4.0 {
    // Zero transmittance replaces background RGB but retains scene alpha.
    return vec4f(compose_debug_rgb(transport), 0.0);
  }
  // Each lane already contains its own atmosphere and height fog.
  return transport;
}
