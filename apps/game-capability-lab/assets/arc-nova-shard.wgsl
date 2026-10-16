#define_import_path boss_lightning_vfx::arc_nova_shard

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) emissive_intensity: vec4<f32>,
  @location(4) surface: vec4<f32>,
  @location(5) center: vec3<f32>,
};

struct VertexInput {
  @location(0) geometry_position: vec3<f32>,
  @location(1) geometry_normal: vec3<f32>,
  @location(2) geometry_uv: vec2<f32>,
  @location(3) geometry_tangent: vec4<f32>,
  @location(4) center: vec3<f32>,
  @location(5) right: vec3<f32>,
  @location(6) up: vec3<f32>,
  @location(7) forward: vec3<f32>,
  @location(8) particle_color: vec4<f32>,
  @location(9) base_color: vec4<f32>,
  @location(10) emissive_intensity: vec4<f32>,
  @location(11) surface: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let offset = input.right * input.geometry_position.x
    + input.up * input.geometry_position.y
    + input.forward * input.geometry_position.z;
  var output: VertexOutput;
  output.center = input.center;
  output.position = vec4<f32>(input.center + offset, 1.0);
  output.color = input.particle_color * input.base_color;
  output.normal = normalize(input.right * input.geometry_normal.x
    + input.up * input.geometry_normal.y
    + input.forward * input.geometry_normal.z);
  output.uv = input.geometry_uv;
  output.emissive_intensity = input.emissive_intensity;
  output.surface = input.surface;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let normal = normalize(input.normal);
  let view_direction = normalize(vec3<f32>(-input.center.xy, 1.0));
  let fresnel = pow(1.0 - abs(dot(normal, view_direction)), 3.0);
  let facet = 0.35 + 0.65 * pow(abs(dot(normal, normalize(vec3<f32>(0.37, 0.81, 0.44)))), 3.0);
  let bands = 0.55 + 0.45 * cos((input.uv.y * 9.0 + input.uv.x * 4.0) * 6.2831853);
  let prism = 0.58 + 0.42 * cos(vec3<f32>(0.0, 2.1, 4.2) + input.uv.y * 11.0 + normal * 2.0);
  let emissive = input.emissive_intensity.rgb * input.emissive_intensity.a
    * (vec3<f32>(0.22) + input.color.rgb * 0.78);
  let coat = clamp(input.surface.z, 0.0, 1.0);
  let rgb = input.color.rgb * (facet + bands * 0.22)
    + emissive * prism * (0.3 + fresnel * 0.9)
    + prism * coat * fresnel * 0.35;
  return vec4<f32>(rgb, input.color.a);
}
