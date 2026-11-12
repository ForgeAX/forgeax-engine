#define_import_path forgeax_pbr::brdf

// @forgeax/engine-shader - brdf.wgsl (M5 T-18 feat-20260512-naga-oil-composition-hmr).
//
// Cook-Torrance BRDF helpers (D_GGX + V_SmithCorrelated + F_Schlick)
// extracted from pbr.wgsl via naga_oil #define_import_path / #import
// (D-04 moduleId convention). Pure helpers, no bindings or host state -
// safe to reuse from any material shader that needs microfacet specular.

// N.H and V.H from dot products, the way Unreal builds its BxDF context:
// UE 5.8.1 BRDF.ush:24-31 (Init). With |V+L|^2 = 2 + 2 V.L the half vector never
// needs to be materialised: InvLenH = rsqrt(2 + 2 V.L), N.H = (N.L + N.V) *
// InvLenH and V.H = InvLenH + InvLenH * V.L. Inputs are the signed cosines (N.L
// and N.V unclamped). The 1e-8 floor keeps V = -L finite where Unreal divides by
// zero; it equals the old `max(dot(h, h), 1e-8)` bound on the unnormalised half
// vector. Returns (N.H, V.H), both saturated as in Unreal.
fn halfVectorTerms(nDotL : f32, nDotV : f32, vDotL : f32) -> vec2<f32> {
  let invLenH = inverseSqrt(max(2.0 + 2.0 * vDotL, 1e-8));
  return vec2<f32>(saturate((nDotL + nDotV) * invLenH), saturate(invLenH + invLenH * vDotL));
}

// Direct-lighting roughness floor. Unreal sets View.MinRoughness =
// clamp(r.MinRoughnessOverride, 0.02, 1) (SceneView.cpp:2921) and applies it to
// the roughness of every direct light before the BRDF is evaluated
// (CapsuleLightIntegrate.ush:110, MegaLightsMaterial.ush:140, Substrate.ush:3418),
// never to the environment lobe. The engine has no per-view override, so the
// default 0.02 is a constant. Callers hold alpha = roughness^2, hence the
// squared bound. Without it a roughness-0 receiver puts D(N.H = 1) = 1 / (pi *
// alpha^2) on a single texel, which a sub-pixel normal ripple turns into a glint.
const DIRECT_MIN_ROUGHNESS : f32 = 0.02;
fn directLightingAlpha(alpha : f32) -> f32 {
  return max(alpha, DIRECT_MIN_ROUGHNESS * DIRECT_MIN_ROUGHNESS);
}

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

// Light-independent half of directMultiScatter, evaluated once per pixel by
// light loops (Three's multiScatteringCompensation and UE's EnvBRDF are also
// per-pixel). The values are the exact subexpressions directMultiScatter
// computes for the view direction, so directMultiScatterFromView reproduces
// its result per light with only the light-side fit (UE BRDF.ush:610).
struct DirectMultiScatterView {
  fssEssV : vec3<f32>,
  favg : vec3<f32>,
  // Non-LUT fit only: the light-independent energy loss and denominator.
  energyLoss : f32,
  denominator : vec3<f32>,
  emsV : f32,
  f90Lane : f32,
  roughness : f32,
  nDotV : f32,
};

fn prepareDirectMultiScatterView(
  alpha     : f32,
  nDotV     : f32,
  F0        : vec3<f32>,
  useLut    : bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> DirectMultiScatterView {
  let roughness = sqrt(max(alpha, 0.0));
  let dfgV = sampleDirectDfg(roughness, nDotV, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  let f90 = specularF90(F0);
  let fssEssV = F0 * dfgV.x + vec3<f32>(dfgV.y * f90);
  var emsV = 0.55 * clamp(roughness, 0.0, 1.0);
#ifdef DIRECT_DFG_LUT_AVAILABLE
  if (useLut) {
    emsV = 1.0 - dfgV.x - dfgV.y;
  }
#endif
  let favg = F0 + (vec3<f32>(f90) - F0) * 0.047619;
  // Without the LUT emsL == emsV, so the loss and denominator are per pixel.
  let energyLoss = emsV * emsV;
  let denominator = vec3<f32>(1.0) - energyLoss * favg * favg + vec3<f32>(1e-6);
  return DirectMultiScatterView(fssEssV, favg, energyLoss, denominator, emsV, f90, roughness, nDotV);
}

fn directMultiScatterFromView(
  ms        : DirectMultiScatterView,
  nDotL     : f32,
  F0        : vec3<f32>,
  useLut    : bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let dfgL = sampleDirectDfg(ms.roughness, nDotL, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  let fssEssL = F0 * dfgL.x + vec3<f32>(dfgL.y * ms.f90Lane);
  var energyLoss = ms.energyLoss;
  var denominator = ms.denominator;
#ifdef DIRECT_DFG_LUT_AVAILABLE
  if (useLut) {
    energyLoss = ms.emsV * (1.0 - dfgL.x - dfgL.y);
    denominator = vec3<f32>(1.0) - energyLoss * ms.favg * ms.favg + vec3<f32>(1e-6);
  }
#endif
  let fms = ms.fssEssV * fssEssL * ms.favg / denominator;
  return fms * energyLoss;
}

// standardOpaqueBrdf with the view half of the multiple-scatter term hoisted.
fn standardOpaqueBrdfFromView(baseColor: vec3<f32>, metallic: f32, alpha: f32, f0: vec3<f32>,
  ms: DirectMultiScatterView, nDotL: f32, nDotH: f32, vDotH: f32, useLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let specular = d_ggx(nDotH, alpha) * v_smith(ms.nDotV, nDotL, alpha) * f_schlick(vDotH, f0)
    + directMultiScatterFromView(ms, nDotL, f0, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
      directDfgLut, directDfgSampler,
#endif
    );
  return (1.0 - metallic) * baseColor / 3.14159265 + specular;
}

// One evaluation for raster direct lighting and the opaque reference integrator.
// Preserves Standard's existing additive Lambert + GGX/multiple-scatter convention.
// Specular lobe of the standard opaque BRDF with an explicit D scale. `dEnergy`
// multiplies the GGX distribution only (Unreal: `D_GGX(a2, NoH) * Energy`,
// ShadingModels.ush:187-190); 1.0 is the point-light lobe.
fn standardOpaqueBrdfEnergy(baseColor: vec3<f32>, metallic: f32, alpha: f32, f0: vec3<f32>,
  nDotV: f32, nDotL: f32, nDotH: f32, vDotH: f32, dEnergy: f32, useLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let specular = d_ggx(nDotH, alpha) * dEnergy * v_smith(nDotV, nDotL, alpha) * f_schlick(vDotH, f0)
    + directMultiScatter(sqrt(max(alpha, 0.0)), nDotV, nDotL, f0, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
      directDfgLut, directDfgSampler,
#endif
    );
  return (1.0 - metallic) * baseColor / 3.14159265 + specular;
}

fn standardOpaqueBrdf(baseColor: vec3<f32>, metallic: f32, alpha: f32, f0: vec3<f32>,
  nDotV: f32, nDotL: f32, nDotH: f32, vDotH: f32, useLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  return standardOpaqueBrdfEnergy(baseColor, metallic, alpha, f0, nDotV, nDotL, nDotH, vDotH, 1.0, useLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
}

// Unreal SphereMaxNoH, UE 5.8.1 BRDF.ush:63-137 (de Carpentier 2017, "Decima
// Engine: Advances in Lighting and AA"), with the bNewtonIteration = true branch
// (BRDF.ush:96-118). Moves L to the point of the light disc (angular radius
// asin(sinAlpha)) that maximises N.H. Inputs are the signed N.L, N.V and V.L;
// returns (N.H, V.H). The anisotropic X/Y terms are `#if 0` in Unreal and are
// not ported. sinAlpha <= 0 returns the point-light terms from halfVectorTerms.
fn sphereMaxNoH(nDotL : f32, nDotV : f32, vDotL : f32, sinAlpha : f32) -> vec2<f32> {
  if (!(sinAlpha > 0.0)) {
    return halfVectorTerms(nDotL, nDotV, vDotL);
  }
  let cosAlpha = sqrt(max(1.0 - sinAlpha * sinAlpha, 0.0));
  let roL = 2.0 * nDotL * nDotV - vDotL;
  if (roL >= cosAlpha) {
    // BRDF.ush:72-78: the reflection vector lies inside the disc.
    return vec2<f32>(1.0, abs(nDotV));
  }
  let rInvLengthT = sinAlpha * inverseSqrt(max(1.0 - roL * roL, 1e-8));
  var noTr = rInvLengthT * (nDotV - roL * nDotL);
  var voTr = rInvLengthT * (2.0 * nDotV * nDotV - 1.0 - roL * vDotL);
  // BRDF.ush:96-118: one Newton step. NxLoV = |dot(cross(N, L), V)|.
  let nxLoV = sqrt(saturate(1.0 - nDotL * nDotL - nDotV * nDotV - vDotL * vDotL + 2.0 * nDotL * nDotV * vDotL));
  let noBr = rInvLengthT * nxLoV;
  let voBr = rInvLengthT * nxLoV * 2.0 * nDotV;
  let noLVTr = nDotL * cosAlpha + nDotV + noTr;
  let voLVTr = vDotL * cosAlpha + 1.0 + voTr;
  let p = noBr * voLVTr;
  let q = noLVTr * voLVTr;
  let s = voBr * noLVTr;
  let xNum = q * (-0.5 * p + 0.25 * voBr * noLVTr);
  let xDenom = p * p + s * (s - 2.0 * p)
    + noLVTr * ((nDotL * cosAlpha + nDotV) * voLVTr * voLVTr + q * (-0.5 * (voLVTr + vDotL * cosAlpha) - 0.5));
  let twoX1 = 2.0 * xNum / max(xDenom * xDenom + xNum * xNum, 1e-30);
  let sinTheta = twoX1 * xDenom;
  let cosTheta = 1.0 - twoX1 * xNum;
  noTr = cosTheta * noTr + sinTheta * noBr;
  voTr = cosTheta * voTr + sinTheta * voBr;
  // BRDF.ush:120-134: the shifted L feeds the usual N.H / V.H build.
  let shiftedNoL = nDotL * cosAlpha + noTr;
  let shiftedVoL = vDotL * cosAlpha + voTr;
  return halfVectorTerms(shiftedNoL, nDotV, shiftedVoL);
}

// Unreal New_a2, UE 5.8.1 ShadingModels.ush:122-126 (the 3 * sqrt(a2) variant).
// `alpha` is the engine's roughness^2, so Unreal's a2 = Pow4(Roughness) is
// alpha * alpha and sqrtFast(a2) is alpha.
fn sphereNewA2(alpha : f32, sinAlpha : f32, vDotH : f32) -> f32 {
  return alpha * alpha + 0.25 * sinAlpha * (3.0 * alpha + sinAlpha) / (vDotH + 0.001);
}

// Unreal EnergyNormalization sphere branch, ShadingModels.ush:142-147:
// Energy = a2 / New_a2(a2, SphereSinAlpha, VoH). The soft-radius branch
// (ShadingModels.ush:134-137) is not ported; the engine light has no soft source.
fn sphereEnergy(alpha : f32, sinAlpha : f32, vDotH : f32) -> f32 {
  if (!(sinAlpha > 0.0)) { return 1.0; }
  return alpha * alpha / sphereNewA2(alpha, sinAlpha, vDotH);
}

// Directional sun disc: UE CapsuleLightIntegrate.ush:98 shrinks the disc with
// roughness, SphereSinAlpha = saturate(R * (1 - a)) where a = Roughness^2 (the
// engine's alpha). Returns (N.H, V.H, Energy); sunSinAlpha = sin(half angle).
fn sunDiscSpecularTerms(nDotL : f32, nDotV : f32, vDotL : f32, sunSinAlpha : f32, alpha : f32) -> vec3<f32> {
  let sinAlpha = saturate(sunSinAlpha * (1.0 - alpha));
  let terms = sphereMaxNoH(nDotL, nDotV, vDotL, sinAlpha);
  return vec3<f32>(terms, sphereEnergy(alpha, sinAlpha, terms.y));
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
