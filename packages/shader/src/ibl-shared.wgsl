#define_import_path forgeax_pbr::ibl_shared
#import forgeax_pbr::brdf::{specularF90}

// @forgeax/engine-shader - ibl-shared.wgsl (feat-20260520-skylight-ibl-cubemap M3 / t42).
//
// Pure-function math shared across the 6-module ibl-* family. Zero binding
// declarations -- this module never touches @group/@binding so it composes
// cleanly with any host that has its own @group(0)/@group(1) layout.
//
// Origin: round-1's monolithic ibl.wgsl collided @group(1) @binding(0)
// across texture_2d (equirect) and texture_cube (irradiance, prefilter),
// which the WGSL spec forbids inside a single module. round-2 splits the
// math out into this file so the 4 precompute modules + 2 sampling helpers
// can each declare their own (group, binding) namespace without overlap.
//
// Exports (no entry points):
//   - PI, INV_ATAN constants
//   - sampleSphericalMap(v)
//   - radicalInverseVdC(bits)
//   - hammersley(i, N)
//   - iblDGGX(nDotH, roughness)
//   - iblGeometrySchlickGGX(NdotV, roughness)   (IBL k = roughness^2 / 2)
//   - iblGeometrySmith(NdotV, NdotL, roughness)
//   - importanceSampleGGX(Xi, N, roughness)
//   - fresnelSchlickRoughness(cosTheta, F0, roughness)
//
// References: LearnOpenGL §6.2 IBL pipeline; Karis 2013 split-sum.

const INV_ATAN: vec2<f32> = vec2<f32>(0.1591, 0.3183);
const PI: f32 = 3.14159265;

// Shared Standard receiver response for diffuse environment and traced D=E/pi.
// Albedo, radiance and occlusion are applied by the consumer exactly once.
fn standardDiffuseWeight(cosTheta: f32, f0: vec3<f32>, roughness: f32, metallic: f32) -> vec3<f32> {
  return (vec3<f32>(1.0) - fresnelSchlickRoughness(cosTheta, f0, roughness)) * (1.0 - metallic);
}

// Map a direction vector to equirectangular UV.
fn sampleSphericalMap(v: vec3<f32>) -> vec2<f32> {
  // Cube-face rasterization can produce a direction whose normalized Y lane
  // is a few ulps outside [-1, 1]. `asin` propagates that rounding error as
  // NaN, poisoning the generated cubemap and every later IBL sample.
  let uv = vec2<f32>(atan2(v.z, v.x), asin(clamp(v.y, -1.0, 1.0)));
  return uv * INV_ATAN + 0.5;
}

// Rotate a sampling direction by the inverse of an environment quaternion.
// This keeps the baked cubemap reusable while rotating the source map in
// world space at the final sampling boundary.
fn inverseRotateEnvironment(direction: vec3<f32>, rotation: vec4<f32>) -> vec3<f32> {
  let q = normalize(rotation);
  let t = 2.0 * cross(q.xyz, direction);
  return direction - q.w * t + cross(q.xyz, t);
}

// Van der Corput radical inverse in base 2.
fn radicalInverseVdC(bits: u32) -> f32 {
  var b: u32 = bits;
  b = (b << 16u) | (b >> 16u);
  b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u);
  b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return f32(b) * 2.3283064365386963e-10;
}

// Hammersley low-discrepancy 2D sequence: (i/N, radicalInverseVdC(i)).
fn hammersley(i: u32, N: u32) -> vec2<f32> {
  return vec2<f32>(f32(i) / f32(N), radicalInverseVdC(i));
}

// GGX NDF.
fn iblDGGX(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let f = (nDotH * a2 - nDotH) * nDotH + 1.0;
  return a2 / (max(PI * f * f, 1e-7));
}

// Smith-GGX G1 for IBL: k = roughness^2 / 2.
// DIFFERENT from direct-light's k = ((roughness+1)^2)/8 (in brdf.wgsl).
fn iblGeometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
  let k = (roughness * roughness) / 2.0;
  return NdotV / max(NdotV * (1.0 - k) + k, 1e-5);
}

// Smith-GGX height-correlated geometry for IBL.
fn iblGeometrySmith(NdotV: f32, NdotL: f32, roughness: f32) -> f32 {
  let ggxV = iblGeometrySchlickGGX(NdotV, roughness);
  let ggxL = iblGeometrySchlickGGX(NdotL, roughness);
  return ggxV * ggxL;
}

// GGX importance sampling: maps uniform 2D sample Xi to a half-vector H
// in the local frame around N.
fn importanceSampleGGX(Xi: vec2<f32>, N: vec3<f32>, roughness: f32) -> vec3<f32> {
  let a = roughness * roughness;

  let phi = 2.0 * PI * Xi.x;
  // The production Hammersley domain is i < N, so Xi.y stays below one.
  // Retain a finite lower bound for callers that provide an endpoint sample
  // directly; this is defensive input handling, not the production NaN fix.
  let denominator = max(1.0 + (a * a - 1.0) * Xi.y, 1e-5);
  let cosTheta = sqrt(max((1.0 - Xi.y) / denominator, 0.0));
  let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));

  // GGX half-vector in tangent space.
  let Ht = vec3<f32>(cos(phi) * sinTheta, sin(phi) * sinTheta, cosTheta);

  // Tangent frame construction (avoids singularity at N parallel to z).
  // WGSL `select(falseVal, trueVal, cond)` returns trueVal when cond is
  // true; the LearnOpenGL reference is `cond ? vec3(0,0,1) : vec3(1,0,0)`.
  // When N is (near-)parallel to z (e.g. the BRDF-LUT canonical frame
  // N = (0,0,1)) we need up = (1,0,0); otherwise up = (0,0,1). Swapping the
  // operands here fixes the brdf-lut bake silently producing all-zero output
  // (cross(up, N) = 0 when up == N, normalize(0) = NaN, GPU flushes to 0).
  let up = select(
    vec3<f32>(1.0, 0.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0),
    abs(N.z) < 0.999,
  );
  let tangent = normalize(cross(up, N));
  let bitangent = cross(N, tangent);

  return normalize(tangent * Ht.x + bitangent * Ht.y + N * Ht.z);
}

// Fresnel-Schlick with roughness dampening for IBL specular.
fn fresnelSchlickRoughness(cosTheta: f32, F0: vec3<f32>, roughness: f32) -> vec3<f32> {
  let oneMinusRough = max(vec3<f32>((1.0 - roughness) * specularF90(F0)), F0);
  let cosineComplement = clamp(1.0 - cosTheta, 0.0, 1.0);
  let squared = cosineComplement * cosineComplement;
  return F0 + (oneMinusRough - F0) * (squared * squared * cosineComplement);
}
