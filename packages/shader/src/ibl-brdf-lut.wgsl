#define_import_path forgeax_pbr::ibl_brdf_lut

// @forgeax/engine-shader - ibl-brdf-lut.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t46).
//
// BRDF integration LUT bake (Karis 2013 split-sum, second factor).
// One-shot fullscreen pass into a 256x256 RG16F target. Output channels:
//   R = sum (1 - Fc) * G * (V . H) / (N . H * N . V)
//   G = sum     Fc  * G * (V . H) / (N . H * N . V)
// where Fc = (1 - V . H)^5. This LUT is consumed at runtime by
// sampleIblSpecular() in ibl-sampling.wgsl.
//
// Zero @group(1) bindings -- the LUT is computed entirely from screen-space
// position + Hammersley sequence + shared math. AC-06 / plan D-10 fixes
// BRDF_LUT_SIZE = 256u as the SSOT constant; the host (IblPipelineCache)
// reads the same constant via a TS mirror.
//
// Entries: fullscreen_vs + brdfLutBake_fs.

#import forgeax_pbr::ibl_shared::{hammersley, importanceSampleGGX, iblGeometrySmith}

struct VsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};

// AC-06 / plan D-10: BRDF LUT resolution. Both the bake fragment and the
// caller (IblPipelineCache.runIblPrecompute) align on this SSOT constant.
const BRDF_LUT_SIZE: u32 = 256u;
const BRDF_LUT_SAMPLE_COUNT: u32 = 1024u;

@vertex
fn fullscreen_vs(@builtin(vertex_index) vi: u32) -> VsOut {
  // Fullscreen triangle covering NDC [-1,1]^2.
  var x: f32 = -1.0;
  var y: f32 = -1.0;
  if (vi == 1u) {
    x = 3.0;
  }
  if (vi == 2u) {
    y = 3.0;
  }
  var out: VsOut;
  out.clip = vec4<f32>(x, y, 0.0, 1.0);
  out.worldPos = vec3<f32>(0.0); // unused
  return out;
}

@fragment
fn brdfLutBake_fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  // Screen-space framebuffer position maps to (NdotV, roughness) in [0, 1]^2.
  // Caller renders a fullscreen quad at BRDF_LUT_SIZE x BRDF_LUT_SIZE viewport
  // (256x256 per plan D-10 / AC-06). pos.x / pos.y are framebuffer pixel
  // coordinates in [0.5, BRDF_LUT_SIZE - 0.5].
  let denom = f32(BRDF_LUT_SIZE - 1u);
  let NdotV = clamp(pos.x / denom, 0.0, 1.0);
  let roughness = clamp(pos.y / denom, 0.0, 1.0);

  // Reconstruct V from NdotV in canonical frame: N = (0, 0, 1).
  let V = vec3<f32>(
    sqrt(clamp(1.0 - NdotV * NdotV, 0.0, 1.0)),
    0.0,
    NdotV,
  );
  let N = vec3<f32>(0.0, 0.0, 1.0);

  var A: f32 = 0.0;
  var B: f32 = 0.0;

  for (var i: u32 = 0u; i < BRDF_LUT_SAMPLE_COUNT; i = i + 1u) {
    let Xi = hammersley(i, BRDF_LUT_SAMPLE_COUNT);
    let H = importanceSampleGGX(Xi, N, roughness);
    let L = normalize(2.0 * dot(V, H) * H - V);

    let NdotL = max(L.z, 0.0);
    if (NdotL > 0.0) {
      let NdotH = max(H.z, 0.0);
      let VdotH = max(dot(V, H), 0.0);

      let G = iblGeometrySmith(NdotV, NdotL, roughness);
      let GVis = (G * VdotH) / max(NdotH * NdotV, 1e-5);
      let Fc = pow(max(1.0 - VdotH, 0.0), 5.0);

      A += (1.0 - Fc) * GVis;
      B += Fc * GVis;
    }
  }
  A = A / f32(BRDF_LUT_SAMPLE_COUNT);
  B = B / f32(BRDF_LUT_SAMPLE_COUNT);

  return vec4<f32>(A, B, 0.0, 1.0);
}
