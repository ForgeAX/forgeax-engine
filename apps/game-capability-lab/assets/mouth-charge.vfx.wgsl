#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = sqrt(vfx_random_spawn(ctx, 1u)) * 0.45;
  let height = (vfx_random_spawn(ctx, 2u) - 0.5) * 0.35;
  (*particle).position = vec3<f32>(cos(angle) * radius, height, sin(angle) * radius);
  (*particle).velocity = vec3<f32>(0.0, 0.5, 0.0);
  (*particle).color = vec4<f32>(0.2, 0.75, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.24, 0.24);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 1.8;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  let drag = max(0.0, 1.0 - 0.12 * ctx.delta);
  (*particle).velocity = vec3<f32>((*particle).velocity.x * drag, ((*particle).velocity.y + 0.4 * ctx.delta) * drag, (*particle).velocity.z * drag);
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let size = mix(0.24, 0.04, life);
  let rotation = (*particle).sprite_rotation + ctx.delta * 2.4;
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = rotation;
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.2, 0.75, 1.0), vec3<f32>(0.05, 0.3, 1.0), life), 1.0 - life);
}
