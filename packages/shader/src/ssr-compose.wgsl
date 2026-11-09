#define_import_path forgeax_ssr::compose
#import forgeax_pbr::gbuffer::{decodeStandardNormalRoughness}

struct ComposeVertex {
  @builtin(position) position : vec4<f32>,
};

@group(0) @binding(0) var radiance : texture_2d<f32>;
@group(0) @binding(1) var fallback : texture_2d<f32>;
@group(0) @binding(2) var response : texture_2d<f32>;
@group(0) @binding(3) var normalRoughness : texture_2d<u32>;
@group(0) @binding(4) var radianceSampler : sampler;
#import forgeax_view::common::View
@group(0) @binding(5) var<uniform> view : View;

fn ssrComposeVertex(index : u32) -> ComposeVertex {
  let x = select(-1.0, 3.0, index == 1u);
  let y = select(-1.0, 3.0, index == 2u);
  return ComposeVertex(vec4<f32>(x, y, 0.0, 1.0));
}

#if PORTABLE_FRAGMENT
@group(0) @binding(6) var<uniform> reflectionMipCount : vec4<u32>;
#endif
fn ssrRadianceLevelCount() -> u32 {
#if PORTABLE_FRAGMENT
  return max(reflectionMipCount.x, 1u);
#else
  return textureNumLevels(radiance);
#endif
}

fn ssrReflectionLod(roughness : f32) -> f32 {
  return roughness * roughness * f32(ssrRadianceLevelCount() - 1u);
}

fn sampleRoughSsr(uv : vec2<f32>, roughness : f32) -> vec4<f32> {
  let lod = ssrReflectionLod(roughness);
  // The presentation pyramid is premultiplied by confidence, so hardware
  // bilinear/trilinear filtering preserves coverage without the four manual
  // loads previously needed for every low-LOD sample.
  return textureSampleLevel(radiance, radianceSampler, uv, lod);
}

// Unreal SSRTReflections.usf: OutColor.rgb *= rcp(1 - Luminance(OutColor.rgb)),
// the inverse of the trace's per-ray ssrLuminanceWeight. Weighted luminance is
// below one by construction; the floor is only the largest FP16 value below one
// (1 - 2^-11), so the divide stays representable rather than clamping radiance.
fn ssrLuminanceUnweight(rgb : vec3<f32>) -> vec3<f32> {
  let luminance = max(0.0, dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722)));
  return rgb / max(1.0 - luminance, 0.00048828125);
}

fn evaluateSsrCompose(in : ComposeVertex) -> vec4<f32> {
  let pixel = vec2<i32>(in.position.xy);
  // Fragment position already names the full-resolution pixel center.
  let uv = in.position.xy / vec2<f32>(textureDimensions(fallback, 0));
  let packedReceiver = textureLoad(normalRoughness, pixel, 0).r;
  let receiver = decodeStandardNormalRoughness(packedReceiver);
  let environment = textureLoad(fallback, pixel, 0);
  let roughnessLimit = clamp(view.ssrParams.z, 0.0, 1.0);
  if (!(view.ssrParams.w > 0.5 && view.ssrParams.w < 3.402823e+38) ||
      !(receiver.a >= 0.0 && receiver.a < roughnessLimit) || environment.a <= 0.0) {
    return vec4<f32>(0.0);
  }
  let roughness = clamp(receiver.a, 0.04, 1.0);
  let lod = ssrReflectionLod(roughness);
  // Temporal resolve publishes on the same full-resolution raster lattice.
  let base = textureLoad(radiance, pixel, 0);
  var filtered = base;
  if (lod < 1.0) {
    // Preserve the exact receiver sample at the sharp end and transition
    // continuously into the confidence-premultiplied roughness pyramid.
    if (ssrRadianceLevelCount() > 1u) {
      filtered = mix(base, textureSampleLevel(radiance, radianceSampler, uv, 1.0), lod);
    }
  } else {
    filtered = sampleRoughSsr(uv, roughness);
  }
  let weighted = filtered.rgb / max(filtered.a, 1e-6);
  // Undo the trace's per-ray 1 / (1 + luminance) weight after every filter.
  let sample = vec4<f32>(ssrLuminanceUnweight(weighted), filtered.a);
  let materialResponse = textureLoad(response, pixel, 0).rgb;
  // Receiver admission is independent of the central mirror ray. A rough
  // lobe can contain a visible wall even when that one ray misses its edge.
  // Preserve the current material's cutoff instead of borrowing a neighbor's
  // roughness policy from the filtered reflection pyramid.
  // Same UE GetRoughnessFade as the trace: full SSR up to half the limit.
  let receiverConfidence = min(2.0 - 2.0 * clamp(receiver.a, 0.0, 1.0) / max(roughnessLimit, 1e-5), 1.0);
  let confidence = clamp(min(receiverConfidence, sample.a), 0.0, 1.0) * environment.a;
  return vec4<f32>(confidence * (sample.rgb * materialResponse - environment.rgb), 0.0);
}

#if PORTABLE_FRAGMENT
@vertex fn vs_ssr_compose_fragment(@builtin(vertex_index) index : u32) -> ComposeVertex { return ssrComposeVertex(index); }
@fragment fn fs_ssr_compose_fragment(in : ComposeVertex) -> @location(0) vec4<f32> { return evaluateSsrCompose(in); }
#else
@vertex fn vs_ssr_compose(@builtin(vertex_index) index : u32) -> ComposeVertex { return ssrComposeVertex(index); }
@fragment fn fs_ssr_compose(in : ComposeVertex) -> @location(0) vec4<f32> { return evaluateSsrCompose(in); }
#endif
