#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0, -0.33, 0.0);
  (*particle).velocity = vec3<f32>(0.0, 0.42, 0.0);
  (*particle).color = vec4<f32>(0.18, 0.72, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.08, 0.08);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 3.0;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let flare = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.82, 1.0, life));
  (*particle).sprite_size = vec2<f32>(mix(0.08, 0.025, life), 0.0);
  (*particle).sprite_rotation = 0.0;
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.72, 0.95, 1.0), vec3<f32>(0.12, 0.08, 0.8), life), flare);
}
