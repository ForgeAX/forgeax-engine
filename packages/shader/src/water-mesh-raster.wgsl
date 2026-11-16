#define_import_path forgeax_material::water_mesh_raster
struct VertexInput {
  @location(0) position: vec4<f32>,
  @location(1) flow: vec2<f32>,
};
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) body: vec2<f32>,
  @location(1) bounds: vec2<f32>,
};
struct RasterOutput {
  @location(0) body: vec4<f32>,
  @location(1) bounds: vec4<f32>,
};
@vertex fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(input.position.xy, 0.0, 1.0);
  output.body = vec2<f32>(input.position.w, input.flow.x);
  output.bounds = vec2<f32>(input.position.z, input.flow.y);
  return output;
}
@fragment fn fs_main(input: VertexOutput) -> RasterOutput {
  return RasterOutput(vec4<f32>(input.body, 0.0, 1.0), vec4<f32>(input.bounds, 0.0, 1.0));
}
