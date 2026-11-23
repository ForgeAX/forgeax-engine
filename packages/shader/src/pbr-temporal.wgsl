#define_import_path forgeax_pbr::temporal
#import forgeax_material::alpha_hash::{alphaCoverage}

#import forgeax_scene_temporal::{packSceneTemporalV1WithValidity}
#ifndef ALPHA_HASH_DISABLED
#import forgeax_material::alpha_hash::{applyAlphaHash}
#endif

fn resolvePbrTemporalReactive(
  reactive : f32,
  baseColorAlpha : f32,
  sampledAlpha : f32,
) -> f32 {
  let coverage = clamp(baseColorAlpha * sampledAlpha, 0.0, 1.0);
  let coverageReactive = 1.0 - coverage;
  return max(clamp(reactive, 0.0, 1.0), coverageReactive);
}

// SurfaceData.reactive (Unreal Responsive AA). Out-of-range values clamp to
// [0, 1]; NaN and negative values keep the default history (0).
fn surfaceTemporalReactive(reactive : f32) -> f32 {
  return select(0.0, clamp(reactive, 0.0, 1.0), reactive >= 0.0);
}

fn applyPbrTemporalCoverage(
  sampledAlpha : f32,
  alphaCutoff : f32,
  alphaToCoverage : f32,
  alphaHash : f32,
  positionOS : vec3<f32>,
) -> f32 {
#ifndef ALPHA_CLIPPING_DISABLED
  let coverage = alphaCoverage(sampledAlpha, alphaCutoff, alphaToCoverage);
#else
  let coverage = sampledAlpha;
#endif
#ifndef ALPHA_HASH_DISABLED
  applyAlphaHash(coverage, positionOS, alphaHash);
#endif
  return coverage;
}

fn projectPbrSceneTemporal(
  sampledAlpha : f32,
  alphaCutoff : f32,
  alphaToCoverage : f32,
  alphaHash : f32,
  positionOS : vec3<f32>,
  currentClip : vec4<f32>,
  previousClip : vec4<f32>,
  temporalProjection : vec4<f32>,
  reactive : f32,
  motionValid : bool,
) -> vec4<f32> {
  let coverage = applyPbrTemporalCoverage(sampledAlpha, alphaCutoff, alphaToCoverage, alphaHash, positionOS);
  return packStandardTemporalCoverage(coverage, alphaHash, currentClip, previousClip, temporalProjection, reactive, motionValid);
}

fn packStandardTemporalCoverage(
  coverage : f32,
  alphaHash : f32,
  currentClip : vec4<f32>,
  previousClip : vec4<f32>,
  temporalProjection : vec4<f32>,
  reactive : f32,
  motionValid : bool,
) -> vec4<f32> {
  var reactiveCoverage = resolvePbrTemporalReactive(reactive, coverage, 1.0);
#ifndef ALPHA_HASH_DISABLED
  reactiveCoverage = select(reactiveCoverage, reactive, alphaHash > 0.5);
#endif
  return packSceneTemporalV1WithValidity(
    currentClip,
    previousClip,
    temporalProjection,
    reactiveCoverage,
    motionValid,
  );
}
