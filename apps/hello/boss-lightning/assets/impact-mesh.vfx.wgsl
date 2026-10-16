#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}
#import forgeax_vfx::data::scene_depth::{VfxSceneDepthData}

struct VfxParameters {
  intensity: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  let angle = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let radius = sqrt(vfx_random_spawn(ctx, 1u)) * 0.7;
  // Event fragments share the attack anchor instead of falling out below the
  // boss. Their short radial lift reads as a local hit flash, not stray cubes.
  (*particle).position = vec3<f32>(1.3 + cos(angle) * radius * 0.45, -0.73, 0.95 + sin(angle) * radius * 0.45);
  (*particle).velocity = vec3<f32>(cos(angle) * 0.55, 0.8 + vfx_random_spawn(ctx, 2u) * 0.8, sin(angle) * 0.55);
  (*particle).color = vec4<f32>(0.22, 0.7, 1.0, 1.0);
  (*particle).sprite_size = vec2<f32>(0.3, 0.3);
  (*particle).sprite_rotation = 0.0;
  (*particle).mesh_orientation = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  // This is a ground-impact shard, not a column. Keep the cube footprint
  // compact so the event reads as debris around the warning marker.
  (*particle).mesh_scale = vec3<f32>(0.14, 0.08, 0.14);
  (*particle).lifetime = 1.1;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  var parameters: VfxParameters;
  let phony = parameters.intensity;
  let drag = max(0.0, 1.0 - 0.2 * ctx.delta);
  (*particle).velocity = vec3<f32>((*particle).velocity.x * drag, ((*particle).velocity.y - 2.0 * ctx.delta) * drag, (*particle).velocity.z * drag);
  vfx_integrate(ctx, particle);
  if ((*particle).position.y < -0.76) {
    (*particle).alive = 0u;
  }
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let size = mix(0.14, 0.02, life);
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).mesh_scale = vec3<f32>(size, size * 0.55, size);
  (*particle).sprite_rotation = 0.0;
  (*particle).color = vec4<f32>(mix(vec3<f32>(0.22, 0.7, 1.0), vec3<f32>(0.04, 0.12, 0.8), life), 1.0 - life);
}

// #vfx stage turbulence entry=vfx_turbulence domain=particle resources=particles:read-write,runtime:read dependsOn=update iterationBudget=4
fn vfx_turbulence(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let phase = f32(ctx.tick) * 0.08 + f32((*particle).id) * 0.013;
  let force = vec3<f32>(sin(phase), 0.0, cos(phase)) * (0.55 * ctx.delta);
  (*particle).velocity = vec3<f32>((*particle).velocity + force);
}
