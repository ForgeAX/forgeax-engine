#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_random_words}

// createSmoke.js exhaust emitters (children of the car). The Player entity sits at the exhaust
// offset under the car, space is local, so puffs follow the car. Same age-derived life as the
// ambient smoke.
const SPEED = 0.5;
const OPACITY = 0.4;
// params.exhaustScale 4 x car scale 1.1 (local space scales positions, not sprite_size)
const WORLD_SCALE = 4.4;
// sRGB 0x9a9890 / 0x4a4845 in linear
const COLOR_START = vec3<f32>(0.32314, 0.31399, 0.27889);
const COLOR_END = vec3<f32>(0.06848, 0.06480, 0.05951);

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = vec3<f32>(0.0);
  (*particle).lifetime = 1.0e9;
  (*particle).color = vec4<f32>(COLOR_START, 0.0);
  (*particle).sprite_size = vec2<f32>(0.0);
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let id = ctx.particleId;
  let lifeRange = 0.1 + 0.9 * vfx_random_words(ctx.seed, id, 0u, 0u);
  let offset = vec3<f32>(
    mix(-0.08, 0.08, vfx_random_words(ctx.seed, id, 0u, 1u)),
    mix(0.02, 0.35, vfx_random_words(ctx.seed, id, 0u, 2u)),
    mix(-0.04, 0.04, vfx_random_words(ctx.seed, id, 0u, 3u)),
  );
  let scale = mix(0.12, 0.42, vfx_random_words(ctx.seed, id, 0u, 4u));
  let rotateRange = mix(0.1, 4.0, vfx_random_words(ctx.seed, id, 0u, 5u));

  let scaledTime = ((*particle).age + 5.0) * SPEED;
  let lifeTime = fract(scaledTime * lifeRange);
  let life = lifeTime / lifeRange;

  // local space: the car matrix scales positions by 1.1, so only the 4 here
  (*particle).position = offset * lifeTime * 4.0;
  let size = 0.5 * scale * max(lifeTime, 0.25) * WORLD_SCALE;
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = scaledTime * rotateRange;
  (*particle).color = vec4<f32>(mix(COLOR_START, COLOR_END, life * 0.85), (1.0 - life) * OPACITY);
}
