#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let speed = 0.32 + vfx_random_spawn(ctx, 1u) * 0.18;
  let lift = (vfx_random_spawn(ctx, 2u) - 0.35) * 0.07;
  (*particle).position = vec3<f32>(-0.85 + cos(angle) * 0.12, 1.05 + sin(angle) * 0.08, 0.9);
  (*particle).velocity = vec3<f32>(cos(angle) * speed, sin(angle) * speed + lift, 0.0);
  (*particle).color = vec4<f32>(0.12 + vfx_random_spawn(ctx, 3u) * 0.3, 0.35, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.06, 0.06);
  (*particle).sprite_rotation = angle - 1.5707963;
  let meshAngle = angle - 1.5707963;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, sin(meshAngle * 0.5), cos(meshAngle * 0.5));
  (*particle).mesh_scale = vec3<f32>(0.06, 0.06, 0.06);
  (*particle).lifetime = 2.5 + vfx_random_spawn(ctx, 4u) * 0.5;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  _ = parameters.intensity;
  (*particle).velocity *= vec3<f32>(max(0.0, 1.0 - ctx.delta * 1.8));
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).sprite_size.x = mix(0.06, 0.015, life);
  let meshSize = mix(0.06, 0.015, life);
  (*particle).mesh_scale = vec3<f32>(meshSize, meshSize, meshSize);
  (*particle).color = vec4<f32>(mix((*particle).color.rgb, vec3<f32>(0.55, 0.03, 0.95), life), 1.0 - life);
}
