#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = vfx_random_spawn(ctx, 1u) * 0.22;
  let speed = 0.18 + vfx_random_spawn(ctx, 2u) * 0.18;
  (*particle).position = vec3<f32>(cos(angle) * radius, -0.03, sin(angle) * radius);
  (*particle).velocity = vec3<f32>(cos(angle) * 0.06, speed, sin(angle) * 0.06);
  (*particle).color = vec4<f32>(1.0, 0.38 + vfx_random_spawn(ctx, 3u) * 0.45, 0.04, 1.0);
  (*particle).sprite_size = vec2<f32>(0.05, 0.05);
  (*particle).sprite_rotation = angle;
  (*particle).lifetime = 3.0 + vfx_random_spawn(ctx, 4u) * 0.8;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  let drag = max(0.0, 1.0 - 0.16 * ctx.delta);
  (*particle).velocity = vec3<f32>((*particle).velocity.x * drag, ((*particle).velocity.y - 1.35 * ctx.delta) * drag, (*particle).velocity.z * drag);
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let size = mix(0.05, 0.008, life);
  (*particle).sprite_size = vec2<f32>(size, size * 1.8);
  (*particle).sprite_rotation = (*particle).sprite_rotation + ctx.delta * 2.8;
  (*particle).color = vec4<f32>(mix(vec3<f32>(1.0, 0.7, 0.15), vec3<f32>(0.35, 0.01, 0.0), life), 1.0 - life);
}
