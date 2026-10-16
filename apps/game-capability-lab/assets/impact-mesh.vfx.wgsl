#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}
#import forgeax_vfx::data::scene_depth::{VfxSceneDepthData}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = sqrt(vfx_random_spawn(ctx, 1u)) * 0.7;
  (*particle).position = vec3<f32>(cos(angle) * radius, 0.0, sin(angle) * radius);
  (*particle).velocity = vec3<f32>(0.0, 1.2 + vfx_random_spawn(ctx, 2u) * 0.5, 0.0);
  (*particle).color = vec4<f32>(1.0, 0.7, 0.2, 1.0);
  (*particle).sprite_size = vec2<f32>(0.3, 0.3);
  (*particle).sprite_rotation = 0.0;
  (*particle).lifetime = 1.1;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  let phony = parameters.intensity;
  let drag = max(0.0, 1.0 - 0.2 * ctx.delta);
  (*particle).velocity = vec3<f32>((*particle).velocity.x * drag, ((*particle).velocity.y - 2.0 * ctx.delta) * drag, (*particle).velocity.z * drag);
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let size = mix(0.3, 0.02, life);
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = 0.0;
  (*particle).color = vec4<f32>(mix(vec3<f32>(1.0, 0.7, 0.2), vec3<f32>(0.3, 0.05, 0.0), life), 1.0 - life);
}

// #vfx stage turbulence entry=vfx_turbulence domain=particle resources=particles:read-write,runtime:read dependsOn=update iterationBudget=4
fn vfx_turbulence(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let phase = f32(ctx.tick) * 0.08 + f32((*particle).id) * 0.013;
  let force = vec3<f32>(sin(phase), 0.0, cos(phase)) * (0.55 * ctx.delta);
  (*particle).velocity = vec3<f32>((*particle).velocity + force);
}
