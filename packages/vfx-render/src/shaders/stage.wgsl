// Managed particle stages are emitted by the compiler and dispatched by the RenderFeature.
// This shared ABI helper keeps the particle-domain bounds explicit at the shader boundary.
fn forgeax_vfx_stage_in_bounds(index: u32, capacity: u32) -> bool {
  return index < capacity;
}
