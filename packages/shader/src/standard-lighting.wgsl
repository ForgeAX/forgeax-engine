#define_import_path forgeax_pbr::standard_lighting
#import forgeax_pbr::sky_sh_polynomial::{SkyShPolynomial, evaluateSkyPolynomial}
#import forgeax_pbr::ibl_shared::{inverseRotateEnvironment}
#import forgeax_view::common::{view, lightingChannelsMatch}
#import forgeax_pbr::gbuffer::{projectDeferredReceiverChannels}
#import forgeax_pbr::brdf::{DirectLobes, directLobesRadiance, scaleDirectLobes}
#import forgeax_pbr::ibl_shared::{fresnelSchlickRoughness, standardDiffuseWeight}
#import forgeax_pbr::ibl_sampling::{box_project, projectSpecularRadiance, sampleIblRadiance, environmentScatteringFromDfg, environmentDfg, environmentReflectionDirection}
#import forgeax_view::atmosphere::{view_apply_direct_solar}
#import forgeax_pbr::lighting_directional::{evalDirectionalNoShadowLobes, evalDirectionalShadowFactor}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{evaluateStandardClusterLobes}
#endif

#import forgeax_pbr::pmrem::{samplePmrem}

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
  skySh : SkyShPolynomial,
) -> vec3<f32> {
  let probe = sky.intensity < 0.0;
  let rotation = select(sky.rotation, sky.diffuseRotation, probe);
  let tint = vec3<f32>(sky.colorR, sky.colorG, sky.colorB);
  let scale = select(tint * sky.intensity, sky.diffuseScale.xyz, probe);
  return evaluateSkyPolynomial(skySh, inverseRotateEnvironment(normal, rotation))
    * skylightHemisphereScale(sky, scale, normal);
}

// The host binds one reflection environment per receiver. A negative intensity
// identifies a local capture with optional box projection, using the packed
// center and extents instead of the fallback environment tint and rotation.
fn sampleStandardReflectionRadiance(
  sky : SkylightUniforms, worldPosition : vec3<f32>, reflectionDirection : vec3<f32>, roughness : f32,
  prefilterMap : texture_2d<f32>, prefilterSampler : sampler,
) -> vec3<f32> {
  if (view.fogSky.w >= 1048576.0) { return vec3<f32>(0.0); }
  let tint = vec3<f32>(sky.colorR, sky.colorG, sky.colorB);
  if (sky.intensity < 0.0) {
    var direction = reflectionDirection;
    if (sky.rotation.w > 0.5) {
      direction = box_project(worldPosition, direction, tint, sky.rotation.xyz);
    }
    return samplePmrem(prefilterMap, prefilterSampler, direction, roughness) * (-sky.intensity - 1.0);
  }
  return sampleIblRadiance(reflectionDirection, roughness, sky.rotation, prefilterMap, prefilterSampler)
    * tint * sky.intensity;
}

fn evaluateStandardClearcoatReflection(
  sky : SkylightUniforms, position : vec3<f32>, normal : vec3<f32>, direction : vec3<f32>, roughness : f32,
  prefilterMap : texture_2d<f32>, prefilterSampler : sampler,
#ifdef ENV_BRDF_LUT
  brdfLut : texture_2d<f32>, brdfSampler : sampler,
#endif
) -> vec3<f32> {
  let reflection = environmentReflectionDirection(normal, direction, roughness);
  let radiance = sampleStandardReflectionRadiance(sky, position, reflection, roughness,
    prefilterMap, prefilterSampler);
  return projectSpecularRadiance(radiance, normal, direction, roughness, vec3<f32>(0.04),
#ifdef ENV_BRDF_LUT
    brdfLut, brdfSampler,
#endif
  );
}

struct StandardEnvironment {
  diffuse : vec3<f32>,
  specular : vec3<f32>,
  diffuseWeight : vec3<f32>,
  lowFrequency : vec3<f32>,
  // RGB: directional single scattering; A: energy available to multiple scattering.
  response : vec4<f32>,
};

struct StandardDiffuseIrradiance {
  front : vec3<f32>,
  back : vec3<f32>,
};

fn sampleStandardDiffuseIrradiance(
  sky : SkylightUniforms, normal : vec3<f32>, transmission : vec3<f32>,
  skySh : SkyShPolynomial,
) -> StandardDiffuseIrradiance {
  let front = sampleSkylightDiffuse(sky, normal, skySh);
  var back = vec3<f32>(0.0);
  if (any(transmission > vec3<f32>(0.0))) {
    back = sampleSkylightDiffuse(sky, -normal, skySh);
  }
  return StandardDiffuseIrradiance(front, back);
}

fn evaluateStandardEnvironment(
  worldPosition : vec3<f32>, normal : vec3<f32>, direction : vec3<f32>,
  albedo : vec3<f32>, transmission : vec3<f32>, metallic : f32, roughness : f32, f0 : vec3<f32>, dielectricSpecular : vec4<f32>, metallicF0 : vec3<f32>,
  sky : SkylightUniforms,
  ambientIrradiance : vec3<f32>, irradiance : StandardDiffuseIrradiance,
  prefilterMap : texture_2d<f32>, prefilterSampler : sampler,
#ifdef ENV_BRDF_LUT
  brdfLut : texture_2d<f32>, irradianceSampler : sampler,
#endif
) -> StandardEnvironment {
  let reflectionDirection = environmentReflectionDirection(normal, direction, roughness);
  let specular = sampleStandardReflectionRadiance(sky, worldPosition, reflectionDirection, roughness,
    prefilterMap, prefilterSampler);
  return evaluateStandardEnvironmentFromRadiance(normal, direction, albedo, transmission, metallic, roughness,
    f0, dielectricSpecular, metallicF0, ambientIrradiance, irradiance, specular,
#ifdef ENV_BRDF_LUT
    brdfLut, irradianceSampler,
#endif
  );
}

fn evaluateStandardEnvironmentFromRadiance(
  normal : vec3<f32>, direction : vec3<f32>,
  albedo : vec3<f32>, transmission : vec3<f32>, metallic : f32, roughness : f32, f0 : vec3<f32>,
  dielectricSpecular : vec4<f32>, metallicF0 : vec3<f32>,
  ambientIrradiance : vec3<f32>, irradiance : StandardDiffuseIrradiance,
  specular : vec3<f32>,
#ifdef ENV_BRDF_LUT
  brdfLut : texture_2d<f32>, irradianceSampler : sampler,
#endif
) -> StandardEnvironment {
  let fresnel = fresnelSchlickRoughness(max(dot(normal, direction), 0.0), f0, roughness);
  let ab = environmentDfg(max(dot(normal, direction), 0.001), roughness,
#ifdef ENV_BRDF_LUT
    brdfLut, irradianceSampler,
#endif
  );
  // Fdez-Aguera is nonlinear in F0. Evaluate each material constituent before
  // mixing; the non-metal diffuse term conserves only dielectric scattering.
  let dielectric = environmentScatteringFromDfg(ab, dielectricSpecular.rgb, dielectricSpecular.a);
  let metal = environmentScatteringFromDfg(ab, metallicF0, dielectricSpecular.a);
  let single = mix(dielectric.single, metal.single, metallic);
  let multi = mix(dielectric.multi, metal.multi, metallic);
  let kD = max(vec3<f32>(0.0), vec3<f32>(1.0) - dielectric.single - dielectric.multi) * (1.0 - metallic);
  // Broad multiple scattering follows the same low-frequency irradiance as
  // diffuse and remains independent of the directional reflection signal.
  let diffuseWeight = kD * albedo + select(multi, vec3<f32>(0.0), view.fogSky.w >= 2097152.0);
  let lowFrequency = diffuseWeight * irradiance.front;
  var diffuse = lowFrequency;
  diffuse += ambientIrradiance * albedo * (1.0 - metallic) * 0.3183098861837907;
  // Transmission albedo already carries (1 - metallic).
  diffuse += (vec3<f32>(1.0) - fresnel) * irradiance.back * transmission;
  return StandardEnvironment(diffuse, specular * single, diffuseWeight, lowFrequency,
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
