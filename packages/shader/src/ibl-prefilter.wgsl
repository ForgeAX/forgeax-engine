#define_import_path forgeax_pbr::ibl_prefilter

// @forgeax/engine-shader - ibl-prefilter.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t45).
//
// GGX specular prefilter pass (Karis 2013 split-sum). For each roughness
// mip level, importance-sample the environment cubemap with SAMPLE_COUNT
// Hammersley samples; the result is the prefiltered radiance cube
// consumed by sampleIblSpecular() at runtime.
//
// @group(0) layout (dual uniform -- the (b3) compose test in the round-2
// dawn suite exercises this ordering):
//   binding(0) = CubemapFaceUniforms { viewProj }      (per-face)
//   binding(1) = PrefilterUniforms   { roughness, faceSize, sourceMipLevelCount, sourceIsCameraCube }
// @group(1) = env cubemap + sampler. Same shape as ibl-irradiance, but
//             physically isolated -- both bind @binding(0) to a texture_cube
//             inside *their own* module without colliding because round-2
//             ships each module as a separate file.
//
// Entries: cubemap_vs + prefilterEnv_fs.

#import forgeax_pbr::ibl_shared::{PI, hammersley, importanceSampleGGX, iblDGGX}

struct CubemapVsIn {
  @location(0) pos: vec3<f32>,
};
struct CubemapVsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};

struct CubemapFaceUniforms {
  viewProj: mat4x4<f32>,
};

struct PrefilterUniforms {
  roughness: f32,
  faceSize: f32,
  // Actual mip count of the source cube bound at group(1). The source cube is
  // currently base-level-only; the value prevents sampling an unallocated mip.
  sourceMipLevelCount: f32,
  // Camera captures and image cubes have distinct per-face orientations.
  sourceIsCameraCube: f32,
};

@group(0) @binding(0) var<uniform> faceUniforms: CubemapFaceUniforms;
@group(0) @binding(1) var<uniform> prefUniforms: PrefilterUniforms;

@group(1) @binding(0) var envCube: texture_cube<f32>;
@group(1) @binding(1) var envSamplerS: sampler;

const PREFILTER_SAMPLE_COUNT: u32 = 1024u;
const PREFILTER_MIP_LEVEL_COUNT: f32 = 5.0;

@vertex
fn cubemap_vs(in0: CubemapVsIn) -> CubemapVsOut {
  var out: CubemapVsOut;
  out.clip = faceUniforms.viewProj * vec4<f32>(in0.pos, 1.0);
  out.worldPos = in0.pos;
  return out;
}

@fragment
fn prefilterEnv_fs(in0: CubemapVsOut) -> @location(0) vec4<f32> {
  let roughness = prefUniforms.roughness;
  // V = R = N (cubemap capture from origin assumption).
  let N = normalize(in0.worldPos);
  let V = N;

  var prefilteredColor = vec3<f32>(0.0);
  var totalWeight: f32 = 0.0;

  // At zero roughness every Hammersley sample yields H=N and L=N. The
  // source mip is already fixed to zero, so the normalized weighted sum is
  // one sample. Keep all 1024 samples at every nonzero roughness and retain
  // the original Hammersley/PDF domain below.
  let sampleCount = select(PREFILTER_SAMPLE_COUNT, 1u, roughness == 0.0);
  for (var i: u32 = 0u; i < sampleCount; i = i + 1u) {
    let Xi = hammersley(i, PREFILTER_SAMPLE_COUNT);
    let H = importanceSampleGGX(Xi, N, roughness);
    let L = normalize(2.0 * dot(V, H) * H - V);

    let NdotL = max(dot(N, L), 0.0);
    if (NdotL > 0.0) {
      // Mip level from solid-angle PDF ratio.
      let D0 = iblDGGX(max(dot(N, H), 0.0), roughness);
      let NdotH0 = max(dot(N, H), 0.0);
      let HdotV = max(dot(H, V), 0.0);
      // A grazing half-vector can make HdotV exactly zero. Keep the PDF
      // finite so the mip calculation cannot feed NaN into textureSampleLevel.
      let pdf = D0 * NdotH0 / max(4.0 * HdotV, 0.0001) + 0.0001;

      let resolution: f32 = 512.0;
      let saTexel = 4.0 * PI / (6.0 * resolution * resolution);
      let saSample = 1.0 / (f32(PREFILTER_SAMPLE_COUNT) * pdf + 0.0001);

      let requestedMipLevel = min(select(
        0.5 * log2(saSample / saTexel),
        0.0,
        roughness == 0.0,
      ), PREFILTER_MIP_LEVEL_COUNT - 1.0);
      let mipLevel = clamp(
        requestedMipLevel,
        0.0,
        max(prefUniforms.sourceMipLevelCount - 1.0, 0.0),
      );

      // A CubeCamera uses ordinary view projections. Convert its per-face
      // horizontal orientation once at the PMREM producer boundary, before
      // publishing a canonical cube to material sampling.
      var sourceDirection = L;
      if (prefUniforms.sourceIsCameraCube > 0.5) {
        if (abs(L.x) >= max(abs(L.y), abs(L.z))) {
          sourceDirection.z = -sourceDirection.z;
        } else {
          sourceDirection.x = -sourceDirection.x;
        }
      }
      prefilteredColor += textureSampleLevel(
        envCube, envSamplerS, sourceDirection, mipLevel,
      ).rgb * NdotL;
      totalWeight += NdotL;
    }
  }
  prefilteredColor = prefilteredColor / max(totalWeight, 0.001);
  return vec4<f32>(prefilteredColor, 1.0);
}
