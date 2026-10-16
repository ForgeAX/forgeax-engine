#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
#import forgeax_vfx::data::force_fields
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function,VfxParticle>) {
  let id = ctx.particleId;
  (*particle).position = vec3f(f32(id % 16u)/20.0-0.375, f32((id/16u)%16u)/20.0-0.375, 0.1);
  (*particle).velocity = vec3f(0.0);
  (*particle).lifetime = 100.0;
  (*particle).sprite_size = vec2f(0.015);
  (*particle).color = vec4f(0.1,0.7,1.0,1.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function,VfxParticle>) {
  vfx_apply_force_fields(ctx,particle);
  vfx_integrate(ctx,particle);
}