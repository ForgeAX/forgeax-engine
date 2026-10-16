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
  // Travel particles are also consumed by the trail topology. Keep their
  // lateral order stable so the history segments form one narrow wake.
  let travelIndex = ctx.particleId % 8u;
  let angle = f32(travelIndex) * (6.2831853 / 8.0);
  // A falling meteor leaves a compact wake above its centre, not a flat halo
  // below it. The vertical spread is deliberately short so the wake stays
  // attached while the scene mesh descends.
  let radius = 0.03 + sqrt(vfx_random_spawn(ctx, 20u)) * 0.12;
  // Stagger the wake just below the scene meteor. A single shared height made
  // the eight particles collapse into a halo; this short tail gives the fall
  // a readable direction without floating above the projectile.
  let tail = f32(travelIndex) / 7.0;
  let headWeight = 1.0 - tail;
  let tailOffset = f32(travelIndex) * 0.18;
  let startHeight = 7.72 - tailOffset + vfx_random_spawn(ctx, 21u) * 0.10;
  // Match the scene meteor's authored 7.62-unit descent over 1.5 s. A
  // faster particle shell visibly detaches below the meteor at mid-travel.
  let speed = 4.65 + vfx_random_spawn(ctx, 22u) * 0.25;
  (*particle).position = forgeax_vfx_parameters.targetPosition + vec3<f32>(
    cos(angle) * radius * 0.65,
    startHeight + cameraLift * 0.02 + noiseValue * 0.01 + depthValue * 0.01,
    0.14 + sin(angle) * radius * 0.25,
  );
  (*particle).velocity = vec3<f32>(cos(angle) * 0.12, -speed, sin(angle) * 0.06);
  // The travel shell must clear before the impact checkpoint; otherwise its
  // trail and mesh overlap the impact burst as a suspended slab.
  (*particle).lifetime = 1.35;
  // Taper the wake from a compact hot core into small, separated wisps. The
  // previous uniform 0.13x0.30 quads merged into a rectangular orange slab
  // once eight particles shared the same camera-facing basis.
  (*particle).sprite_size = vec2<f32>(0.09 + headWeight * 0.07, 0.10 + headWeight * 0.09);
  // Keep the elongated sprites mostly vertical so the wake reads as a flame
  // tail; a small deterministic wobble prevents coplanar repetition.
  (*particle).sprite_rotation = (vfx_random_spawn(ctx, 27u) - 0.5) * 0.22;
  // Keep the sprites as a soft ember layer. The trail carries the continuous
  // silhouette; fully opaque quads turn the wake into a stepped yellow bar.
  (*particle).color = vec4<f32>(1.0, 0.24 + headWeight * 0.34, 0.015, 0.52 + headWeight * 0.24);
  (*particle).mesh_scale = vec3<f32>(0.055 + headWeight * 0.035, 0.11 + headWeight * 0.07, 0.055 + headWeight * 0.035);
  (*custom).heat = vfx_random_spawn(ctx, 17u);
  (*particle).material_random = (*custom).heat;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*particle).velocity.y -= (0.45 + max(0.0, forgeax_vfx_parameters.intensity) * 0.1) * ctx.delta;
  vfx_integrate(ctx, particle);
  (*custom).heat = clamp((*custom).heat + ctx.delta * 0.05, 0.0, 1.0);
  (*particle).material_random = (*custom).heat;
  let tail = f32((*particle).id % 8u) / 7.0;
  (*particle).color.w *= 1.0 - smoothstep(0.68, 1.0, (*particle).age / (*particle).lifetime);
  (*particle).sprite_size *= 1.0 - tail * 0.16;
}
