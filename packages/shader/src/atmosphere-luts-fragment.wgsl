#define_import_path forgeax_atmosphere::luts_fragment
#import forgeax_view::common::{View, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::table_kernels::{atmosphere_transmittance_texel, atmosphere_multiple_scattering_texel, atmosphere_sky_view_texel}

@group(0) @binding(0) var<uniform> parameters: View;
@group(0) @binding(1) var transmittance: texture_2d<f32>;
@group(0) @binding(2) var multiple: texture_2d<f32>;
@group(0) @binding(3) var filtering: sampler;

@vertex
fn atmosphere_tables_vs(@builtin(vertex_index) i: u32) -> FullscreenOutput {
  return fullscreen_triangle(i);
}
@fragment
fn atmosphere_transmittance_fragment(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return atmosphere_transmittance_texel(parameters.atmosphere, (p.xy-0.5)/vec2<f32>(255.0,63.0));
}
@fragment
fn atmosphere_multiple_scattering_fragment(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return atmosphere_multiple_scattering_texel(parameters.atmosphere, (p.xy-0.5)/31.0, transmittance, filtering);
}
@fragment
fn atmosphere_sky_view_fragment(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return atmosphere_sky_view_texel(parameters, p.xy/vec2<f32>(192.0,208.0), transmittance, multiple, filtering);
}
