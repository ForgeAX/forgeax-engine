#define_import_path forgeax_pbr::ibl_prefilter
#import forgeax_pbr::ibl_shared::{hammersley, importanceSampleGGX}
#import forgeax_pbr::pmrem::{pmremDirection, pmremLevelOrigin, samplePmremLevel}

// Progressive GGX PMREM, matching Three r184 WebGPU's 512-sample VNDF
// convolution and incremental roughness policy. V=N makes VNDF equivalent
// to ordinary GGX with the Hammersley radial/azimuth coordinates exchanged.
struct PrefilterUniforms {
  level: f32,
  face: f32,
  sourceIsCameraCube: f32,
  _padding: f32,
};
@group(0) @binding(1) var<uniform> params: PrefilterUniforms;
@group(1) @binding(0) var envCube: texture_cube<f32>;
@group(1) @binding(1) var envSampler: sampler;
@group(1) @binding(2) var previousLevels: texture_2d<f32>;

@vertex
fn cubemap_vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(select(-1.0, 3.0, index == 1u), select(-1.0, 3.0, index == 2u), 0.0, 1.0);
}

@fragment
fn prefilterEnv_fs(@builtin(position) pixel: vec4<f32>) -> @location(0) vec4<f32> {
  let baseSize = f32(textureDimensions(previousLevels, 0).y) * 0.25;
  let maxMip = log2(baseSize);
  let mip = maxMip - params.level;
  let faceSize = exp2(max(mip, 4.0));
  let face = u32(params.face);
  let origin = pmremLevelOrigin(baseSize, mip) + vec2<f32>(f32(face % 3u), f32(face / 3u)) * faceSize;
  // Expand each face by its one-texel border, including neighboring directions.
  let N = normalize(pmremDirection((pixel.xy - origin - vec2<f32>(1.0)) / (faceSize - 2.0), face));
  if (params.level == 0.0) {
    var sourceDirection = N;
    if (params.sourceIsCameraCube > 0.5) {
      if (abs(N.x) >= max(abs(N.y), abs(N.z))) { sourceDirection.z = -sourceDirection.z; }
      else { sourceDirection.x = -sourceDirection.x; }
    }
    return vec4<f32>(textureSampleLevel(envCube, envSampler, sourceDirection, 0.0).rgb, 1.0);
  }
  let targetRoughness = params.level / (maxMip + 2.0);
  let previous = (params.level - 1.0) / (maxMip + 2.0);
  let roughness = sqrt(targetRoughness * targetRoughness - previous * previous) * targetRoughness * 1.25;
  var sum = vec3<f32>(0.0);
  var weight = 0.0;
  for (var i = 0u; i < 512u; i++) {
    let H = importanceSampleGGX(hammersley(i, 512u).yx, N, roughness);
    let L = normalize(2.0 * dot(N, H) * H - N);
    let nDotL = max(dot(N, L), 0.0);
    if (nDotL > 0.0) {
      sum += samplePmremLevel(previousLevels, envSampler, L, mip + 1.0) * nDotL;
      weight += nDotL;
    }
  }
  return vec4<f32>(sum / max(weight, 1e-6), 1.0);
}
