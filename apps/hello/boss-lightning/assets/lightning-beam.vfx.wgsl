#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}

struct VfxParameters {
  intensity: f32,
}

// Shared nodes keep short beam segments connected while the bolt flickers.
fn bolt_node(index: u32, phase: f32) -> vec3<f32> {
  let t = f32(index) / 12.0;
  let envelope = sin(t * 3.14159265);
  let offset = sin(f32(index) * 17.13 + phase) * envelope * 0.19;
  return mix(vec3<f32>(-0.85, 1.0, 0.98), vec3<f32>(1.3, -0.76, 0.95), t)
    + vec3<f32>(offset * 0.55, offset, sin(f32(index) * 8.7 + phase) * envelope * 0.07);
}

fn shape_bolt(id: u32, tick: u32, particle: ptr<function, VfxParticle>) {
  let segment = id % 24u;
  let phase = floor(f32(tick) / 4.0) * 2.17;
  var start = bolt_node(segment % 12u, phase);
  var end = bolt_node(segment % 12u + 1u, phase);
  if (segment >= 12u) {
    let branch = segment - 12u;
    let root = 2u + branch / 2u;
    let sign = select(-1.0, 1.0, (branch / 2u) % 2u == 0u);
    let origin = bolt_node(root, phase);
    let elbow = origin + vec3<f32>(0.13, sign * 0.17, 0.035);
    start = select(origin, elbow, branch % 2u == 1u);
    end = select(elbow, elbow + vec3<f32>(0.2, sign * 0.08, -0.04), branch % 2u == 1u);
  }
  (*particle).position = start;
  (*particle).velocity = (end - start) / (*particle).lifetime;
  (*particle).color = select(vec4<f32>(2.4, 7.0, 10.0, 0.95), vec4<f32>(0.8, 2.2, 6.0, 0.55), segment >= 12u);
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).lifetime = 0.58;
  (*particle).sprite_size = vec2<f32>(0.012);
  shape_bolt(ctx.particleId, ctx.tick, particle);
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  shape_bolt(ctx.particleId, ctx.tick, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a *= 1.0 - smoothstep(0.72, 1.0, life);
}
