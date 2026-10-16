#define_import_path forgeax_pbr::brdf

// @forgeax/engine-shader - brdf.wgsl (M5 T-18 feat-20260512-naga-oil-composition-hmr).
//
// Cook-Torrance BRDF helpers (D_GGX + V_SmithCorrelated + F_Schlick)
// extracted from pbr.wgsl via naga_oil #define_import_path / #import
// (D-04 moduleId convention). Pure helpers, no bindings or host state -
// safe to reuse from any material shader that needs microfacet specular.

fn d_ggx(nDotH : f32, a : f32) -> f32 {
  let a2 = a * a;
  let f = (nDotH * a2 - nDotH) * nDotH + 1.0;
  return a2 / (3.14159265 * f * f);
}

fn v_smith(nDotV : f32, nDotL : f32, a : f32) -> f32 {
  let a2 = a * a;
  let gv = nDotL * sqrt(nDotV * nDotV * (1.0 - a2) + a2);
  let gl = nDotV * sqrt(nDotL * nDotL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

// Grazing reflectance derived from F0 (Unreal's specular occlusion). No real
// material has F0 below 2%, so a smaller value means authored "no specular":
// the grazing lobe fades with it and `specular: 0` becomes pure Lambert.
// F0 >= 0.02 keeps F90 = 1, so physically based inputs are unchanged, and
// deferred lighting derives it from the stored F0 without a new channel.
fn specularF90(f0 : vec3<f32>) -> f32 {
  return saturate(50.0 * max(f0.r, max(f0.g, f0.b)));
}

fn f_schlick(vDotH : f32, f0 : vec3<f32>) -> vec3<f32> {
  let fresnel = exp2((-5.55473 * vDotH - 6.98316) * vDotH);
  return f0 + (vec3<f32>(specularF90(f0)) - f0) * fresnel;
}


// EnvBRDFApproxLazarov, UE 5.8.1 BRDF.ush:610-623, KB source commit
// 71fe36aac5a8df5ccd66c763ffc902b29b6a9c43. Inputs use perceptual roughness.
// Engine adaptation: retain the fitted A+B energy while making both channels
// nonnegative. F90 and the multiple-scatter combination remain caller-owned.
fn approximateDirectDfg(roughness: f32, nDotV: f32) -> vec2<f32> {
  let uv = clamp(vec2<f32>(roughness, nDotV), vec2<f32>(0.0), vec2<f32>(1.0));
  let r = uv.x * vec4<f32>(-1.0, -0.0275, -0.572, 0.022)
    + vec4<f32>(1.0, 0.0425, 1.04, -0.04);
  let a004 = min(r.x * r.x, exp2(-9.28 * uv.y)) * r.x + r.y;
  let energy = 1.0 - 0.55 * uv.x;
  let bias = clamp(1.04 * a004 + r.w, 0.0, energy);
  return vec2<f32>(energy - bias, bias);
}

// The optional texture contains the original Three r184 RG16F scale/bias
// values. The resource owner supplies linear, clamp-to-edge sampling.
fn sampleDirectDfg(roughness: f32, nDotV: f32, useLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec2<f32> {
#ifdef DIRECT_DFG_LUT_AVAILABLE
  if (useLut) {
    return textureSampleLevel(directDfgLut, directDfgSampler,
      clamp(vec2<f32>(roughness, nDotV), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rg;
  }
#endif
  return approximateDirectDfg(roughness, nDotV);
}

fn directMultiScatter(
  roughness : f32,
  nDotV     : f32,
  nDotL     : f32,
  F0        : vec3<f32>,
  useLut    : bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let dfgV = sampleDirectDfg(roughness, nDotV, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  let dfgL = sampleDirectDfg(roughness, nDotL, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  let f90 = specularF90(F0);
  let fssEssV = F0 * dfgV.x + vec3<f32>(dfgV.y * f90);
  let fssEssL = F0 * dfgL.x + vec3<f32>(dfgL.y * f90);
  // The fit's exact identity A+B=1-0.55*roughness avoids cancellation at
  // zero roughness. The optional LUT retains its original sampled energy.
  var emsV = 0.55 * clamp(roughness, 0.0, 1.0);
  var emsL = emsV;
#ifdef DIRECT_DFG_LUT_AVAILABLE
  if (useLut) {
    emsV = 1.0 - dfgV.x - dfgV.y;
    emsL = 1.0 - dfgL.x - dfgL.y;
  }
#endif
  let favg = F0 + (vec3<f32>(f90) - F0) * 0.047619;
  let energyLoss = emsV * emsL;
  let fms = fssEssV * fssEssL * favg
    / (vec3<f32>(1.0) - energyLoss * favg * favg + vec3<f32>(1e-6));
  return fms * energyLoss;
}

// One evaluation for raster direct lighting and the opaque reference integrator.
// Preserves Standard's existing additive Lambert + GGX/multiple-scatter convention.
fn standardOpaqueBrdf(baseColor: vec3<f32>, metallic: f32, alpha: f32, f0: vec3<f32>,
  nDotV: f32, nDotL: f32, nDotH: f32, vDotH: f32, useLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let specular = d_ggx(nDotH, alpha) * v_smith(nDotV, nDotL, alpha) * f_schlick(vDotH, f0)
    + directMultiScatter(sqrt(max(alpha, 0.0)), nDotV, nDotL, f0, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
      directDfgLut, directDfgSampler,
#endif
    );
  return (1.0 - metallic) * baseColor / 3.14159265 + specular;
}

fn standardDielectricF0(ior: f32) -> f32 {
  let ratio = (ior - 1.0) / (ior + 1.0);
  return ratio * ratio;
}

fn standardOpaqueF0FromDielectric(albedo: vec3<f32>, metallic: f32, specularColor: vec3<f32>, specular: f32, dielectric: f32) -> vec3<f32> {
  return mix(vec3<f32>(dielectric) * specularColor * specular, albedo, metallic);
}

fn standardOpaqueF0(albedo: vec3<f32>, metallic: f32, specularColor: vec3<f32>, specular: f32, ior: f32) -> vec3<f32> {
  return standardOpaqueF0FromDielectric(albedo, metallic, specularColor, specular, standardDielectricF0(ior));
}
