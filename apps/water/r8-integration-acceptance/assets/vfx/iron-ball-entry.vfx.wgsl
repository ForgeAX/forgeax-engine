#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_random_spawn}
#import water_entry::motion::{VfxParameters, VfxCustom, entry_edge, entry_edge_velocity, entry_release, entry_alpha}

fn vfx_spawn(
  ctx: VfxSpawnContext,
  particle: ptr<function, VfxParticle>,
  custom: ptr<function, VfxCustom>
) {
  (*particle).position = forgeax_vfx_parameters.entryPosition;
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).material_random = vfx_random_spawn(ctx, 0u);
  (*particle).sprite_size = vec2<f32>(0.0);
  (*particle).color = vec4<f32>(0.72, 0.87, 0.92, 0.0);
  (*particle).lifetime = forgeax_vfx_parameters.lifetime;
  (*custom).subsurfaceGainOpacity = vec4<f32>(0.154509, 0.434783, 0.317283, 1.0);
  (*custom).waterSphereShading = vec4<f32>(5.0, 1.0, 0.18, 0.7);
  (*custom).waterSphereFlattenSphere = vec4<f32>(0.0, 0.0, 1.0, 1.25);
  (*custom).waterSphereProjection = vec4<f32>(vfx_random_spawn(ctx, 4u), 0.0, 50.0, 0.5);
}

fn vfx_update(
  ctx: VfxUpdateContext,
  particle: ptr<function, VfxParticle>,
  custom: ptr<function, VfxCustom>
) {
  _ = custom;
  let p = forgeax_vfx_parameters;
  let age = (*particle).age + ctx.delta;
  let phase = (*particle).material_random;
  let jet = phase > 0.88;
  let release = entry_release(p, phase, jet);
  let detachedAge = max(age - release, 0.0);
  let edgeAge = min(age, release);
  let gravity = vec3<f32>(0.0, -9.81, 0.0);
  if (age <= release) {
    (*particle).position = entry_edge(p, age, phase, jet);
    (*particle).velocity = entry_edge_velocity(p, age, phase, jet);
  } else if ((*particle).age <= release) {
    // Transfer the exact rim position and tangent once; later surface movement cannot move a free drop.
    let edge = entry_edge(p, release, phase, jet) - p.surfaceVelocityMps * detachedAge;
    let velocity = entry_edge_velocity(p, release, phase, jet);
    (*particle).position = edge + velocity * detachedAge + 0.5 * gravity * detachedAge * detachedAge;
    (*particle).velocity = velocity + gravity * detachedAge;
  } else {
    (*particle).position += (*particle).velocity * ctx.delta + 0.5 * gravity * ctx.delta * ctx.delta;
    (*particle).velocity += gravity * ctx.delta;
  }
  let size = p.dropletSize * (0.18 + 0.82 * pow(fract(phase * 29.73), 2.3));
  let remaining = 1.0 - smoothstep(p.lifetime * 0.65, p.lifetime, age);
  let attached = smoothstep(release * 0.65, release, age);
  let sheetAlpha = entry_alpha(p, edgeAge, jet);
  (*particle).color.a = p.opacity * attached * remaining * sheetAlpha;
  (*particle).sprite_size = vec2<f32>(size, size * (1.0 + 1.8 * (1.0 - smoothstep(0.0, 0.07, detachedAge))));
}
