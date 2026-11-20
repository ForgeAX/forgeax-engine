#define_import_path forgeax_pbr::standard_lighting
#import forgeax_view::common::{view, lightingChannelsMatch}
#import forgeax_pbr::gbuffer::{projectDeferredReceiverChannels}
#import forgeax_pbr::brdf::{DirectLobes, directLobesRadiance, scaleDirectLobes}
#import forgeax_pbr::ibl_shared::{fresnelSchlickRoughness, standardDiffuseWeight}
#import forgeax_pbr::ibl_sampling::{decodeSpecularEnvironmentScale, sampleIblDiffuse, sampleIblRadiance, sampleReflectionProbeRadiance, environmentScatteringFromDfg, environmentDfg, environmentReflectionDirection}
#import forgeax_pbr::lighting_probe::{evaluateProbeDiffuse}
#import forgeax_view::atmosphere::{view_apply_direct_solar}
#import forgeax_pbr::lighting_directional::{evalDirectionalNoShadowLobes, evalDirectionalShadowFactor}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{evaluateStandardClusterLobes}
#endif

struct SkylightUniforms {
  intensity : f32,
  // Scalar tint lanes preserve the host uniform offsets.
  colorR : f32,
  colorG : f32,
  colorB : f32,
  rotation : vec4<f32>,
  // xyz: global diffuse scale; w: deferred reflection environment index.
  diffuseScale : vec4<f32>,
  diffuseRotation : vec4<f32>,
  ambientIrradiance : vec4<f32>,
  // xyz: downward diffuse scale (groundColor * intensity); w > 0.5 enables the hemisphere.
  ground : vec4<f32>,
};

// Hemisphere ambient (Three.js HemisphereLight): lerp the downward ground scale
// to the sky scale by world normal.y. Disabled, the sky scale is uniform.
fn skylightHemisphereScale(sky : SkylightUniforms, skyScale : vec3<f32>, normal : vec3<f32>) -> vec3<f32> {
  return select(skyScale, mix(sky.ground.xyz, skyScale, normal.y * 0.5 + 0.5), sky.ground.w > 0.5);
}

fn sampleSkylightDiffuse(
  sky : SkylightUniforms, normal : vec3<f32>,
  irradianceMap : texture_cube<f32>, irradianceSampler : sampler,
) -> vec3<f32> {
  let probe = sky.intensity < 0.0;
  let rotation = select(sky.rotation, sky.diffuseRotation, probe);
  let tint = vec3<f32>(sky.colorR, sky.colorG, sky.colorB);
  let scale = select(tint * sky.intensity, sky.diffuseScale.xyz, probe);
  return sampleIblDiffuse(normal, rotation, irradianceMap, irradianceSampler)
    * skylightHemisphereScale(sky, scale, normal);
}

fn sampleSkylightRadiance(
  sky : SkylightUniforms, worldPosition : vec3<f32>, reflectionDirection : vec3<f32>, roughness : f32,
  prefilterMap : texture_2d<f32>, prefilterSampler : sampler, skylightPrefilterMap : texture_2d<f32>,
) -> vec3<f32> {
  let tint = vec3<f32>(sky.colorR, sky.colorG, sky.colorB);
  if (sky.intensity < 0.0) {
    return sampleReflectionProbeRadiance(
      reflectionDirection, roughness, worldPosition, tint, sky.rotation.xyz,
      vec4<f32>(0.0, 0.0, 0.0, 1.0), prefilterMap, prefilterSampler,
      skylightPrefilterMap, sky.diffuseRotation, sky.diffuseScale.xyz,
      max(-sky.intensity - 1.0, 0.0), sky.rotation.w > 0.5,
    );
  }
  return sampleIblRadiance(reflectionDirection, roughness, sky.rotation, prefilterMap, prefilterSampler)
    * decodeSpecularEnvironmentScale(tint, sky.intensity);
}

struct StandardEnvironment {
  diffuse : vec3<f32>,
  specular : vec3<f32>,
  // RGB: directional single scattering; A: energy available to multiple scattering.
  response : vec4<f32>,
};

fn evaluateStandardEnvironment(
  worldPosition : vec3<f32>, normal : vec3<f32>, direction : vec3<f32>,
  albedo : vec3<f32>, transmission : vec3<f32>, metallic : f32, roughness : f32, f0 : vec3<f32>, dielectricSpecular : vec4<f32>, metallicF0 : vec3<f32>,
  sky : SkylightUniforms,
  irradianceMap : texture_cube<f32>, irradianceSampler : sampler,
  prefilterMap : texture_2d<f32>, prefilterSampler : sampler,
  brdfLut : texture_2d<f32>, skylightPrefilterMap : texture_2d<f32>,
  sh : array<vec4<f32>, 9>, localBlend : f32,
) -> StandardEnvironment {
  let reflectionDirection = environmentReflectionDirection(normal, direction, roughness);
  let specular = sampleSkylightRadiance(sky, worldPosition, reflectionDirection, roughness,
    prefilterMap, prefilterSampler, skylightPrefilterMap);
  return evaluateStandardEnvironmentFromRadiance(normal, direction, albedo, transmission, metallic, roughness,
    f0, dielectricSpecular, metallicF0, sky, irradianceMap, irradianceSampler, brdfLut, sh, localBlend, specular);
}

fn evaluateStandardEnvironmentFromRadiance(
  normal : vec3<f32>, direction : vec3<f32>,
  albedo : vec3<f32>, transmission : vec3<f32>, metallic : f32, roughness : f32, f0 : vec3<f32>,
  dielectricSpecular : vec4<f32>, metallicF0 : vec3<f32>,
  sky : SkylightUniforms, irradianceMap : texture_cube<f32>, irradianceSampler : sampler, brdfLut : texture_2d<f32>,
  sh : array<vec4<f32>, 9>, localBlend : f32, specular : vec3<f32>,
) -> StandardEnvironment {
  let irradiance = sampleSkylightDiffuse(sky, normal, irradianceMap, irradianceSampler);
  let fresnel = fresnelSchlickRoughness(max(dot(normal, direction), 0.0), f0, roughness);
  let ab = environmentDfg(max(dot(normal, direction), 0.001), roughness, brdfLut, irradianceSampler);
  // Fdez-Aguera is nonlinear in F0. Evaluate each material constituent before
  // mixing; the non-metal diffuse term conserves only dielectric scattering.
  let dielectric = environmentScatteringFromDfg(ab, dielectricSpecular.rgb, dielectricSpecular.a);
  let metal = environmentScatteringFromDfg(ab, metallicF0, dielectricSpecular.a);
  let single = mix(dielectric.single, metal.single, metallic);
  let multi = mix(dielectric.multi, metal.multi, metallic);
  let kD = max(vec3<f32>(0.0), vec3<f32>(1.0) - dielectric.single - dielectric.multi) * (1.0 - metallic);
  var diffuse = kD * irradiance * albedo;
  if (localBlend > 0.0) {
    diffuse = evaluateProbeDiffuse(sh, localBlend, normal, irradiance,
      kD / max(vec3<f32>(1.0 - metallic), vec3<f32>(0.0001)), albedo, metallic);
  }
  // Multiple scattering uses the diffuse angular distribution, including local SH.
  // Keeping it outside the directional response preserves it on an SSR hit.
  var multiIrradiance = irradiance;
  if (localBlend > 0.0) {
    multiIrradiance = evaluateProbeDiffuse(sh, localBlend, normal, multiIrradiance,
      vec3<f32>(1.0), vec3<f32>(1.0), 0.0);
  }
  diffuse += multi * multiIrradiance;
  diffuse += sky.ambientIrradiance.xyz * albedo * (1.0 - metallic) * 0.3183098861837907;
  // Diffuse transmission gathers irradiance arriving on the opposite
  // hemisphere (Unreal's two-sided foliage sky term samples at -N). The
  // albedo already carries (1 - metallic), so only the Fresnel gate remains.
  if (any(transmission > vec3<f32>(0.0))) {
    let backIrradiance = sampleSkylightDiffuse(sky, -normal, irradianceMap, irradianceSampler);
    let backFresnel = vec3<f32>(1.0) - fresnel;
    if (localBlend > 0.0) {
      diffuse += evaluateProbeDiffuse(sh, localBlend, -normal, backIrradiance,
        backFresnel, transmission, 0.0);
    } else {
      diffuse += backFresnel * backIrradiance * transmission;
    }
  }
  return StandardEnvironment(diffuse, specular * single,
    vec4<f32>(single, dielectric.missingEnergy));
}

struct StandardDirect {
  radiance : vec3<f32>,
  diffuse : vec3<f32>,
};

// Direct lighting evaluates each light once and accumulates its components.
// Forward consumes their sum; Deferred SSS also consumes reflected diffuse.
fn evaluateStandardDirectLobes(
  worldPosition : vec3<f32>, ndc : vec3<f32>, viewZ : f32, pixel : vec2<f32>,
  normal : vec3<f32>, direction : vec3<f32>, albedo : vec3<f32>,
  transmission : vec3<f32>, metallic : f32, alpha : f32, f0 : vec3<f32>, shadow : f32,
  receiveShadows : bool, receiverChannels : u32,
  sunChannels : u32, projectedChannels : bool,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> DirectLobes {
  var direct = DirectLobes(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
  if (lightingChannelsMatch(sunChannels, receiverChannels)) {
    let solar = evalDirectionalNoShadowLobes(normal, direction, albedo, metallic, alpha, f0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
    let solarFactor = view_apply_direct_solar(view, vec3<f32>(shadow), worldPosition);
    direct = scaleDirectLobes(solar, solarFactor);
  }
#ifdef CLUSTER_FORWARD_AVAILABLE
  let local = evaluateStandardClusterLobes(ndc, pixel, viewZ, worldPosition, normal, direction,
    albedo, metallic, alpha, f0, transmission, false, receiveShadows, receiverChannels, projectedChannels,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  direct.radiance += local.radiance;
  direct.diffuse += local.diffuse;
  direct.specular += local.specular;
#endif
  return direct;
}

fn evaluateStandardDirect(
  worldPosition : vec3<f32>, ndc : vec3<f32>, viewZ : f32, pixel : vec2<f32>,
  normal : vec3<f32>, direction : vec3<f32>, albedo : vec3<f32>,
  transmission : vec3<f32>, metallic : f32, alpha : f32, f0 : vec3<f32>, shadow : f32,
  receiveShadows : bool, receiverChannels : u32,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> StandardDirect {
  let lobes = evaluateStandardDirectLobes(worldPosition, ndc, viewZ, pixel, normal, direction, albedo, transmission, metallic, alpha, f0, shadow, receiveShadows, receiverChannels, view.lightingChannels, false, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
);
  return StandardDirect(directLobesRadiance(lobes), vec3<f32>(0.0));
}

// Deferred variant: `splitDiffuse` is a per-pixel G-buffer fact there.
fn evaluateStandardDirectSplit(
  worldPosition : vec3<f32>, ndc : vec3<f32>, viewZ : f32, pixel : vec2<f32>,
  normal : vec3<f32>, direction : vec3<f32>, albedo : vec3<f32>,
  transmission : vec3<f32>, metallic : f32, alpha : f32, f0 : vec3<f32>, shadow : f32,
  receiveShadows : bool, receiverChannels : u32, splitDiffuse : bool,
  channelProjection : u32, channelsAlreadyPacked : bool,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> StandardDirect {
  let projectedChannels = channelProjection != 0u;
  let packedChannels = select(receiverChannels, projectDeferredReceiverChannels(receiverChannels, channelProjection), projectedChannels && !channelsAlreadyPacked);
  let sunChannels = select(view.lightingChannels, (channelProjection >> 17u) & 7u, projectedChannels);
  let lobes = evaluateStandardDirectLobes(worldPosition, ndc, viewZ, pixel, normal, direction, albedo, transmission, metallic, alpha, f0, shadow, receiveShadows, packedChannels, sunChannels, projectedChannels, useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
);
  return StandardDirect(select(directLobesRadiance(lobes), lobes.specular, splitDiffuse),
    select(vec3<f32>(0.0), lobes.diffuse, splitDiffuse));
}
