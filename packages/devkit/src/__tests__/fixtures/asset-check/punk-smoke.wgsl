#define_import_path punk::smoke

#import forgeax_view::common::{View, view}
#import forgeax_view::fog::{translucent_fog, ndc_world}
#import forgeax_material::parameters::{material, smokeTexture, smokeTexture_sampler}

// createSmoke.js SpriteNodeMaterial: opacity = tex.a * max(tex.rgb) * (1 - life) * opacity (the
// VFX update folds (1 - life) * opacity into particle.color.a), alphaTest 0.05, colour from the
// particle (mix(colorStart, colorEnd, life * .85)), transparent, no depth write. The quad itself
// is rotated by sprite_rotation, which equals the original rotateUV for this radial texture.

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) local: vec2<f32>,
  @location(2) clip_position: vec3<f32>,
};

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) right: vec2<f32>,
  @location(2) up: vec2<f32>,
  @location(3) particle_color: vec4<f32>,
  @location(4) base_color: vec4<f32>,
  @location(5) emissive_intensity: vec4<f32>,
  @location(6) surface: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput, @builtin(vertex_index) vertex_index: u32) -> VertexOutput {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0)
  );
  let corner = corners[vertex_index];
  var output: VertexOutput;
  let clip_position = vec3<f32>(
    input.position.xy + input.right * corner.x + input.up * corner.y,
    input.position.z,
  );
  output.position = vec4<f32>(clip_position, 1.0);
  output.clip_position = clip_position;
  output.color = input.particle_color * input.base_color;
  output.local = corner;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = vec2<f32>(input.local.x * 0.5 + 0.5, 0.5 - input.local.y * 0.5);
  let tex = textureSample(smokeTexture, smokeTexture_sampler, uv);
  let alpha = tex.a * max(tex.r, max(tex.g, tex.b)) * input.color.a;
  if (alpha < 0.05) {
    discard;
  }
  let fogged = translucent_fog(view, ndc_world(view, input.clip_position), input.color.rgb * alpha, alpha);
  return vec4<f32>(fogged, alpha);
}
