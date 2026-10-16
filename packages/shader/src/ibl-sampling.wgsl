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
//   - sampleIblSpecular(N, V, roughness, F0, prefilterMap, prefilterSampler,
//                       brdfLut, brdfLutSampler)
//   - specularEnvironmentAlbedo(NdotV, roughness, F0, brdfLut, brdfLutSampler)
//   - box_project(worldPosition, direction, boxCenter, boxExtents)
//   - sampleReflectionProbeSpecular(..., probeMap, probeSampler, ...)

#import forgeax_pbr::ibl_shared::{fresnelSchlickRoughness, inverseRotateEnvironment}
#import forgeax_pbr::brdf::{specularF90}

// Decode the renderer's Skylight/probe scalar without touching the probe box
// metadata carried in the color lanes. A negative intensity is the
// ReflectionProbe sentinel `-(probeIntensity + 1)` selects a helper that has
// already combined probe intensity and the global Skylight boundary fallback.
// Ordinary Skylights still apply their linear RGB tint and intensity here.
fn decodeSpecularEnvironmentScale(
  skyColor: vec3<f32>,
  intensity: f32,
) -> vec3<f32> {
  return select(
    skyColor * intensity,
    vec3<f32>(1.0),
    intensity < 0.0,
  );
}

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

// Directional albedo of the GGX specular lobe including multiple scattering
// (Fdez-Aguera 2019, "A Multiple-Scattering Microfacet Model for Real-Time
// Image Based Lighting", JCGT 8(1):3; Three r184 computeMultiscattering).
// Single scattering loses 1 - Ess of the energy to inter-microfacet bounces,
// which darkens rough metals. The bounce series is closed-form in the
// split-sum pair already fetched for single scattering, so compensation needs
// no second table, binding, or sample. The multi-scatter energy rides the same
// lobe as single scattering (UE ShadingEnergyConservation style) instead of
// the paper's irradiance term, so Skylight, ReflectionProbe, SSR response and
// clearcoat stay on one source-independent weight.
fn specularEnvironmentAlbedo(
  NdotV: f32, roughness: f32, F0: vec3<f32>, brdfLut: texture_2d<f32>, brdfLutSampler: sampler,
) -> vec3<f32> {
  // The preintegrated LUT has one level; explicit LOD remains valid when the
  // Standard evaluator is selected by a non-uniform particle control path.
  let envBRDF = textureSampleLevel(brdfLut, brdfLutSampler, vec2<f32>(NdotV, roughness), 0.0).rg;
  let fssEss = fresnelSchlickRoughness(NdotV, F0, roughness) * envBRDF.r + envBRDF.g * specularF90(F0);
  let ems = clamp(1.0 - envBRDF.r - envBRDF.g, 0.0, 1.0);
  let favg = F0 + (vec3<f32>(specularF90(F0)) - F0) * (1.0 / 21.0);
  let fms = fssEss * favg / (vec3<f32>(1.0) - ems * favg);
  return fssEss + fms * ems;
}

// Split-sum specular IBL: prefiltered env * multi-scatter directional albedo.
fn projectSpecularRadiance(
  radiance: vec3<f32>, normal: vec3<f32>, view: vec3<f32>,
  roughness: f32, F0: vec3<f32>, brdfLut: texture_2d<f32>, brdfLutSampler: sampler,
) -> vec3<f32> {
  let NdotV = max(dot(normal, view), 0.001);
  return radiance * specularEnvironmentAlbedo(NdotV, roughness, F0, brdfLut, brdfLutSampler);
}

fn sampleIblSpecular(
  normal: vec3<f32>,
  view: vec3<f32>,
  roughness: f32,
  F0: vec3<f32>,
  rotation: vec4<f32>,
  prefilterMap: texture_cube<f32>,
  prefilterSampler: sampler,
  brdfLut: texture_2d<f32>,
  brdfLutSampler: sampler,
) -> vec3<f32> {
  let NdotV = max(dot(normal, view), 0.001);
  let R = reflect(-view, normal);
  let rotated = inverseRotateEnvironment(R, rotation);
  let Rflip = vec3<f32>(rotated.x, -rotated.y, rotated.z);
  let mip = roughness * 4.0;
  let prefilteredColor = textureSampleLevel(prefilterMap, prefilterSampler, Rflip, mip).rgb;
  return projectSpecularRadiance(prefilteredColor, normal, view, roughness, F0, brdfLut, brdfLutSampler);
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

// Split-sum probe sample. The probe texture is supplied by the caller so a
// missing scene candidate can keep using sampleIblSpecular with the Skylight
// resources already present in the Standard material layout.
fn sampleReflectionProbeSpecular(
  normal: vec3<f32>,
  view: vec3<f32>,
  roughness: f32,
  F0: vec3<f32>,
  worldPosition: vec3<f32>,
  boxCenter: vec3<f32>,
  boxExtents: vec3<f32>,
  rotation: vec4<f32>,
  probeMap: texture_cube<f32>,
  probeSampler: sampler,
  brdfLut: texture_2d<f32>,
  brdfLutSampler: sampler,
  skylightMap: texture_cube<f32>,
  skylightRotation: vec4<f32>,
  skylightScale: vec3<f32>,
  probeIntensity: f32,
  boxProjection: bool,
) -> vec3<f32> {
  // Selection is per draw, but a receiver can extend beyond that probe's box.
  // Only the interior admits parallax correction. Keep global specular IBL
  // resident and blend the outer 10% of the box into its real Skylight source.
  let relative = abs(worldPosition - boxCenter) / max(boxExtents, vec3<f32>(0.0001));
  let weight = smoothstep(0.0, 0.1, 1.0 - max(relative.x, max(relative.y, relative.z)));
  var sky = vec3<f32>(0.0);
  if (weight < 1.0) {
    sky = sampleIblSpecular(normal, view, roughness, F0, skylightRotation,
      skylightMap, probeSampler, brdfLut, brdfLutSampler) * skylightScale;
  }
  if (weight <= 0.0) { return sky; }
  let NdotV = max(dot(normal, view), 0.001);
  let reflection = reflect(-view, normal);
  var projected = reflection;
  if (boxProjection) { projected = box_project(worldPosition, reflection, boxCenter, boxExtents); }
  let rotated = inverseRotateEnvironment(projected, rotation);
  // Runtime cube cameras capture world-space faces directly. The image IBL
  // bake's Y convention does not apply to these captures.
  let probeDirection = rotated;
  let mip = roughness * 4.0;
  let prefilteredColor = textureSampleLevel(probeMap, probeSampler, probeDirection, mip).rgb;
  let local = projectSpecularRadiance(prefilteredColor, normal, view, roughness, F0, brdfLut, brdfLutSampler) * probeIntensity;
  return mix(sky, local, weight);
}
