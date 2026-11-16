#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
#import water_entry::motion::{VfxParameters, VfxCustom, entry_orientation, entry_drift, entry_scale, entry_alpha}

fn vfx_spawn(
  ctx: VfxSpawnContext,
  particle: ptr<function, VfxParticle>,
  custom: ptr<function, VfxCustom>
) {
  _ = ctx;
  (*custom).subsurfaceGainOpacity = vec4<f32>(0.0);
  (*custom).waterSphereShading = vec4<f32>(0.0);
  (*custom).waterSphereFlattenSphere = vec4<f32>(0.0);
  (*custom).waterSphereProjection = vec4<f32>(0.0);
  (*particle).mesh_orientation = entry_orientation(forgeax_vfx_parameters);
  (*particle).position = forgeax_vfx_parameters.entryPosition;
  (*particle).velocity = vec3<f32>(0.0);
  (*particle).mesh_scale = vec3<f32>(0.0);
  (*particle).color = vec4<f32>(0.72, 0.87, 0.92, 0.0);
  (*particle).lifetime = forgeax_vfx_parameters.lifetime;
}

fn vfx_update(
  ctx: VfxUpdateContext,
  particle: ptr<function, VfxParticle>,
  custom: ptr<function, VfxCustom>
) {
  _ = custom;
  let age = (*particle).age + ctx.delta;
  (*particle).position = forgeax_vfx_parameters.entryPosition + forgeax_vfx_parameters.surfaceOffsetM + entry_drift(forgeax_vfx_parameters) * age;
  (*particle).mesh_scale = entry_scale(forgeax_vfx_parameters, age, false);
  (*particle).color.a = forgeax_vfx_parameters.opacity * entry_alpha(forgeax_vfx_parameters, age, false);
}
