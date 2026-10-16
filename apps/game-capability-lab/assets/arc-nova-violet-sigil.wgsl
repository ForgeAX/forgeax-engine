#define_import_path boss_lightning_vfx::arc_nova_violet_sigil

@group(0) @binding(0) var scene_depth: texture_depth_2d;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
  @location(2) emissive_intensity: vec4<f32>,
  @location(3) surface: vec4<f32>,
};

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) right: vec2<f32>,
  @location(2) up: vec2<f32>,
  @location(3) particle_color: vec4<f32>,
  @location(4) base_color: vec4<f32>,
  @location(5) emissive_intensity: vec4<f32>,
  @location(6) surface: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let corner = corners[vertex_index];
  var output: VertexOutput;
  output.position = vec4<f32>(
    input.position.xy + input.right * corner.x + input.up * corner.y,
    input.position.z,
    1.0,
  );
  output.color = input.particle_color * input.base_color;
  output.local = corner;
  output.emissive_intensity = input.emissive_intensity;
  output.surface = input.surface;
  return output;
}

fn hex_radius(p: vec2<f32>) -> f32 {
  let q = abs(p);
  return max(q.x * 0.8660254 + q.y * 0.5, q.y);
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let radius = length(input.local);
  let hex = hex_radius(input.local);
  let angle = atan2(input.local.y, input.local.x);
  let outer_hex = smoothstep(1.02, 0.9, hex) * smoothstep(0.72, 0.82, hex);
  let inner_hex = smoothstep(0.57, 0.48, hex) * smoothstep(0.29, 0.38, hex);
  let six_spokes = pow(abs(cos(angle * 3.0)), 18.0) * smoothstep(0.72, 0.24, radius);
  let triangular_runes = pow(max(cos(angle * 3.0 + radius * 15.0), 0.0), 10.0)
    * smoothstep(0.82, 0.5, radius) * smoothstep(0.2, 0.42, radius);
  let core = smoothstep(0.22, 0.03, radius);
  let mask = clamp(outer_hex + inner_hex + six_spokes * 0.65 + triangular_runes * 0.75 + core, 0.0, 1.0);
  if (mask < 0.025 || hex > 1.03) {
    discard;
  }
  let emissive = input.emissive_intensity.rgb * input.emissive_intensity.a;
  let prism = 0.55 + 0.45 * cos(vec3<f32>(0.0, 2.1, 4.2) + angle * 2.0 + radius * 12.0);
  let rgb = input.color.rgb * (0.55 + mask * 0.9) + emissive * prism * (0.35 + mask);
  let alpha = input.color.a * mask;
  return vec4<f32>(rgb * alpha, alpha);
}
