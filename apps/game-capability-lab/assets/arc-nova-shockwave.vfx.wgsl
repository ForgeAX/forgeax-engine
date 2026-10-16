#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, 0.07, 0.0);
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.42, 0.08, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.04, 0.04);
  (*particle).sprite_rotation = 0.35;
  (*particle).lifetime = 4.0;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let eased = 1.0 - (1.0 - life) * (1.0 - life);
  let size = mix(0.04, 0.24, eased);
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = (*particle).sprite_rotation - ctx.delta * 0.7;
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.78, 0.42, 1.0), vec3<f32>(0.04, 0.18, 1.0), life), 1.0 - smoothstep(0.72, 1.0, life));
}
