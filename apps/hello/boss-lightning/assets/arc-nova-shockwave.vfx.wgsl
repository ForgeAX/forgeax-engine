#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(1.3, -0.68, 0.95);
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.42, 0.08, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.04, 0.04);
  (*particle).sprite_rotation = 0.35;
  let meshAngle = 0.35;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin(meshAngle * 0.5), cos(meshAngle * 0.5));
  (*particle).mesh_scale = vec3<f32>(0.04, 0.04, 0.04);
  (*particle).lifetime = 0.55;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let eased = 1.0 - (1.0 - life) * (1.0 - life);
  let size = mix(0.04, 0.24, eased);
  (*particle).sprite_size = vec2<f32>(size * 2.4, size * 0.65);
  (*particle).mesh_scale = vec3<f32>(size, size, size);
  let meshAngle = 0.35 - (*particle).age * 0.7;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin(meshAngle * 0.5), cos(meshAngle * 0.5));
  (*particle).sprite_rotation = 0.0;
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.8, 2.0, 3.0), vec3<f32>(0.15, 0.35, 1.0), life), 1.0 - life);
}
