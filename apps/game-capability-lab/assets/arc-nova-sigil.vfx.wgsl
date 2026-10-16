#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = 0.24 + vfx_random_spawn(ctx, 1u) * 0.36;
  (*particle).position = vec3<f32>(cos(angle) * radius, 0.03, sin(angle) * radius);
  (*particle).velocity = vec3<f32>(0.0, 0.12, 0.0);
  (*particle).color = vec4<f32>(0.08, 0.65, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.03, 0.03);
  (*particle).sprite_rotation = angle;
  (*particle).lifetime = 5.0;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let pulse = sin(life * 3.14159265);
  let size = mix(0.03, 0.14, pulse);
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = (*particle).sprite_rotation + ctx.delta;
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.05, 0.4, 1.0), vec3<f32>(0.5, 0.1, 1.0), life), 1.0 - life);
}
