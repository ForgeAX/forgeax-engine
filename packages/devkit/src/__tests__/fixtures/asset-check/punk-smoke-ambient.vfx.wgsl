#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext, vfx_random_words}

// createSmoke.js ambient emitters. Player.seed selects the emitter (xyz = position, w = sprite
// world scale); every particle is born at t = 0 and its life is derived from age, as the TSL
// version derives it from `time` (no global time uniform here).
const SPEED = 0.065;
const OPACITY = 0.4;
// sRGB 0x8a8885 / 0x454340 in linear
const COLOR_START = vec3<f32>(0.25415, 0.24620, 0.23455);
const COLOR_END = vec3<f32>(0.05951, 0.05613, 0.05127);

fn emitter(index: u32) -> vec4<f32> {
  var emitters = array<vec4<f32>, 4>(
    vec4<f32>(-138.5, -5.0, 36.2, 9.5),
    vec4<f32>(-119.5, -4.85, 16.8, 15.0),
    vec4<f32>(-135.5, -5.0, 36.0, 5.0),
    vec4<f32>(-106.2, -5.0, 18.0, 9.8),
  );
  return emitters[min(index, 3u)];
}

fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) {
  (*particle).position = emitter(ctx.seed).xyz;
  (*particle).lifetime = 1.0e9;
  (*particle).color = vec4<f32>(COLOR_START, 0.0);
  (*particle).sprite_size = vec2<f32>(0.0);
}

fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {
  let id = ctx.particleId;
  let at = emitter(ctx.seed);
  // range() draws of the original, fixed per particle
  let lifeRange = 0.1 + 0.9 * vfx_random_words(ctx.seed, id, 0u, 0u);
  let offset = vec3<f32>(
    mix(-0.7, 0.7, vfx_random_words(ctx.seed, id, 0u, 1u)),
    mix(0.0, 1.2, vfx_random_words(ctx.seed, id, 0u, 2u)),
    mix(-0.7, 0.7, vfx_random_words(ctx.seed, id, 0u, 3u)),
  );
  let scale = mix(0.3, 0.9, vfx_random_words(ctx.seed, id, 0u, 4u));
  let rotateRange = mix(0.1, 4.0, vfx_random_words(ctx.seed, id, 0u, 5u));

  let scaledTime = ((*particle).age + 5.0) * SPEED;
  let lifeTime = fract(scaledTime * lifeRange);
  let life = lifeTime / lifeRange;

  (*particle).position = at.xyz + offset * lifeTime * at.w;
  // a Sprite quad is 1 unit wide; sprite_size is the half extent
  let size = 0.5 * scale * max(lifeTime, 0.25) * at.w;
  (*particle).sprite_size = vec2<f32>(size, size);
  (*particle).sprite_rotation = scaledTime * rotateRange;
  (*particle).color = vec4<f32>(mix(COLOR_START, COLOR_END, life * 0.85), (1.0 - life) * OPACITY);
}
