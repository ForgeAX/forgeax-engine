#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = f32(ctx.particleId) * 2.399963 + vfx_random_spawn(ctx, 1u) * 0.2;
  let radius = 0.03 + vfx_random_spawn(ctx, 2u) * 0.08;
  (*particle).position = vec3<f32>(cos(angle) * radius, 0.72, sin(angle) * radius);
  (*particle).velocity = vec3<f32>(cos(angle) * 0.24, 0.28 + vfx_random_spawn(ctx, 3u) * 0.14, sin(angle) * 0.24);
  (*particle).lifetime = 0.34;
  (*particle).color = vec4<f32>(0.06, 0.62, 1.0, 0.92);
  (*particle).sprite_size = vec2<f32>(0.14, 0.18);
  (*particle).sprite_rotation = angle;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity.y -= 0.85 * ctx.delta;
  vfx_integrate(ctx, particle);
  (*particle).color.w *= max(0.0, 1.0 - ctx.delta * 2.8);
}
