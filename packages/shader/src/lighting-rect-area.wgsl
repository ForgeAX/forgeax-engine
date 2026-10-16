#define_import_path forgeax_pbr::lighting_rect_area
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_pbr::brdf::{specularF90}
#import forgeax_view::common::{ltcLambertTexture, ltcGgxTexture, spotModifierSampler, cookieTexture}
#endif

// One-sided finite-area direct lighting using the same Heitz LTC formulation
// and tracked 64x64 tables as Three.js r184. The rectangle corners, rather
// than a punctual center direction, are transformed into the fitted cosine
// space before the spherical edge integral is evaluated.
//
// An optional source texture occupies one slice of the shared, mipmapped
// light-texture array. Following Unreal's SampleSourceTexture, the radiance
// is fetched where the LTC mean irradiance direction meets the emitter plane,
// from a prefiltered level whose texel footprint tracks the lobe footprint.

const RECT_SOURCE_TEXTURE_NONE : u32 = 0xffffffffu;
// Keep in sync with COOKIE_SLICE_SIZE / COOKIE_MIP_LEVEL_COUNT on the host.
const RECT_SOURCE_TEXTURE_SIZE : f32 = 256.0;
const RECT_SOURCE_TEXTURE_MAX_LEVEL : f32 = 8.0;

struct RectLtcSample {
  formFactor : f32,
  // World-space mean incident direction of the transformed polygon; only its
  // orientation is meaningful.
  direction : vec3<f32>,
};

fn ltcUv(n : vec3<f32>, v : vec3<f32>, roughness : f32) -> vec2<f32> {
  let lutScale = 63.0 / 64.0;
  let lutBias = 0.5 / 64.0;
  let nDotV = clamp(dot(n, v), 0.0, 1.0);
  return vec2<f32>(clamp(roughness, 0.0, 1.0), sqrt(1.0 - nDotV)) * lutScale + lutBias;
}

fn ltcClippedSphereFormFactor(f : vec3<f32>) -> f32 {
  let magnitude = length(f);
  return max((magnitude * magnitude + f.z) / (magnitude + 1.0), 0.0);
}

fn ltcEdgeVectorFormFactor(v1 : vec3<f32>, v2 : vec3<f32>) -> vec3<f32> {
  let x = clamp(dot(v1, v2), -1.0, 1.0);
  let y = abs(x);
  let a = 0.8543985 + (0.4965155 + 0.0145206 * y) * y;
  let b = 3.4175940 + (4.1616724 + y) * y;
  let rational = a / b;
  let thetaOverSinTheta = select(
    0.5 * inverseSqrt(max(1.0 - x * x, 1e-7)) - rational,
    rational,
    x > 0.0,
  );
  return cross(v1, v2) * thetaOverSinTheta;
}

fn ltcEvaluate(
  n : vec3<f32>,
  v : vec3<f32>,
  worldPos : vec3<f32>,
  mInv : mat3x3<f32>,
  lightPos : vec3<f32>,
  axisX : vec3<f32>,
  axisY : vec3<f32>,
  halfWidth : f32,
  halfHeight : f32,
) -> RectLtcSample {
  let halfX = axisX * halfWidth;
  let halfY = axisY * halfHeight;
  // Counter-clockwise from the authored front (+cross(axisX, axisY)).
  let rect0 = lightPos - halfX - halfY;
  let rect1 = lightPos + halfX - halfY;
  let rect2 = lightPos + halfX + halfY;
  let rect3 = lightPos - halfX + halfY;
  let lightNormal = cross(rect1 - rect0, rect3 - rect0);
  if (dot(lightNormal, worldPos - rect0) <= 0.0) {
    return RectLtcSample(0.0, lightNormal);
  }

  let tangentCandidate = v - n * dot(v, n);
  let tangentLengthSquared = dot(tangentCandidate, tangentCandidate);
  var tangent = vec3<f32>(1.0, 0.0, 0.0);
  if (tangentLengthSquared > 1e-7) {
    tangent = tangentCandidate * inverseSqrt(tangentLengthSquared);
  } else {
    let fallback = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.x) < 0.9);
    tangent = normalize(cross(fallback, n));
  }
  let bitangent = -cross(n, tangent);
  let basis = mat3x3<f32>(tangent, bitangent, n);
  let transform = mInv * transpose(basis);

  let c0 = normalize(transform * (rect0 - worldPos));
  let c1 = normalize(transform * (rect1 - worldPos));
  let c2 = normalize(transform * (rect2 - worldPos));
  let c3 = normalize(transform * (rect3 - worldPos));
  let vectorFormFactor =
    ltcEdgeVectorFormFactor(c0, c1) +
    ltcEdgeVectorFormFactor(c1, c2) +
    ltcEdgeVectorFormFactor(c2, c3) +
    ltcEdgeVectorFormFactor(c3, c0);
  // mInv only mixes the tangent-space x/z lanes, so its adjugate is the
  // direction-preserving inverse; the determinant sign keeps the orientation.
  let a = mInv[0].x;
  let b = mInv[0].z;
  let c = mInv[2].x;
  let d = mInv[2].z;
  let adjugate = mat3x3<f32>(
    vec3<f32>(d, 0.0, -b),
    vec3<f32>(0.0, a * d - b * c, 0.0),
    vec3<f32>(-c, 0.0, a),
  );
  let orientation = select(-1.0, 1.0, a * d - b * c >= 0.0);
  return RectLtcSample(
    ltcClippedSphereFormFactor(vectorFormFactor),
    basis * (adjugate * vectorFormFactor) * orientation,
  );
}

#ifdef EXTENDED_LIGHTING_AVAILABLE
fn rectSourceTextureLevel(sourceSlice : u32, uv : vec2<f32>, level : f32) -> vec3<f32> {
  let border = 0.5 / max(RECT_SOURCE_TEXTURE_SIZE / exp2(level), 1.0);
  let clampedUv = clamp(uv, vec2<f32>(border), vec2<f32>(1.0 - border));
  return textureSampleLevel(cookieTexture, spotModifierSampler, clampedUv, sourceSlice, level).rgb;
}
#endif

// Radiance scale of the source texture along `direction`. `spread` is the
// lobe width relative to a clamped cosine (1 for diffuse, GGX alpha for
// specular); the LOD mirrors Unreal's distance/extent heuristic scaled by it.
fn rectSourceTextureRadiance(
  sourceSlice : u32,
  worldPos : vec3<f32>,
  direction : vec3<f32>,
  lightPos : vec3<f32>,
  axisX : vec3<f32>,
  axisY : vec3<f32>,
  halfWidth : f32,
  halfHeight : f32,
  spread : f32,
) -> vec3<f32> {
#ifdef EXTENDED_LIGHTING_AVAILABLE
  if (sourceSlice == RECT_SOURCE_TEXTURE_NONE) {
    return vec3<f32>(1.0);
  }
  let front = cross(axisX, axisY);
  let lengthSquared = dot(direction, direction);
  var toLight = select(-front, direction * inverseSqrt(max(lengthSquared, 1e-20)), lengthSquared > 1e-20);
  // Bend grazing and back-facing mean directions onto the emitter plane.
  toLight = toLight - front * max(dot(front, toLight) + 0.001, 0.0);
  let distanceToPlane = dot(front, lightPos - worldPos) / dot(front, toLight);
  let local = worldPos + toLight * distanceToPlane - lightPos;
  let uv = vec2<f32>(
    0.5 + 0.5 * dot(axisX, local) / max(halfWidth, 1e-4),
    0.5 - 0.5 * dot(axisY, local) / max(halfHeight, 1e-4),
  );
  let footprint = distanceToPlane * max(spread, 1e-4) * inverseSqrt(max(halfWidth * halfHeight, 1e-8));
  let level = clamp(log2(max(footprint, 1e-8)) + log2(RECT_SOURCE_TEXTURE_SIZE) - 2.0, 0.0, RECT_SOURCE_TEXTURE_MAX_LEVEL);
  // The shared sampler repeats, so each level clamps half of its own texel to
  // never wrap to the opposite edge. One trilinear tap would need the coarser
  // level's border and jump at every integer level (a visible ring).
  let fine = floor(level);
  let coarse = min(fine + 1.0, RECT_SOURCE_TEXTURE_MAX_LEVEL);
  let fineSample = rectSourceTextureLevel(sourceSlice, uv, fine);
  let coarseSample = rectSourceTextureLevel(sourceSlice, uv, coarse);
  return max(mix(fineSample, coarseSample, level - fine), vec3<f32>(0.0));
#else
  return vec3<f32>(1.0);
#endif
}

fn rectAreaRangeFactor(lightPos : vec3<f32>, worldPos : vec3<f32>, invRangeSquared : f32) -> f32 {
  let toLight = lightPos - worldPos;
  let distanceSquared = dot(toLight, toLight);
  let rangeTerm = distanceSquared * invRangeSquared;
  let factor = clamp(1.0 - rangeTerm * rangeTerm, 0.0, 1.0);
  return factor * factor;
}

fn evalRectAreaLtcDiffuse(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
  sourceSlice : u32,
) -> vec3<f32> {
  let identity = mat3x3<f32>(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0),
  );
  let ltc = ltcEvaluate(
    n, v, worldPos, identity, lightPos, axisX, axisY, halfWidth, halfHeight,
  );
  let source = rectSourceTextureRadiance(
    sourceSlice, worldPos, ltc.direction, lightPos, axisX, axisY, halfWidth, halfHeight, 1.0,
  );
  // The LTC edge fit is already normalized by 1/(2*pi); unlike punctual
  // irradiance this form factor must not receive another Lambert 1/pi.
  let diffuse = baseColor * (1.0 - metallic);
  return lightColor * source * diffuse * ltc.formFactor * rectAreaRangeFactor(lightPos, worldPos, invRangeSquared);
}

fn evalRectAreaLtcStandard(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
  transmission : vec3<f32>, sourceSlice : u32,
) -> vec3<f32> {
#ifdef EXTENDED_LIGHTING_AVAILABLE
  let uv = ltcUv(n, v, sqrt(max(alphaSq, 0.0)));
  let matrixSample = textureSampleLevel(ltcLambertTexture, spotModifierSampler, uv, 0.0);
  let fresnelSample = textureSampleLevel(ltcGgxTexture, spotModifierSampler, uv, 0.0);
  let mInv = mat3x3<f32>(
    vec3<f32>(matrixSample.x, 0.0, matrixSample.y),
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(matrixSample.z, 0.0, matrixSample.w),
  );
  let fresnel = F0 * fresnelSample.x + (vec3<f32>(specularF90(F0)) - F0) * fresnelSample.y;
  let specular = ltcEvaluate(
    n, v, worldPos, mInv, lightPos, axisX, axisY, halfWidth, halfHeight,
  );
  let source = rectSourceTextureRadiance(
    sourceSlice, worldPos, specular.direction, lightPos, axisX, axisY, halfWidth, halfHeight, alphaSq,
  );
  let diffuse = evalRectAreaLtcDiffuse(
    lightPos, lightColor, axisX, axisY, halfWidth, halfHeight, invRangeSquared,
    worldPos, n, v, baseColor, metallic, alphaSq, F0, sourceSlice,
  );
  var transmitted = vec3<f32>(0.0);
  // The diffuse-transmission lobe is the same cosine form factor over the
  // opposite hemisphere; opaque materials skip the second edge integral.
  if (any(transmission > vec3<f32>(0.0))) {
    transmitted = evalRectAreaLtcDiffuse(
      lightPos, lightColor, axisX, axisY, halfWidth, halfHeight, invRangeSquared,
      worldPos, -n, v, transmission, 0.0, alphaSq, F0, sourceSlice,
    );
  }
  return diffuse + transmitted + lightColor * source * fresnel * specular.formFactor * rectAreaRangeFactor(lightPos, worldPos, invRangeSquared);
#else
  return vec3<f32>(0.0);
#endif
}

// Both renderer routes consume one complete Standard-PBR Rect contribution.
// The public names retain the direct/cluster shader import contract while the
// Lambert and fitted-GGX terms stay inseparable in one owner implementation.
fn evalRectAreaLtcLambert(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
  transmission : vec3<f32>, sourceSlice : u32,
) -> vec3<f32> {
  return evalRectAreaLtcStandard(
    lightPos, lightColor, axisX, axisY, halfWidth, halfHeight, invRangeSquared,
    worldPos, n, v, baseColor, metallic, alphaSq, F0, transmission, sourceSlice,
  );
}

fn evalRectAreaLtcGgx(
  lightPos : vec3<f32>, lightColor : vec3<f32>, axisX : vec3<f32>, axisY : vec3<f32>,
  halfWidth : f32, halfHeight : f32, invRangeSquared : f32, worldPos : vec3<f32>,
  n : vec3<f32>, v : vec3<f32>, baseColor : vec3<f32>, metallic : f32, alphaSq : f32, F0 : vec3<f32>,
  transmission : vec3<f32>, sourceSlice : u32,
) -> vec3<f32> {
  return evalRectAreaLtcStandard(
    lightPos, lightColor, axisX, axisY, halfWidth, halfHeight, invRangeSquared,
    worldPos, n, v, baseColor, metallic, alphaSq, F0, transmission, sourceSlice,
  );
}
