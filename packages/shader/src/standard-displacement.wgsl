#define_import_path forgeax_material::displacement
#import forgeax_material::texture_coordinates::{materialUvLinear}

// Level zero is identical in color, depth, temporal and every shadow view.
// Height is normalized linear data; bounding uses this same closed [0, 1] range.
fn displaceVertex(position : vec3<f32>, normal : vec3<f32>, heightMap : texture_2d<f32>,
  heightSampler : sampler, scale : f32, bias : f32, transform : vec4<f32>,
  metadata : vec4<f32>, rotation : vec4<f32>, coordinates : array<vec2<f32>, 8>) -> vec3<f32> {
  let uv = coordinates[u32(clamp(metadata.x, 0.0, 7.0))];
  let transformed = (materialUvLinear(uv, transform, rotation) + transform.xy) * metadata.zw;
  let height = clamp(textureSampleLevel(heightMap, heightSampler, transformed, 0.0).r, 0.0, 1.0);
  let lengthSquared = dot(normal, normal);
  let direction = normal * inverseSqrt(max(lengthSquared, 1e-20));
  return position + direction * (height * scale + bias);
}

// Follow the actual displaced triangles, including mesh density and world scale.
// No invented height-gradient detail on a four-vertex plane. Degenerate projected
// triangles retain the incoming normal; orientation survives mirrored transforms.
fn displacedNormal(position : vec3<f32>, original : vec3<f32>) -> vec3<f32> {
  let geometric = cross(dpdx(position), dpdy(position));
  let lengthSquared = dot(geometric, geometric);
  let unit = geometric * inverseSqrt(max(lengthSquared, 1e-30));
  return select(original, unit * select(-1.0, 1.0, dot(unit, original) >= 0.0), lengthSquared > 1e-30);
}
