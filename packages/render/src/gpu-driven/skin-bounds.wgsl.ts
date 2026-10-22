/** Shared Mesh envelopes are admitted on Mesh edits. Actual pre-cull candidates
 * read them with their already-resolved current palette. Unsupported geometry
 * or arithmetic remains uncullable; a bind-pose box is never substituted.
 */
export const SKIN_BOUNDS_WGSL = /* wgsl */ `
struct SkinEnvelopeBounds {
  minimum: vec3<f32>,
  valid: u32,
  maximum: vec3<f32>,
};

fn skinEnvelopeInput(at: u32) -> vec4<f32> {
  return bitcast<vec4<f32>>(vec4<u32>(skinInputs[at], skinInputs[at + 1u], skinInputs[at + 2u], skinInputs[at + 3u]));
}

// Reject source subnormals before bitcasting. Compute and vertex operations
// may legally flush differently, and a later large factor can amplify that gap.
fn skinEnvelopeUnstable(words: vec4<u32>) -> bool {
  let magnitude = words & vec4<u32>(0x7fffffffu);
  return any((magnitude - vec4<u32>(1u)) < vec4<u32>(0x007fffffu)) ||
    any(magnitude > vec4<u32>(0x7f7fffffu));
}

fn skinEnvelopeInputUnstable(at: u32) -> bool {
  return skinEnvelopeUnstable(vec4<u32>(skinInputs[at], skinInputs[at + 1u], skinInputs[at + 2u], skinInputs[at + 3u]));
}

fn skinEnvelopeMatrix(at: u32) -> mat4x4<f32> {
  return mat4x4<f32>(bitcast<vec4<f32>>(skinOutput[at]), bitcast<vec4<f32>>(skinOutput[at + 1u]),
    bitcast<vec4<f32>>(skinOutput[at + 2u]), bitcast<vec4<f32>>(skinOutput[at + 3u]));
}

fn skinEnvelopeBounds(geometry: u32, paletteBase: u32, jointCount: u32, displacementRadius: f32) -> SkinEnvelopeBounds {
  var result = SkinEnvelopeBounds(vec3<f32>(0.0), 0u, vec3<f32>(0.0));
  if (geometry == 0u || geometry == 0xffffffffu) { return result; }
  let maximumFloat = bitcast<f32>(0x7f7fffffu);
  // The material owner supplies its qualified local displacement bound. NaN
  // (unknown), negative and infinite bounds never grant culling permission.
  if (!(displacementRadius >= 0.0) || !(displacementRadius <= maximumFloat)) { return result; }
  if (skinEnvelopeInputUnstable(geometry)) { return result; }
  let header = skinEnvelopeInput(geometry);
  // A received zero may be a flushed positive subnormal material radius.
  let radius = displacementRadius + bitcast<f32>(0x00800000u);
  if (header.x < bitcast<f32>(0x00800000u) || header.y < header.x || header.z > f32(jointCount) || header.w < 1.0) { return result; }
  var minimum = vec3<f32>(maximumFloat);
  var maximum = vec3<f32>(-maximumFloat);
  var magnitude = 1.0;
  var localMagnitude = 1.0;
  for (var index = 0u; index < u32(header.w); index++) {
    let lowAt = geometry + 4u + index * 8u;
    if (skinEnvelopeInputUnstable(lowAt) || skinEnvelopeInputUnstable(lowAt + 4u)) { return result; }
    let low = skinEnvelopeInput(lowAt);
    let high = skinEnvelopeInput(lowAt + 4u);
    let localExtent = max(abs(low.xyz - vec3<f32>(radius)), abs(high.xyz + vec3<f32>(radius)));
    localMagnitude = max(localMagnitude, 1.0 + localExtent.x + localExtent.y + localExtent.z);
    let matrixAt = paletteBase + u32(low.w) * 4u;
    for (var row = 0u; row < 4u; row++) {
      let words = skinOutput[matrixAt + row];
      if (skinEnvelopeUnstable(words)) { return result; }
      // Blending precedes position projection, so even an origin vertex cannot
      // qualify a coefficient whose weighted accumulation may overflow.
      let limit = maximumFloat / (1.0 + 64.0 * 0.00000011920928955078125) / max(1.0, header.y);
      if (any(abs(bitcast<vec4<f32>>(words)) > vec4<f32>(limit))) { return result; }
    }
    let matrix = skinEnvelopeMatrix(matrixAt);
    // The enclosure proof requires affine composed matrices and positive weights.
    if (matrix[0].w != 0.0 || matrix[1].w != 0.0 || matrix[2].w != 0.0 || matrix[3].w != 1.0) { return result; }
    var a = matrix[3].xyz;
    var b = a;
    var absolute = abs(a);
    for (var dimension = 0u; dimension < 3u; dimension++) {
      let first = matrix[dimension].xyz * (low[dimension] - radius);
      let second = matrix[dimension].xyz * (high[dimension] + radius);
      a += min(first, second);
      b += max(first, second);
      absolute += max(abs(first), abs(second));
    }
    if (!all(abs(a) <= vec3<f32>(maximumFloat)) || !all(abs(b) <= vec3<f32>(maximumFloat))) { return result; }
    minimum = min(minimum, a);
    maximum = max(maximum, b);
    magnitude = max(magnitude, max(absolute.x, max(absolute.y, absolute.z)));
  }
  // Four palette*weight products and their accumulation precede the vertex
  // dot product. Cover independent intermediate FTZ, including homogeneous
  // xyz/sum(weight): normal positive weights keep w >= exact weight sum / 4.
  let minimumNormal = bitcast<f32>(0x00800000u);
  let blendUnderflow = max(64.0 * minimumNormal, 256.0 * minimumNormal / header.x) * localMagnitude;
  let padding = 64.0 * 0.00000011920928955078125 * magnitude * max(1.0, header.y) + blendUnderflow;
  result.minimum = min(minimum, min(min(minimum * header.x, minimum * header.y), min(maximum * header.x, maximum * header.y))) - vec3<f32>(padding);
  result.maximum = max(maximum, max(max(minimum * header.x, minimum * header.y), max(maximum * header.x, maximum * header.y))) + vec3<f32>(padding);
  if (all(abs(result.minimum) <= vec3<f32>(maximumFloat)) && all(abs(result.maximum) <= vec3<f32>(maximumFloat))) { result.valid = 1u; }
  return result;
}
`;
