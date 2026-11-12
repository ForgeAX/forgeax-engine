#define_import_path forgeax_pbr::ibl_irradiance

// @forgeax/engine-shader - ibl-irradiance.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t44).
//
// Diffuse irradiance convolution. Per LearnOpenGL §6.2.2: a bounded
// hemisphere Riemann sum (sampleDelta = 0.05) integrates the environment to
// produce the convolved irradiance cubemap consumed by sampleIblDiffuse() at
// runtime. The sum reads a band-limited PMREM level, never the full
// resolution cube: point samples on a 2.9 degree grid alias a small, very
// bright source (an HDR sun disc) into blocky per-texel speckles, because
// neighbouring irradiance texels hit or miss it. three.js avoids the same
// problem by reading its PMREM at roughness 1 for diffuse. The budget is deliberately bounded for the rgba16float bake target
// so every backend completes the fragment without overflowing its shader
// work budget.
//
// @group(0) = per-face viewProj uniform.
// @group(1) = finished PMREM atlas (texture_2d<f32>) + sampler. The
//             precompute runs the prefilter before this pass so the atlas
//             is complete when it is bound here.
//
// Entries: cubemap_vs + irradianceConvolve_fs.

#import forgeax_pbr::ibl_shared::{PI}
#import forgeax_pbr::pmrem::{samplePmremLevel}

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

@group(0) @binding(0) var<uniform> faceUniforms: CubemapFaceUniforms;

@group(1) @binding(0) var envPmrem: texture_2d<f32>;
@group(1) @binding(1) var envSamplerS: sampler;

const IRRADIANCE_SAMPLE_DELTA: f32 = 0.05;
// Logical PMREM mip read by the sum: 16-pixel faces (about 6.4 degrees per
// texel), so the 2.9 degree sample grid over-samples bilinear texels whose
// content the prefilter chain has already low-passed. The cosine lobe is 90
// degrees wide, so this pre-blur leaves smooth environments unchanged.
const IRRADIANCE_SOURCE_MIP: f32 = 4.0;

// The bake target is rgba16float, so a sample is admissible only when all of
// its lanes can be represented by that format. Equality catches NaN while
// the bound also rejects infinities before they enter the running sum.
fn irradianceFiniteScalar(value: f32) -> bool {
  return value == value && abs(value) <= 65504.0;
}

fn irradianceFiniteVec3(value: vec3<f32>) -> bool {
  return irradianceFiniteScalar(value.x) &&
         irradianceFiniteScalar(value.y) &&
         irradianceFiniteScalar(value.z);
}

fn irradianceSanitizeScalar(value: f32) -> f32 {
  let bounded = clamp(value, 0.0, 65504.0);
  return select(0.0, bounded, irradianceFiniteScalar(value));
}

@vertex
fn cubemap_vs(in0: CubemapVsIn) -> CubemapVsOut {
  var out: CubemapVsOut;
  out.clip = faceUniforms.viewProj * vec4<f32>(in0.pos, 1.0);
  out.worldPos = in0.pos;
  return out;
}

@fragment
fn irradianceConvolve_fs(in0: CubemapVsOut) -> @location(0) vec4<f32> {
  let N = normalize(in0.worldPos);
  let up0 = select(
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(1.0, 0.0, 0.0),
    abs(N.y) > 0.999,
  );
  let right = normalize(cross(up0, N));
  let up = normalize(cross(N, right));

  var irradiance = vec3<f32>(0.0);
  var nrSamples: f32 = 0.0;

  var phi: f32 = 0.0;
  while (phi < 2.0 * PI) {
    var theta: f32 = 0.0;
    while (theta < 0.5 * PI) {
      let tangentSample = vec3<f32>(
        sin(theta) * cos(phi),
        sin(theta) * sin(phi),
        cos(theta),
      );
      let sampleVec = tangentSample.x * right +
                      tangentSample.y * up +
                      tangentSample.z * N;

      let sampleColor = samplePmremLevel(
        envPmrem, envSamplerS, sampleVec, IRRADIANCE_SOURCE_MIP,
      );
      // A malformed direction or backend sample must not poison the whole
      // irradiance face. Skip only non-finite samples and keep the
      // normalization count in lockstep with the accumulated radiance.
      let sampleWeight = cos(theta) * sin(theta);
      if (
        irradianceFiniteVec3(sampleVec) &&
        irradianceFiniteVec3(sampleColor) &&
        irradianceFiniteScalar(sampleWeight)
      ) {
        irradiance += sampleColor * sampleWeight;
        nrSamples += 1.0;
      }
      theta += IRRADIANCE_SAMPLE_DELTA;
    }
    phi += IRRADIANCE_SAMPLE_DELTA;
  }

  // IRRADIANCE_PAYLOAD_E_OVER_PI: PI * the uniform theta/phi sample average
  // produces the Lambert-normalized diffuse radiance E / PI. Runtime sampling
  // consumes this payload directly; applying another Lambert divide would
  // darken diffuse IBL by PI.
  irradiance = PI * irradiance / max(nrSamples, 1.0);
  return vec4<f32>(
    irradianceSanitizeScalar(irradiance.x),
    irradianceSanitizeScalar(irradiance.y),
    irradianceSanitizeScalar(irradiance.z),
    1.0,
  );
}
