#define_import_path forgeax_material::surface_sampling
#import forgeax_material::surface_v1::{SurfaceInput}

// Caller-supplied ray-cone UV diameter. Rotation preserves the spectral bound;
// the largest texture axis gives a conservative isotropic mip selection.
fn surfaceTextureFootprint(input: SurfaceInput, transform: vec4<f32>, metadata: vec4<f32>) -> f32 {
  let index = u32(clamp(metadata.x, 0.0, 7.0));
  var footprint = input.uvFootprint0[index % 4u];
  if (index >= 4u) { footprint = input.uvFootprint1[index % 4u]; }
  return footprint * max(abs(transform.z), abs(transform.w)) * max(abs(metadata.z), abs(metadata.w));
}
fn sampleSurfaceTexture(tex: texture_2d<f32>, smp: sampler, uv: vec2<f32>, footprint: f32) -> vec4<f32> {
#ifdef RAY_SURFACE_CONTEXT
  let size = textureDimensions(tex, 0);
  let lod = clamp(log2(max(footprint * f32(max(size.x, size.y)), 1.0)), 0.0, f32(textureNumLevels(tex) - 1u));
  return textureSampleLevel(tex, smp, uv, lod);
#else
  return textureSample(tex, smp, uv);
#endif
}
