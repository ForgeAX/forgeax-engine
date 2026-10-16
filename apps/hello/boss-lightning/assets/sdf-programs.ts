const parameters = `
// forgeax-vfx-default position = vec3<f32>(-1.5,1.5,0.0)
// forgeax-vfx-default velocity = vec3<f32>(4.0,-3.0,0.0)
// forgeax-vfx-default spread = 2.0
// forgeax-vfx-default jitter = 2.0
// forgeax-vfx-default gravity = 9.8
// forgeax-vfx-default radius = 0.02
// forgeax-vfx-default restitution = 0.7
// forgeax-vfx-default friction = 0.1
// forgeax-vfx-default diagnostics = 0
struct VfxParameters {
  position: vec3<f32>, spread: f32,
  velocity: vec3<f32>, jitter: f32,
  gravity: f32, radius: f32, restitution: f32, friction: f32,
  diagnostics: u32,
}
`;
const spawn = `fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function,VfxParticle>) {
  (*particle).position = forgeax_vfx_parameters.position + vec3f(0.0,0.0,(vfx_random_spawn(ctx,0u)-0.5)*forgeax_vfx_parameters.spread);
  (*particle).velocity = forgeax_vfx_parameters.velocity + vec3f(vfx_random_spawn(ctx,1u)*forgeax_vfx_parameters.jitter,0.0,0.0);
  (*particle).lifetime = 10.0;
  (*particle).sprite_size = vec2f(0.04);
  (*particle).color = vec4f(0.1,0.7,1.0,1.0);
}
`;

export const SDF_MODULES = {
  'sdf-collision.vfx.wgsl': { entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_random_spawn,vfx_integrate}
#import forgeax_vfx::data::scene_sdf
${parameters}
${spawn}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function,VfxParticle>) {
  (*particle).velocity.y -= forgeax_vfx_parameters.gravity*ctx.delta;
  let contact = vfx_sdf_collide((*particle).position,(*particle).velocity,ctx.delta,
    forgeax_vfx_parameters.radius,forgeax_vfx_parameters.restitution,forgeax_vfx_parameters.friction);
  (*particle).position = contact.position;
  (*particle).velocity = contact.velocity;
  if (contact.status==1u) { (*particle).color=vec4f(0.2,1.0,0.1,1.0); }
  if (contact.status>=2u) { (*particle).color=vec4f(1.0,0.1,0.1,1.0); }
  // Explicit bounded diagnostic runs only; performance and ordinary presentation
  // retain the normal color. No gameplay readback or CPU particle state.
  if (forgeax_vfx_parameters.diagnostics != 0u) { (*particle).color.z=f32(contact.samples); }
}
` },
  'sdf-free.vfx.wgsl': { entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_random_spawn,vfx_integrate}
${parameters}
${spawn}
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function,VfxParticle>) {
  (*particle).velocity.y -= forgeax_vfx_parameters.gravity*ctx.delta;
  vfx_integrate(ctx,particle);
}
` },
};
