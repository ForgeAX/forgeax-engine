#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
#import forgeax_vfx::data::force_fields
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function,VfxParticle>) {
  let id = ctx.particleId;
  (*particle).position = vec3f(f32(id % 16u)/20.0-0.375, f32((id/16u)%16u)/20.0-0.375, 0.1);
  if(id == 0u){(*particle).position=vec3f(0.125,-0.25,0.0);}
  if(id == 1u){(*particle).position=vec3f(0.125,-2.15,0.0);}
  if(id == 2u){(*particle).position=vec3f(0.125,1.85,0.0);}
  if(id == 3u){(*particle).position=vec3f(1.075,-0.25,0.0);}
  if(id == 4u){(*particle).position=vec3f(-0.925,-0.25,0.0);}
  (*particle).velocity = vec3f(0.0);
  (*particle).lifetime = 100.0;
  (*particle).sprite_size = vec2f(0.015);
  (*particle).color = vec4f(0.1,0.7,1.0,1.0);
}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function,VfxParticle>) {
  vfx_apply_force_fields(ctx,particle);
  vfx_integrate(ctx,particle);
}