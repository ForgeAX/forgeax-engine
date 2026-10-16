#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let step = f32(ctx.particleId % 12u) / 11.0;
  let zigzag = select(-1.0, 1.0, (ctx.particleId % 2u) == 0u);
  (*particle).position = vec3<f32>(zigzag * 0.09, step * 2.15, 0.0);
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.18, 0.72 + step * 0.2, 1.0, 0.9);
  (*particle).sprite_size = vec2<f32>(0.03, 0.03);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 0.5;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let flicker = sin(f32(ctx.tick) * 0.7 + f32(ctx.particleId) * 2.3) * 0.018;
  (*particle).position.y += flicker;
  (*particle).color.a = (1.0 - life) * 0.9;
}
