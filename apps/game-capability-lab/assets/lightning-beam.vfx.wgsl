#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.0, 0.0);
  (*particle).velocity = vec3<f32>(0.0, 2.25, -0.18);
  (*particle).color = vec4<f32>(0.72, 0.12, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.02, 0.02);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 0.28;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a = 1.0 - life;
}
