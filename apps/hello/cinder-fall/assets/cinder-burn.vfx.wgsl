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
  let angle = vfx_random_spawn(ctx, 23u) * 6.2831853;
  let ember = (ctx.particleId % 4u) == 0u;
  // Spread the ground residue around the anchor so it reads as a footprint,
  // while keeping each smoke/ember sprite compact enough to remain distinct.
  // Keep the plume close to the impact anchor. A wide ring reads as floating
  // petals; a compact radius leaves the vertical drift below to form one
  // readable smoke column.
  let radius = select(
    0.03 + sqrt(vfx_random_spawn(ctx, 24u)) * 0.16,
    0.05 + sqrt(vfx_random_spawn(ctx, 24u)) * 0.22,
    ember,
  );
  let puffHeight = select(
    0.05 + vfx_random_spawn(ctx, 25u) * 0.10,
    0.03 + vfx_random_spawn(ctx, 25u) * 0.06,
    ember,
  );
  (*particle).position = forgeax_vfx_parameters.targetPosition + vec3<f32>(
    cos(angle) * radius,
    puffHeight + cameraLift * 0.01 + noiseValue * 0.01 + depthValue * 0.01,
    sin(angle) * radius,
  );
  let drift = select(0.0, 0.04, ember);
  (*particle).velocity = vec3<f32>(cos(angle) * drift, select(0.28 + vfx_random_spawn(ctx, 26u) * 0.20, 0.40 + vfx_random_spawn(ctx, 26u) * 0.24, ember), sin(angle) * drift);
  // Keep a sparse ember alive through the burn checkpoint. The smoke owns
  // the long tail; the ember is only a small hot witness at the impact site.
  (*particle).lifetime = select(3.5 + vfx_random_spawn(ctx, 27u) * 1.5, 1.8 + vfx_random_spawn(ctx, 27u) * 1.0, ember);
  // Most particles are low-alpha smoke; one in four remains a small hot
  // ember. Keeping the two roles in one emitter preserves the existing event
  // and lifetime contract without turning the footprint into orange bubbles.
  (*particle).color = select(
    vec4<f32>(0.24 + vfx_random_spawn(ctx, 28u) * 0.10, 0.19 + vfx_random_spawn(ctx, 29u) * 0.08, 0.12 + vfx_random_spawn(ctx, 30u) * 0.06, 0.42 + vfx_random_spawn(ctx, 30u) * 0.14),
    vec4<f32>(1.0, 0.30 + vfx_random_spawn(ctx, 29u) * 0.24, 0.01, 0.82 + vfx_random_spawn(ctx, 30u) * 0.14),
    ember,
  );
  (*particle).sprite_size = select(
    vec2<f32>(0.13 + vfx_random_spawn(ctx, 31u) * 0.08, 0.20 + vfx_random_spawn(ctx, 32u) * 0.14),
    vec2<f32>(0.045 + vfx_random_spawn(ctx, 31u) * 0.035, 0.055 + vfx_random_spawn(ctx, 32u) * 0.045),
    ember,
  );
  (*particle).sprite_rotation = vfx_random_spawn(ctx, 33u) * 6.2831853;
  (*particle).mesh_scale = vec3<f32>(0.34, 0.014, 0.34);
  (*custom).heat = 1.0;
  (*particle).material_random = (*custom).heat;
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>, custom: ptr<function, VfxCustom>) {
  (*particle).color.w = max(0.0, (*particle).color.w - ctx.delta * select(0.045, 0.16, (*particle).id % 4u == 0u));
  vfx_integrate(ctx, particle);
  let normalizedAge = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  let swell = sin(normalizedAge * 3.1415926);
  let ember = (*particle).id % 4u == 0u;
  (*particle).sprite_size = select(
    vec2<f32>(mix(0.13, 0.22, swell), mix(0.20, 0.34, swell)),
    vec2<f32>(mix(0.045, 0.075, swell), mix(0.055, 0.10, swell)),
    ember,
  );
  (*particle).mesh_scale = vec3<f32>(mix(0.34, 0.46, normalizedAge), mix(0.014, 0.006, normalizedAge), mix(0.34, 0.46, normalizedAge));
  (*custom).heat = max(0.0, (*custom).heat - ctx.delta * 0.1);
  (*particle).material_random = (*custom).heat;
}
