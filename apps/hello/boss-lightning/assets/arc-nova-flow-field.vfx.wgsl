#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  // Arc Nova is a mouth-originated charge. Keep its world anchor on the
  // mouth joint instead of the old detached right-side staging point.
  (*particle).position = vec3<f32>(-0.85, 1.05, 0.9);
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.42, 0.78, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.04, 0.04);
  (*particle).sprite_rotation = -0.28;
  (*particle).lifetime = 2.35;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let enter = smoothstep(0.0, 0.12, life);
  let leave = 1.0 - smoothstep(0.85, 1.0, life);
  let pulse = 0.94 + sin(life * 18.849556) * 0.06;
  let size = mix(0.3, 0.65, 1.0 - (1.0 - enter) * (1.0 - enter)) * pulse;
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = (*particle).sprite_rotation + ctx.delta * 0.34;
  (*particle).color = vec4<f32>(
    mix(vec3<f32>(0.2, 0.68, 1.0), vec3<f32>(0.64, 0.18, 1.0), life),
    enter * leave,
  );
}
