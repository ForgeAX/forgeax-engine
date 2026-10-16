#define_import_path forgeax::vfx-render.particles.mesh-shadow
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#import forgeax_shadow::surface::{projectShadowPosition}

struct MeshShadowInput {
  @location(0) position: vec3<f32>,
  @location(4) center: vec3<f32>,
  @location(5) right: vec3<f32>,
  @location(6) up: vec3<f32>,
  @location(7) forward: vec3<f32>,
};

@vertex
fn vs_main(input: MeshShadowInput) -> @builtin(position) vec4<f32> {
  let worldPosition = input.center + input.right * input.position.x +
    input.up * input.position.y + input.forward * input.position.z;
  return projectShadowPosition(vec4<f32>(worldPosition, 1.0));
}
