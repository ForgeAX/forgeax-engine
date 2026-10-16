#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let lane = vfx_random_spawn(ctx, 0u) - 0.5;
  (*particle).position = vec3<f32>(lane * 0.28, 0.0, 0.0);
  (*particle).velocity = vec3<f32>(lane * 0.22, 1.65, 0.0);
  (*particle).color = vec4<f32>(1.0, 0.36 + vfx_random_spawn(ctx, 1u) * 0.2, 0.06, 0.9);
  (*particle).sprite_size = vec2<f32>(0.025, 0.025);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 1.15;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  (*particle).velocity.y += sin(f32(ctx.tick) * 0.18 + f32(ctx.particleId)) * 0.012;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a = 1.0 - life;
}
