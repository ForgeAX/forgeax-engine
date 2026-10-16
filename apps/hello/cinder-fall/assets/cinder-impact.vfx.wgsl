#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn}
#import forgeax_vfx::data::camera
#import forgeax_vfx::data::scene_depth
#import forgeax_vfx::data::noise

struct VfxParameters {
  intensity: f32,
  targetPosition: vec3<f32>,
}

struct VfxCustom {
  heat: f32,
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  let cameraLift = clamp(forgeax_vfx_camera[3][1], -1.0, 1.0);
  let noiseValue = textureLoad(forgeax_vfx_noise, vec2<i32>(0, 0), 0).r;
  let depthValue = textureLoad(forgeax_vfx_scene_depth, vec2<i32>(0, 0), 0);
  // Keep the first impact frame compact around the hit. A perfect ring reads
  // as a crown/picket fence, while a large initial radius reads as floating
  // beads; the velocity below supplies the outward expansion over time.
  // Use a low-discrepancy radial sequence instead of independent random
  // angles. It keeps the sixteen embers from collapsing into a symmetric
  // crown while still adding a small per-particle wobble.
  let angle = f32(ctx.particleId) * 2.399963 + (vfx_random_spawn(ctx, 8u) - 0.5) * 0.48;
  let core = (ctx.particleId % 5u) == 0u;
  let radius = select(
    0.02 + sqrt(vfx_random_spawn(ctx, 9u)) * 0.10,
    0.005 + sqrt(vfx_random_spawn(ctx, 9u)) * 0.06,
    core,
  );
  // Start at the platform surface; the upward velocity makes the +0.35 s
  // checkpoint read as a short-lived spray rather than a suspended cluster.
  let lift = select(
    0.05 + vfx_random_spawn(ctx, 10u) * 0.07,
    0.08 + vfx_random_spawn(ctx, 10u) * 0.08,
    core,
  );
  (*particle).position = forgeax_vfx_parameters.targetPosition + vec3<f32>(
    cos(angle) * radius,
    lift + cameraLift * 0.01 + noiseValue * 0.01 + depthValue * 0.01,
    sin(angle) * radius,
  );
  let radialSpeed = select(
    0.55 + vfx_random_spawn(ctx, 11u) * 0.62,
    0.28 + vfx_random_spawn(ctx, 11u) * 0.36,
    core,
  );
  (*particle).velocity = vec3<f32>(
    cos(angle) * radialSpeed,
    select(0.65 + vfx_random_spawn(ctx, 12u) * 0.52, 0.4 + vfx_random_spawn(ctx, 12u) * 0.3, core),
    sin(angle) * radialSpeed,
  );
  (*particle).lifetime = select(0.82, 0.58, core);
  (*particle).color = select(
    vec4<f32>(1.0, 0.18 + vfx_random_spawn(ctx, 14u) * 0.28, 0.01, 0.68),
    vec4<f32>(1.0, 0.5 + vfx_random_spawn(ctx, 14u) * 0.18, 0.03, 0.9),
    core,
  );
  (*particle).sprite_size = select(
    vec2<f32>(0.06 + vfx_random_spawn(ctx, 15u) * 0.05, 0.055 + vfx_random_spawn(ctx, 16u) * 0.045),
    vec2<f32>(0.085 + vfx_random_spawn(ctx, 15u) * 0.05, 0.075 + vfx_random_spawn(ctx, 16u) * 0.045),
    core,
  );
  let spin = vfx_random_spawn(ctx, 17u) * 6.2831853;
  (*particle).sprite_rotation = spin;
  (*particle).mesh_orientation = vec4<f32>(0.0, sin(spin * 0.5), 0.0, cos(spin * 0.5));
  let scale = select(0.038 + vfx_random_spawn(ctx, 18u) * 0.032, 0.052 + vfx_random_spawn(ctx, 18u) * 0.028, core);
  (*particle).mesh_scale = vec3<f32>(scale, scale * (0.78 + vfx_random_spawn(ctx, 19u) * 0.42), scale);
  (*custom).heat = 1.0;
  (*particle).material_random = (*custom).heat;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*particle).velocity *= max(0.0, 0.96 - forgeax_vfx_parameters.intensity * 0.01);
  vfx_integrate(ctx, particle);
  (*custom).heat = max(0.0, (*custom).heat - ctx.delta);
  (*particle).material_random = (*custom).heat;
}
