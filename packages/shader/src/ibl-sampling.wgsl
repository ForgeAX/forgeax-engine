#define_import_path forgeax_pbr::ibl_sampling

// @forgeax/engine-shader - ibl-sampling.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t47).
//
// Runtime IBL sampling helpers consumed by pbr.wgsl. Each helper takes the
// texture + sampler as function arguments rather than declaring its own
// @group/@binding, so the host (pbr.wgsl's @group(1) material BGL,
// Skylight resources at @binding(7..13) per D-5 round-4) owns the
// binding layout and this module composes cleanly anywhere.
//
// Zero @group/@binding declarations -- this is the symmetric counterpart
// to ibl-shared.wgsl for runtime sampling code.
//
// Exports:
//   - sampleIblDiffuse(N, irradianceMap, irradianceSampler)
//   - sampleIblRadiance(reflectionDirection, roughness, rotation, prefilterMap, prefilterSampler)
//   - sampleIblSpecular, specularEnvironmentAlbedo, environmentDfg
//     LUT arguments are present only in ENV_BRDF_LUT programs.
//   - box_project(worldPosition, direction, boxCenter, boxExtents)

#import forgeax_pbr::ibl_shared::{fresnelSchlickRoughness, inverseRotateEnvironment}
#import forgeax_pbr::brdf::{approximateDirectDfg}
#import forgeax_pbr::pmrem::{samplePmrem}

// Sample pre-convolved irradiance from the irradiance cubemap.
// The cube is single-mip, so an explicit level keeps the lookup legal in
// non-uniform control flow (the back-hemisphere diffuse-transmission term).
// Y is negated to compensate for WebGPU's top-left texture origin vs the
// OpenGL convention used during equirect-to-cube render passes.
fn sampleIblDiffuse(
  normal: vec3<f32>,
  rotation: vec4<f32>,
  irradianceMap: texture_cube<f32>,
  irradianceSampler: sampler,
) -> vec3<f32> {
  let rotated = inverseRotateEnvironment(normal, rotation);
  let dir = vec3<f32>(rotated.x, -rotated.y, rotated.z);
  let irradianceEOverPi = textureSampleLevel(irradianceMap, irradianceSampler, dir, 0.0).rgb;
  return irradianceEOverPi;
}

// Three r184 / Fdez-Aguera split-sum energy: the LUT already integrates Fresnel.
// Single scattering follows reflected radiance; inter-microfacet bounces follow
// cosine-weighted irradiance. Keep the two lobes separate so SSR only replaces
// the directional reflection, never the broad multiple-scattering contribution.
struct EnvironmentScattering {
  single : vec3<f32>,
  multi : vec3<f32>,
  missingEnergy : f32,
};

fn environmentMultiScattering(single: vec3<f32>, missingEnergy: f32, F0: vec3<f32>) -> vec3<f32> {
  let favg = F0 + (vec3<f32>(1.0) - F0) * (1.0 / 21.0);
  return single * favg * missingEnergy / max(vec3<f32>(1.0) - missingEnergy * favg, vec3<f32>(1e-6));
}

fn environmentSingleScatteringFromDfg(ab: vec2<f32>, F0: vec3<f32>, F90: f32) -> vec3<f32> {
  return F0 * ab.r + ab.g * F90;
}

fn environmentScatteringFromDfg(ab: vec2<f32>, F0: vec3<f32>, F90: f32) -> EnvironmentScattering {
  let single = environmentSingleScatteringFromDfg(ab, F0, F90);
  let ems = clamp(1.0 - ab.r - ab.g, 0.0, 1.0);
  let multi = environmentMultiScattering(single, ems, F0);
  return EnvironmentScattering(single, multi, ems);
}

// Split-sum environment BRDF as (scale, bias) on F0 / F90.
// All callers share the analytic fit by default.
// Cooked Forward materials can select the preintegrated LUT by setting
// environmentBrdfApprox to false. Direct-light DFG has its own policy.
fn environmentDfg(
  NdotV: f32, roughness: f32,
#ifdef ENV_BRDF_LUT
  brdfLut: texture_2d<f32>, brdfLutSampler: sampler,
#endif
) -> vec2<f32> {
#ifdef ENV_BRDF_LUT
  return textureSampleLevel(brdfLut, brdfLutSampler, vec2<f32>(NdotV, roughness), 0.0).rg;
#else
  return approximateDirectDfg(roughness, NdotV);
#endif
}

fn environmentScattering(
  NdotV: f32, roughness: f32, F0: vec3<f32>,
#ifdef ENV_BRDF_LUT
  brdfLut: texture_2d<f32>, brdfLutSampler: sampler,
#endif
) -> EnvironmentScattering {
  let ab = environmentDfg(NdotV, roughness,
#ifdef ENV_BRDF_LUT
    brdfLut, brdfLutSampler,
#endif
  );
  return environmentScatteringFromDfg(ab, F0, 1.0);
}

fn specularEnvironmentAlbedo(
  NdotV: f32, roughness: f32, F0: vec3<f32>,
#ifdef ENV_BRDF_LUT
  brdfLut: texture_2d<f32>, brdfLutSampler: sampler,
#endif
) -> vec3<f32> {
  let scattering = environmentScattering(NdotV, roughness, F0,
#ifdef ENV_BRDF_LUT
    brdfLut, brdfLutSampler,
#endif
  );
  return scattering.single + scattering.multi;
}

// Directional single-scattering response, shared by environment, probe, SSR and clearcoat.
fn projectSpecularRadiance(
  radiance: vec3<f32>, normal: vec3<f32>, view: vec3<f32>,
  roughness: f32, F0: vec3<f32>,
#ifdef ENV_BRDF_LUT
  brdfLut: texture_2d<f32>, brdfLutSampler: sampler,
#endif
) -> vec3<f32> {
  let NdotV = max(dot(normal, view), 0.001);
  return radiance * environmentScattering(NdotV, roughness, F0,
#ifdef ENV_BRDF_LUT
    brdfLut, brdfLutSampler,
#endif
  ).single;
}

// Three r184 EnvironmentNode: rough surfaces approach the normal instead of
// collecting radiance from behind their tangent plane at grazing view angles.
fn environmentReflectionDirection(normal: vec3<f32>, view: vec3<f32>, roughness: f32) -> vec3<f32> {
  let r2 = roughness * roughness;
  return normalize(mix(reflect(-view, normal), normal, r2 * r2));
}

fn sampleIblRadiance(
  reflectionDirection: vec3<f32>,
  roughness: f32,
  rotation: vec4<f32>,
  prefilterMap: texture_2d<f32>,
  prefilterSampler: sampler,
) -> vec3<f32> {
  let rotated = inverseRotateEnvironment(reflectionDirection, rotation);
  let Rflip = vec3<f32>(rotated.x, -rotated.y, rotated.z);
  let prefilteredColor = samplePmrem(prefilterMap, prefilterSampler, Rflip, roughness);
  return prefilteredColor;
}

fn sampleIblSpecular(
  normal: vec3<f32>, view: vec3<f32>, roughness: f32, F0: vec3<f32>, rotation: vec4<f32>,
  prefilterMap: texture_2d<f32>, prefilterSampler: sampler,
#ifdef ENV_BRDF_LUT
  brdfLut: texture_2d<f32>, brdfLutSampler: sampler,
#endif
) -> vec3<f32> {
  let radiance = sampleIblRadiance(environmentReflectionDirection(normal, view, roughness),
    roughness, rotation, prefilterMap, prefilterSampler);
  return projectSpecularRadiance(radiance, normal, view, roughness, F0,
#ifdef ENV_BRDF_LUT
    brdfLut, brdfLutSampler,
#endif
  );
}

// Project a reflection ray from a point inside a probe box onto the box
// boundary. The helper is binding-free so the scene table and the material
// resource projection remain owned by the host record stage.
fn box_project(
  worldPosition: vec3<f32>,
  direction: vec3<f32>,
  boxCenter: vec3<f32>,
  boxExtents: vec3<f32>,
) -> vec3<f32> {
  let safeExtents = max(boxExtents, vec3<f32>(0.0001));
  if (any(abs(worldPosition - boxCenter) >= safeExtents)) { return normalize(direction); }
  let safeDirection = select(
    select(vec3<f32>(-0.0001), vec3<f32>(0.0001), direction >= vec3<f32>(0.0)),
    direction,
    abs(direction) >= vec3<f32>(0.0001),
  );
  let localPosition = worldPosition - boxCenter;
  let edgeSign = select(vec3<f32>(-1.0), vec3<f32>(1.0), direction >= vec3<f32>(0.0));
  let edge = edgeSign * safeExtents;
  let distances = (edge - localPosition) / safeDirection;
  let travel = min(distances.x, min(distances.y, distances.z));
  return normalize(localPosition + direction * max(travel, 0.0));
}
