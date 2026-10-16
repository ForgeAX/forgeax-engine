#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = sqrt(vfx_random_spawn(ctx, 1u)) * 0.55;
  (*particle).position = vec3<f32>(cos(angle) * radius, 0.05, sin(angle) * radius);
  (*particle).velocity = vec3<f32>(cos(angle) * 2.0, 1.6 + vfx_random_spawn(ctx, 2u) * 1.4, sin(angle) * 2.0);
  (*particle).color = vec4<f32>(0.15, 0.82, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.28, 0.28);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 0.72;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity = (*particle).velocity * vec3<f32>(0.94, 0.96, 0.94);
  (*particle).velocity.y = (*particle).velocity.y - 3.6 * ctx.delta;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let size = mix(0.28, 0.02, life);
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = (*particle).sprite_rotation + ctx.delta * 4.0;
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.15, 0.82, 1.0), vec3<f32>(0.25, 0.08, 1.0), life), 1.0 - life);
}
