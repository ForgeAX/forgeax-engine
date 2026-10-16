#define_import_path forgeax_pbr::tbn

// @forgeax/engine-shader - tbn.wgsl (feat-20260523-shader-template-instance-split
// M5 / T01).
//
// Tangent-space normal decode + TBN basis composition helpers extracted from
// pbr.wgsl fs_main body. Pure-function module (zero @group / @binding) so it
// composes cleanly into any material shader that wants tangent-space normal
// mapping with the host's per-vertex tangent (vec4 with handedness in .w).
//
// RG-only tangent normal decode mirrors pbr.wgsl pre-split semantics
// (charter P5 byte-equivalent extraction). The default 1x1 normal fallback
// half-float texture RG=(0.5,0.5) decodes exactly to tangent (0,0,1) when
// normalTexture is absent (host-side defaultNormalTextureView). RG encoding
// also matches BC5 / RG normal maps and tolerates RGB normal maps (b is
// dropped, z is recomputed -- equivalent for unit vectors).
//
// Exports:
//   - decodeTangentSpaceNormalRg(rg)          -> vec3<f32>  (pure)
//   - scaleTangentSpaceNormal(tn, scale)      -> vec3<f32>  (pure)
//   - applyTBN(worldNormal, worldTangent, tn) -> vec3<f32>  (pure)

// Decode a tangent-space normal from the RG channels of a normal-map sample.
// Z is reconstructed via z = sqrt(saturate(1 - x^2 - y^2)); saturate guards
// against numerically-out-of-unit (x,y) producing NaN.
fn decodeTangentSpaceNormalRg(rg: vec2<f32>) -> vec3<f32> {
  let xy = rg * 2.0 - vec2<f32>(1.0);
  let z = sqrt(saturate(1.0 - dot(xy, xy)));
  return vec3<f32>(xy, z);
}

// Three r184: decode first, scale the two tangent axes independently, then
// normalize after basis conversion. In particular, strength must not change Z.
fn scaleTangentSpaceNormal(tn: vec3<f32>, scale: vec2<f32>) -> vec3<f32> {
  // A zero-strength map is flat even for a grazing encoded normal (Z = 0).
  let scaled = vec3<f32>(tn.xy * scale, tn.z);
  if (dot(scaled, scaled) < 1e-20) { return vec3<f32>(0.0, 0.0, 1.0); }
  return scaled;
}

// Mikkelsen surface-gradient bump mapping, matching Three r184's normalized
// position derivatives. The caller samples red-channel forward differences
// using the height slot's own UVs, sampler, and physical texture extent.
fn perturbBumpNormal(
  positionWS: vec3<f32>, normalWS: vec3<f32>, heightGradient: vec2<f32>, faceDirection: f32,
) -> vec3<f32> {
  let dx = dpdx(positionWS);
  let dy = dpdy(positionWS);
  let sx = dx * inverseSqrt(max(dot(dx, dx), 1e-20));
  let sy = dy * inverseSqrt(max(dot(dy, dy), 1e-20));
  let r1 = cross(sy, normalWS);
  let r2 = cross(normalWS, sx);
  let determinant = dot(sx, r1) * faceDirection;
  let gradient = sign(determinant) * (heightGradient.x * r1 + heightGradient.y * r2);
  let perturbed = abs(determinant) * normalWS - gradient;
  if (dot(perturbed, perturbed) < 1e-20) { return normalWS; }
  return normalize(perturbed);
}

// Build the TBN basis from interpolated world-space normal + per-vertex
// tangent (xyz with handedness sign in .w), then transform a tangent-space
// normal `tn` into world-space. Re-normalises the input world normal +
// re-orthogonalises the tangent against the normal so that small interpolation
// drift across triangle barycentrics does not skew the basis.
fn applyTBN(
  worldNormal  : vec3<f32>,
  worldTangent : vec4<f32>,
  tn           : vec3<f32>,
) -> vec3<f32> {
  let n0 = normalize(worldNormal);
  let t0 = normalize(worldTangent.xyz - dot(worldTangent.xyz, n0) * n0);
  let b0 = cross(n0, t0) * worldTangent.w;
  return normalize(t0 * tn.x + b0 * tn.y + n0 * tn.z);
}
