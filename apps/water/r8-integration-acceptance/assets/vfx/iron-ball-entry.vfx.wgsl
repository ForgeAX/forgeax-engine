#import forgeax_vfx::prelude::{
  VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_integrate, vfx_random_spawn,
}

struct VfxParameters {
  entryPosition: vec3<f32>,
  entryVelocity: vec3<f32>,
  surfaceNormal: vec3<f32>,
}

struct VfxCustom {
  subsurfaceGainOpacity: vec4<f32>,
  waterSphereShading: vec4<f32>,
  waterSphereFlattenSphere: vec4<f32>,
  waterSphereProjection: vec4<f32>,
}

fn vfx_spawn(
  ctx: VfxSpawnContext,
  particle: ptr<function, VfxParticle>,
  custom: ptr<function, VfxCustom>
) {
  let normal = normalize(forgeax_vfx_parameters.surfaceNormal);
  let reference = select(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), abs(normal.z) > 0.9);
  let tangent = normalize(cross(normal, reference));
  let bitangent = normalize(cross(normal, tangent));
  let azimuth = vfx_random_spawn(ctx, 0u) * 6.2831853;
  let spread = 0.3 + vfx_random_spawn(ctx, 1u) * 0.55;
  let birthSizeRandom = vfx_random_spawn(ctx, 2u);
  let radial = tangent * cos(azimuth) + bitangent * sin(azimuth);
  let impactSpeed = length(forgeax_vfx_parameters.entryVelocity);
  (*particle).position = forgeax_vfx_parameters.entryPosition + normal * 0.025;
  (*particle).velocity = normal * (1.0 + min(impactSpeed * 0.12, 2.4)) +
    radial * spread + forgeax_vfx_parameters.entryVelocity * 0.08;
  (*particle).color = vec4<f32>(0.72, 0.88, 0.94, 0.72);
  (*particle).sprite_size = vec2<f32>(0.16 + birthSizeRandom * 0.22);
  (*particle).material_random = birthSizeRandom;
  (*particle).lifetime = 0.65 + vfx_random_spawn(ctx, 3u) * 0.4;
  (*custom).subsurfaceGainOpacity = vec4<f32>(0.154509, 0.434783, 0.317283, 0.25);
  (*custom).waterSphereShading = vec4<f32>(30.0, 1.0, 0.5, -5.0);
  (*custom).waterSphereFlattenSphere = vec4<f32>(0.0, 0.0, 1.0, 1.25);
  (*custom).waterSphereProjection = vec4<f32>(vfx_random_spawn(ctx, 4u), 0.0, 50.0, 0.5);
}

fn vfx_update(
  ctx: VfxUpdateContext,
  particle: ptr<function, VfxParticle>,
  custom: ptr<function, VfxCustom>
) {
  _ = custom;
  (*particle).velocity += vec3<f32>(0.0, -9.8, 0.0) * ctx.delta;
  vfx_integrate(ctx, particle);
  let life = clamp((*particle).age / (*particle).lifetime, 0.0, 1.0);
  (*particle).color.a = 0.72 * (1.0 - life);
  (*particle).sprite_size = vec2<f32>(0.16 + (*particle).material_random * 0.22) * (1.0 - life * 0.55);
}
