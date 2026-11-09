// One oversized triangle covers the physical output without interpolated UVs.
@vertex
fn tsr_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let x = f32((index << 1u) & 2u);
  let y = f32(index & 2u);
  return vec4<f32>(x*2.0-1.0, 1.0-y*2.0, 0.0, 1.0);
}
