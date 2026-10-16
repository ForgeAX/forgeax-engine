#define_import_path forgeax_pbr::ibl_probe_background

#import forgeax_pbr::ibl_shared::{inverseRotateEnvironment}

struct ProbeBackground {
  right: vec4<f32>,
  up: vec4<f32>,
  backward: vec4<f32>,
  rotation: vec4<f32>,
  scale: vec4<f32>,
};
struct ProbeBackgroundVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) direction: vec3<f32>,
};
@group(0) @binding(0) var backgroundCube: texture_cube<f32>;
@group(0) @binding(1) var backgroundSampler: sampler;
@group(0) @binding(2) var<uniform> background: ProbeBackground;

@vertex
fn probe_background_vs(@builtin(vertex_index) index: u32) -> ProbeBackgroundVertex {
  let x = select(-1.0, 3.0, index == 1u);
  let y = select(-1.0, 3.0, index == 2u);
  return ProbeBackgroundVertex(vec4<f32>(x, y, 0.0, 1.0),
    background.right.xyz * x + background.up.xyz * y - background.backward.xyz);
}

@fragment
fn probe_background_fs(in: ProbeBackgroundVertex) -> @location(0) vec4<f32> {
  let direction = inverseRotateEnvironment(normalize(in.direction), background.rotation);
  let sampleDirection = vec3<f32>(direction.x, -direction.y, direction.z);
  return vec4<f32>(textureSampleLevel(backgroundCube, backgroundSampler, sampleDirection, 0.0).rgb
    * background.scale.xyz, 1.0);
}
