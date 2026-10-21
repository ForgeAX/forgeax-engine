/** Native compute source shipped with the renderer, with no bundler raw-loader requirement. */
export const TERRAIN_LAYER_BAKE_SHADER = /* wgsl */ `struct Bake {
  material: array<vec4<f32>, 5>,
  images: array<vec4<f32>, 6>,
  height: vec4<f32>,
  destination: vec4<u32>,
}
@group(0) @binding(0) var<uniform> bake: Bake;
@group(0) @binding(1) var images: texture_2d_array<f32>;
@group(0) @binding(2) var imageSampler: sampler;
@group(0) @binding(3) var colors: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var normals: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var orms: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(6) var emissions: texture_storage_2d_array<rgba16float, write>;

fn srgbToLinear(value: vec4<f32>) -> vec4<f32> {
  let rgb = select(pow((value.rgb + 0.055) / 1.055, vec3<f32>(2.4)), value.rgb / 12.92, value.rgb <= vec3<f32>(0.04045));
  return vec4<f32>(rgb, value.a);
}
fn sampleImage(index: u32, uv: vec2<f32>) -> vec4<f32> {
  let image = bake.images[index];
  if (image.x < 0.0) { return vec4<f32>(-2.0 - image.x, image.yzw); }
  let origin = vec2<f32>(f32(u32(image.z) % 2048u), f32(u32(image.z) / 2048u));
  let plane = i32(image.w);
  if (fract(image.w) == 0.0) {
    let point = (origin + fract(uv) * image.xy) / vec2<f32>(textureDimensions(images, 0));
    return textureSampleLevel(images, imageSampler, point, plane, 0.0);
  }
  // Native RGBA8 keeps the exact source values. Decode each neighbor before
  // filtering sRGB, so the derived half-float output is quantized only once.
  let point = fract(uv) * image.xy - 0.5;
  let base = vec2<i32>(origin + floor(point));
  let weight = fract(point);
  let a = srgbToLinear(textureLoad(images, base, plane, 0));
  let b = srgbToLinear(textureLoad(images, base + vec2<i32>(1, 0), plane, 0));
  let c = srgbToLinear(textureLoad(images, base + vec2<i32>(0, 1), plane, 0));
  let d = srgbToLinear(textureLoad(images, base + vec2<i32>(1, 1), plane, 0));
  return mix(mix(a, b, weight.x), mix(c, d, weight.x), weight.y);
}
@compute @workgroup_size(8, 8)
fn bakeLayers(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= bake.destination.yz)) { return; }
  let uv = (vec2<f32>(id.xy) + 0.5) / vec2<f32>(bake.destination.yz);
  let color = sampleImage(0u, uv) * bake.material[0];
  let normal = sampleImage(1u, uv).xy * 2.0 - 1.0;
  let normalOrm = bake.material[2];
  let direction = vec3<f32>(normal * normalOrm.xy, sqrt(max(0.0, 1.0 - dot(normal, normal))));
  let n = select(vec3<f32>(0.0, 0.0, 1.0), normalize(direction), dot(direction, direction) > 0.0);
  let mr = sampleImage(2u, uv);
  let ao = sampleImage(3u, uv).x;
  let orm = vec3<f32>(1.0 + (ao - 1.0) * bake.material[3].x, mr.y * normalOrm.z, mr.z * normalOrm.w);
  let emission = sampleImage(4u, uv).rgb * bake.material[1].rgb;
  var height = 0.0;
  if (bake.height.z != 0.0) { height = (sampleImage(5u, uv).x - bake.height.x) / (bake.height.y - bake.height.x); }
  let position = vec2<i32>(id.xy);
  let plane = i32(bake.destination.x);
  textureStore(colors, position, plane, color);
  textureStore(normals, position, plane, vec4<f32>(n, height));
  textureStore(orms, position, plane, vec4<f32>(orm, 0.0));
  textureStore(emissions, position, plane, vec4<f32>(emission, 0.0));
}
`;
