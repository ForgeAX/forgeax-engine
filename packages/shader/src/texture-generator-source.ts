/** Vertex ABI shared by build-time generator cooking and native raster consumption. */
export const TEXTURE_GENERATOR_VERTEX_ENTRY = 'vs_generator';
export const TEXTURE_GENERATOR_VERTEX_SOURCE = `
struct ForgeaxGeneratorVertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_generator(@builtin(vertex_index) i: u32) -> ForgeaxGeneratorVertex {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  var result: ForgeaxGeneratorVertex;
  result.position = vec4<f32>(p * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  result.uv = p;
  return result;
}`;
