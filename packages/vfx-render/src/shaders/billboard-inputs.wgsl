#define_import_path forgeax::vfx-render.particles.billboard-inputs
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#import forgeax_view::common::{View, view}
#import forgeax_view::fog::{translucent_fog, ndc_world}
@group(0) @binding(1) var scene_depth: texture_depth_2d;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
  @location(2) emissive_intensity: vec4<f32>,
  @location(3) surface: vec4<f32>,
  @location(4) sheet_uv: vec2<f32>,
  @location(5) sheet_frame: f32,
  @location(6) fade_distance: f32,
  @location(7) clip_position: vec3<f32>,
};

fn textureSheetUv(local: vec2<f32>, frame: u32, columns: u32, rows: u32) -> vec2<f32> {
  let safeColumns = max(columns, 1u);
  let safeRows = max(rows, 1u);
  let cell = vec2<u32>(frame % safeColumns, frame / safeColumns);
  return (local + vec2<f32>(1.0)) * 0.5 / vec2<f32>(f32(safeColumns), f32(safeRows)) +
    vec2<f32>(f32(cell.x) / f32(safeColumns), f32(cell.y) / f32(safeRows));
}

fn softParticle(position: vec4<f32>, alpha: f32, fadeDistance: f32) -> f32 {
  let pixel = vec2<i32>(position.xy);
  let sceneDepth = textureLoad(scene_depth, pixel, 0);
  if (sceneDepth <= 0.0) { return alpha; }
  if (fadeDistance <= 0.0) { return select(alpha, 0.0, position.z < sceneDepth); }
  return alpha * clamp((position.z - sceneDepth) / fadeDistance, 0.0, 1.0);
}

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) right: vec2<f32>,
  @location(2) up: vec2<f32>,
  @location(3) particle_color: vec4<f32>,
  @location(4) base_color: vec4<f32>,
  @location(5) emissive_intensity: vec4<f32>,
  @location(6) surface: vec4<f32>,
  @location(7) advanced: vec4<f32>,
  @location(8) texture_sheet: vec4<f32>,
  @location(9) particle_inputs: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let corner = corners[vertex_index] + input.advanced.xy * 2.0;
  var output: VertexOutput;
  let clipPosition = vec3<f32>(
    input.position.xy + input.right * corner.x + input.up * corner.y,
    input.position.z,
  );
  output.position = vec4<f32>(clipPosition, 1.0);
  output.clip_position = clipPosition;
  let heat = clamp(input.particle_inputs.x, 0.0, 1.0);
  output.color = input.particle_color * input.base_color * (0.35 + 0.65 * heat);
  output.local = corner;
  output.emissive_intensity = input.emissive_intensity;
  output.surface = input.surface;
  output.sheet_uv = textureSheetUv(
    corners[vertex_index], u32(input.advanced.z),
    u32(input.texture_sheet.x), u32(input.texture_sheet.y),
  );
  output.sheet_frame = input.advanced.z;
  output.fade_distance = input.texture_sheet.z;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let radius = length(input.local);
  let edge = 1.0 - smoothstep(0.45, 1.0, radius);
  let core = 1.0 - smoothstep(0.0, 0.42, radius);
  let roughness = clamp(input.surface.y, 0.04, 1.0);
  let clearcoat = clamp(input.surface.z, 0.0, 1.0);
  let highlight = core * clearcoat * (1.0 - roughness * 0.65);
  let emissive = input.emissive_intensity.rgb * input.emissive_intensity.a;
  let alpha = softParticle(input.position, input.color.a * edge, input.fade_distance);
  let rgb = input.color.rgb + emissive * (0.35 + core * 0.65) + vec3<f32>(highlight);
  let fogged = translucent_fog(view, ndc_world(view, input.clip_position), rgb * alpha, alpha);
  return vec4<f32>(fogged, alpha);
}
