#define_import_path forgeax_material::water_info_raster_ground
struct VertexInput {
  @location(0) position: vec4<f32>,
  @location(1) flow: vec2<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) captureDepth: f32,
  @location(1) flow: vec2<f32>,
};
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position.xyz, 1.0);
  output.captureDepth = input.position.w;
  output.flow = input.flow;
  return output;
}
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.captureDepth, 0.0, 0.0, 0.0);
}
