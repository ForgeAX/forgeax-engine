#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

struct VfxParameters {
  intensity: f32,
}

// Thirteen control points follow the twelve primary beam segments.
fn shape_ribbon(id: u32, tick: u32, particle: ptr<function, VfxParticle>) {
  let index = id % 13u;
  let t = f32(index) / 12.0;
  let phase = floor(f32(tick) / 4.0) * 2.17;
  let envelope = sin(t * 3.14159265);
  let offset = sin(f32(index) * 17.13 + phase) * envelope * 0.19;
  (*particle).position = mix(vec3<f32>(-0.85, 1.0, 0.98), vec3<f32>(1.3, -0.76, 0.95), t)
    + vec3<f32>(offset * 0.55, offset, sin(f32(index) * 8.7 + phase) * envelope * 0.07);
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.1, 0.7, 1.0, 0.7);
  (*particle).sprite_size = vec2<f32>(0.015);
  (*particle).lifetime = 0.58;
  shape_ribbon(ctx.particleId, ctx.tick, particle);
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  shape_ribbon(ctx.particleId, ctx.tick, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a = (1.0 - smoothstep(0.72, 1.0, life)) * 0.7;
}
