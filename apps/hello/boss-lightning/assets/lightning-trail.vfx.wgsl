#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let lane = vfx_random_spawn(ctx, 0u) - 0.5;
  (*particle).position = vec3<f32>(1.3, -0.70, 0.95);
  // Short ballistic sparks lift away from the ground contact. They do not
  // add a second straight mouth-to-target streak behind the jagged bolt.
  (*particle).velocity = vec3<f32>(lane * 2.4, 1.2 + vfx_random_spawn(ctx, 1u), lane * 0.8);
  // Keep the trail in the same cool Arc Nova palette as the mouth charge.
  // The built-in trail shader now preserves this authored color instead of
  // tinting every topology segment orange.
  (*particle).color = vec4<f32>(0.08, 0.66 + vfx_random_spawn(ctx, 1u) * 0.24, 1.0, 0.64);
  (*particle).sprite_size = vec2<f32>(0.025, 0.025);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 0.48;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  (*particle).velocity.y -= 3.0 * ctx.delta;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a = 1.0 - life;
}
