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

fn parallaxHeight(heightMap : texture_2d<f32>, heightSampler : sampler, uv : vec2<f32>,
  uvDx : vec2<f32>, uvDy : vec2<f32>, scale : f32, bias : f32) -> f32 {
  return clamp(textureSampleGrad(heightMap, heightSampler, uv, uvDx, uvDy).r, 0.0, 1.0) * scale + bias;
}

// Parallax occlusion over the vertex kernel's own height d = h * scale + bias
// (object units along the normal). The caller takes every derivative in
// uniform control flow; the march samples with those explicit gradients, so a
// non-uniform scene-material row stays valid. Steps and fade follow the
// relief's projected pixel length. Returns the offset in the slot's SOURCE UV
// set so every slot sharing that set shifts together.
fn parallaxSourceUvOffset(heightMap : texture_2d<f32>, heightSampler : sampler, scale : f32,
  bias : f32, transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>,
  source : vec2<f32>, sourceDx : vec2<f32>, sourceDy : vec2<f32>, positionDx : vec3<f32>,
  positionDy : vec3<f32>, normal : vec3<f32>, tangent : vec4<f32>, viewDirection : vec3<f32>,
  objectToWorld : mat3x3<f32>) -> vec2<f32> {
  let n0 = normalize(normal);
  let t0 = normalize(tangent.xyz - dot(tangent.xyz, n0) * n0);
  let b0 = cross(n0, t0) * tangent.w;
  let screenToPlane = mat2x2<f32>(vec2<f32>(dot(t0, positionDx), dot(b0, positionDx)),
    vec2<f32>(dot(t0, positionDy), dot(b0, positionDy)));
  let planeDeterminant = determinant(screenToPlane);
  let viewNormal = dot(viewDirection, n0);
  if (!(abs(planeDeterminant) > 1e-20) || !(dot(tangent.xyz, tangent.xyz) > 1e-20)) {
    return vec2<f32>(0.0);
  }
  let planeToScreen = mat2x2<f32>(vec2<f32>(screenToPlane[1].y, -screenToPlane[0].y),
    vec2<f32>(-screenToPlane[1].x, screenToPlane[0].x)) * (1.0 / planeDeterminant);
  // World tangent-plane travel per object unit of height: normal-direction
  // scale |M^T n| converts the vertex kernel's object offset to world units.
  let grazing = select(-1.0, 1.0, viewNormal >= 0.0) * max(abs(viewNormal), 0.02);
  let planePerHeight = vec2<f32>(dot(viewDirection, t0), dot(viewDirection, b0)) / grazing
    * length(n0 * objectToWorld);
  let screenPerHeight = planeToScreen * planePerHeight;
  let slotScale = transform.zw * metadata.zw;
  let uvDx = materialUvLinear(sourceDx, transform, rotation) * metadata.zw;
  let uvDy = materialUvLinear(sourceDy, transform, rotation) * metadata.zw;
  let uvPerHeight = mat2x2<f32>(uvDx, uvDy) * screenPerHeight;
  let low = min(bias, scale + bias);
  let high = max(bias, scale + bias);
  let reliefPixels = length(screenPerHeight) * (high - low);
  let fade = clamp(reliefPixels - 1.0, 0.0, 1.0);
  if (!(fade > 0.0) || !(abs(slotScale.x * slotScale.y) > 1e-20)) { return vec2<f32>(0.0); }
  let uv = (materialUvLinear(source, transform, rotation) + transform.xy) * metadata.zw;
  // Enter from the slab face toward the camera; `side` makes "below the
  // height field" non-positive for either face.
  let side = select(-1.0, 1.0, viewNormal >= 0.0);
  let start = select(low, high, viewNormal >= 0.0);
  let end = select(high, low, viewNormal >= 0.0);
  let steps = u32(clamp(ceil(reliefPixels), 4.0, 32.0));
  var outside = start;
  var inside = end;
  // Sample the entry face too: a surface at the slab top (every recess map)
  // must stop there, or a ray tunnels one step under the near pit edge.
  for (var i = 0u; i <= steps; i++) {
    let d = mix(start, end, f32(i) / f32(steps));
    if (side * (d - parallaxHeight(heightMap, heightSampler, uv + uvPerHeight * d, uvDx, uvDy, scale, bias)) <= 0.0) {
      inside = d;
      break;
    }
    outside = d;
  }
  for (var i = 0u; i < 5u; i++) {
    let d = 0.5 * (outside + inside);
    if (side * (d - parallaxHeight(heightMap, heightSampler, uv + uvPerHeight * d, uvDx, uvDy, scale, bias)) <= 0.0) {
      inside = d;
    } else {
      outside = d;
    }
  }
  // Invert the slot's linear map (scale, rotation, physical extent) onto its source set.
  let slotOffset = uvPerHeight * inside * fade / metadata.zw;
  let unrotated = vec2<f32>(slotOffset.x * rotation.x + slotOffset.y * rotation.y,
    slotOffset.y * rotation.x - slotOffset.x * rotation.y) / dot(rotation.xy, rotation.xy);
  return unrotated / transform.zw;
}
