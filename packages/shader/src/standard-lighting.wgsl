#define_import_path forgeax_pbr::standard_lighting
#import forgeax_view::common::{view, lightingChannelsMatch}
#import forgeax_pbr::ibl_shared::{fresnelSchlickRoughness, standardDiffuseWeight}
#import forgeax_pbr::ibl_sampling::{decodeSpecularEnvironmentScale, sampleIblDiffuse, sampleIblSpecular, sampleReflectionProbeSpecular, projectSpecularRadiance}
#import forgeax_pbr::lighting_probe::{evaluateProbeDiffuse}
#import forgeax_view::atmosphere::{view_apply_direct_solar}
#import forgeax_pbr::lighting_directional::{evalDirectionalNoShadow, evalDirectionalShadowFactor}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{evaluateStandardClusterLights}
#endif

struct SkylightUniforms {
  intensity : f32,
  // Scalar tint lanes preserve the 64-byte host uniform layout.
  colorR : f32,
  colorG : f32,
  colorB : f32,
  rotation : vec4<f32>,
  // xyz: global diffuse scale; w: deferred reflection environment index.
  diffuseScale : vec4<f32>,
  diffuseRotation : vec4<f32>,
};

struct StandardEnvironment {
  diffuse : vec3<f32>,
  specular : vec3<f32>,
  response : vec3<f32>,
};

fn evaluateStandardEnvironment(
  worldPosition : vec3<f32>, normal : vec3<f32>, direction : vec3<f32>,
  albedo : vec3<f32>, transmission : vec3<f32>, metallic : f32, roughness : f32, f0 : vec3<f32>,
  sky : SkylightUniforms,
  irradianceMap : texture_cube<f32>, irradianceSampler : sampler,
  prefilterMap : texture_cube<f32>, prefilterSampler : sampler,
  brdfLut : texture_2d<f32>, skylightPrefilterMap : texture_cube<f32>,
  sh : array<vec4<f32>, 9>, localBlend : f32,
) -> StandardEnvironment {
  var irradiance : vec3<f32>;
  var specular : vec3<f32>;
  if (sky.intensity < 0.0) {
    irradiance = sampleIblDiffuse(normal, sky.diffuseRotation, irradianceMap, irradianceSampler);
    specular = sampleReflectionProbeSpecular(
      normal, direction, roughness, f0, worldPosition,
      vec3<f32>(sky.colorR, sky.colorG, sky.colorB), sky.rotation.xyz,
      vec4<f32>(0.0, 0.0, 0.0, 1.0), prefilterMap, prefilterSampler,
      brdfLut, irradianceSampler, skylightPrefilterMap, sky.diffuseRotation,
      sky.diffuseScale.xyz, max(-sky.intensity - 1.0, 0.0), sky.rotation.w > 0.5,
    );
  } else {
    irradiance = sampleIblDiffuse(normal, sky.rotation, irradianceMap, irradianceSampler);
    specular = sampleIblSpecular(normal, direction, roughness, f0,
      sky.rotation, prefilterMap, prefilterSampler, brdfLut, irradianceSampler);
  }
  let tint = vec3<f32>(sky.colorR, sky.colorG, sky.colorB);
  let diffuseScale = select(tint * sky.intensity, sky.diffuseScale.xyz, sky.intensity < 0.0);
  let fresnel = fresnelSchlickRoughness(max(dot(normal, direction), 0.0), f0, roughness);
  let kD = standardDiffuseWeight(max(dot(normal, direction), 0.0), f0, roughness, metallic);
  var diffuse = kD * irradiance * albedo * diffuseScale;
  if (localBlend > 0.0) {
    diffuse = evaluateProbeDiffuse(sh, localBlend, normal, irradiance * diffuseScale,
      kD / max(vec3<f32>(1.0 - metallic), vec3<f32>(0.0001)), albedo, metallic);
  }
  // Diffuse transmission gathers irradiance arriving on the opposite
  // hemisphere (Unreal's two-sided foliage sky term samples at -N). The
  // albedo already carries (1 - metallic), so only the Fresnel gate remains.
  if (any(transmission > vec3<f32>(0.0))) {
    let rotation = select(sky.rotation, sky.diffuseRotation, sky.intensity < 0.0);
    let backIrradiance = sampleIblDiffuse(-normal, rotation, irradianceMap, irradianceSampler);
    let backFresnel = vec3<f32>(1.0) - fresnel;
    if (localBlend > 0.0) {
      diffuse += evaluateProbeDiffuse(sh, localBlend, -normal, backIrradiance * diffuseScale,
        backFresnel, transmission, 0.0);
    } else {
      diffuse += backFresnel * backIrradiance * transmission * diffuseScale;
    }
  }
  return StandardEnvironment(diffuse, specular * decodeSpecularEnvironmentScale(tint, sky.intensity),
    projectSpecularRadiance(vec3<f32>(1.0), normal, direction, roughness, f0, brdfLut, irradianceSampler));
}

struct StandardDirect {
  radiance : vec3<f32>,
  diffuse : vec3<f32>,
};

fn evaluateStandardDirect(
  worldPosition : vec3<f32>, ndc : vec3<f32>, viewZ : f32,
  normal : vec3<f32>, direction : vec3<f32>, albedo : vec3<f32>,
  transmission : vec3<f32>, metallic : f32, alpha : f32, f0 : vec3<f32>, shadow : f32,
  receiveShadows : bool, receiverChannels : u32, splitDiffuse : bool,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> StandardDirect {
  var direct = vec3<f32>(0.0);
  if (lightingChannelsMatch(view.lightingChannels, receiverChannels)) {
    direct = view_apply_direct_solar(view, shadow * evalDirectionalNoShadow(normal, direction, albedo, metallic, alpha, f0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  ), worldPosition);
  }
#ifdef CLUSTER_FORWARD_AVAILABLE
  direct += evaluateStandardClusterLights(ndc, viewZ, worldPosition, normal, direction,
    albedo, metallic, alpha, f0, transmission, false, receiveShadows, receiverChannels,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
#endif
  var diffuse = vec3<f32>(0.0);
  if (splitDiffuse) {
    // The shared BRDF is affine in albedo. Its zero-albedo result retains
    // specular, using exactly the same solar, shadow and receiver-channel gates.
    var specular = vec3<f32>(0.0);
    if (lightingChannelsMatch(view.lightingChannels, receiverChannels)) {
      specular = view_apply_direct_solar(view, shadow * evalDirectionalNoShadow(normal, direction, vec3<f32>(0.0), metallic, alpha, f0, transmission,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  ), worldPosition);
    }
#ifdef CLUSTER_FORWARD_AVAILABLE
    specular += evaluateStandardClusterLights(ndc, viewZ, worldPosition, normal, direction,
      vec3<f32>(0.0), metallic, alpha, f0, transmission, false, receiveShadows, receiverChannels,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
#endif
    diffuse = direct - specular;
  }
  return StandardDirect(direct, diffuse);
}
