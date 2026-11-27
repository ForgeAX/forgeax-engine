import { TEXTURE_GENERATOR_VOLUME_ENTRY } from '@forgeax/engine-types';

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

/** Four R8 texels per invocation, packed for a portable buffer-to-volume copy. */
export const TEXTURE_GENERATOR_VOLUME_GROUP = 4;
export const TEXTURE_GENERATOR_VOLUME_SOURCE = `
@group(0) @binding(0) var<storage, read_write> generatorVolume: array<u32>;
@group(0) @binding(1) var<uniform> generatorExtent: vec4<u32>;

@compute @workgroup_size(${TEXTURE_GENERATOR_VOLUME_GROUP}, ${TEXTURE_GENERATOR_VOLUME_GROUP}, ${TEXTURE_GENERATOR_VOLUME_GROUP})
fn ${TEXTURE_GENERATOR_VOLUME_ENTRY}(@builtin(global_invocation_id) id: vec3<u32>) {
  let extent = generatorExtent.xyz;
  let x = id.x * 4u;
  if (x >= extent.x || id.y >= extent.y || id.z >= extent.z) { return; }
  var texels = 0u;
  for (var lane = 0u; lane < 4u; lane += 1u) {
    if (x + lane < extent.x) {
      let p = vec3<u32>(x + lane, id.y, id.z);
      let value = u32(floor(clamp(volumeValue(p, extent), 0.0, 1.0) * 255.0 + 0.5));
      texels |= value << (8u * lane);
    }
  }
  generatorVolume[(id.z * extent.y + id.y) * generatorExtent.w + id.x] = texels;
}`;
