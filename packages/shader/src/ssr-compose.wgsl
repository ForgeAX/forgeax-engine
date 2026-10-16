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

struct SsrReceiverSample {
  radiance : vec4<f32>,
  coverage : f32,
};

@vertex
fn vs_ssr_compose(@builtin(vertex_index) index : u32) -> ComposeVertex {
  let x = select(-1.0, 3.0, index == 1u);
  let y = select(-1.0, 3.0, index == 2u);
  return ComposeVertex(vec4<f32>(x, y, 0.0, 1.0));
}

// Reconstruct the half-resolution lattice without borrowing another face's
// ray. Renormalize compatible taps instead of rejecting the entire pixel
// solely because its nearest trace sample crossed a subpixel tile edge.
fn ssrReceiverSample(uv : vec2<f32>, packedNormal : u32, lod : f32) -> SsrReceiverSample {
  let size = vec2<i32>(textureDimensions(radiance, 0));
  let coordinate = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let first = vec2<i32>(floor(coordinate));
  let fraction = fract(coordinate);
  var totalWeight = 0.0;
  let pixel00 = clamp(first + vec2<i32>(0, 0), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal00 = textureLoad(normalRoughness, pixel00 * 2, 0).r;
  let weight00 = select(1.0 - fraction.x, fraction.x, false) * select(1.0 - fraction.y, fraction.y, false)
    * ssrPackedReceiverWeight(packedNormal, tracedNormal00);
  // The presentation pyramid is premultiplied by confidence. Preserve
  // that representation during receiver reconstruction and unpremultiply
  // only once after the roughness filter has selected its LOD.
  totalWeight += weight00;

  let pixel10 = clamp(first + vec2<i32>(1, 0), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal10 = textureLoad(normalRoughness, pixel10 * 2, 0).r;
  let weight10 = select(1.0 - fraction.x, fraction.x, true) * select(1.0 - fraction.y, fraction.y, false)
    * ssrPackedReceiverWeight(packedNormal, tracedNormal10);
  totalWeight += weight10;

  let pixel01 = clamp(first + vec2<i32>(0, 1), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal01 = textureLoad(normalRoughness, pixel01 * 2, 0).r;
  let weight01 = select(1.0 - fraction.x, fraction.x, false) * select(1.0 - fraction.y, fraction.y, true)
    * ssrPackedReceiverWeight(packedNormal, tracedNormal01);
  totalWeight += weight01;

  let pixel11 = clamp(first + vec2<i32>(1, 1), vec2<i32>(0), size - vec2<i32>(1));
  let tracedNormal11 = textureLoad(normalRoughness, pixel11 * 2, 0).r;
  let weight11 = select(1.0 - fraction.x, fraction.x, true) * select(1.0 - fraction.y, fraction.y, true)
    * ssrPackedReceiverWeight(packedNormal, tracedNormal11);
  totalWeight += weight11;
  // Rough LODs only need the geometric admission from this footprint. Their
  // radiance comes from the filtered mip, so do not fetch unused sharp color.
  if (lod >= 1.0) { return SsrReceiverSample(vec4<f32>(0.0), totalWeight); }
  var sum = textureLoad(radiance, pixel00, 0) * weight00;
  sum += textureLoad(radiance, pixel10, 0) * weight10;
  sum += textureLoad(radiance, pixel01, 0) * weight01;
  sum += textureLoad(radiance, pixel11, 0) * weight11;
  return SsrReceiverSample(sum / max(totalWeight, 1e-6), totalWeight);
}

fn ssrReflectionLod(roughness : f32) -> f32 {
  return roughness * roughness * f32(textureNumLevels(radiance) - 1u);
}

fn sampleRoughSsr(uv : vec2<f32>, roughness : f32) -> vec4<f32> {
  let lod = ssrReflectionLod(roughness);
  // The presentation pyramid is premultiplied by confidence, so hardware
  // bilinear/trilinear filtering preserves coverage without the four manual
  // loads previously needed for every low-LOD sample.
  return textureSampleLevel(radiance, radianceSampler, uv, lod);
}

fn ssrReceiverWeight(current : vec3<f32>, traced : vec3<f32>) -> f32 {
  let agreement = dot(current, traced) * inverseSqrt(max(dot(current, current) * dot(traced, traced), 1e-8));
  return smoothstep(0.9, 0.99, agreement);
}

fn ssrPackedReceiverWeight(current : u32, traced : u32) -> f32 {
  // The lower 24 bits are the canonical octahedral normal; roughness is not
  // part of receiver identity. Equal encodings decode to the same finite
  // unit normal and the existing smoothstep is exactly one.
  if ((current & 0xFFFFFFu) == (traced & 0xFFFFFFu)) { return 1.0; }
  return ssrReceiverWeight(decodeStandardNormalRoughness(current).xyz,
    decodeStandardNormalRoughness(traced).xyz);
}

@fragment
fn fs_ssr_compose(in : ComposeVertex) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(in.position.xy);
  // Trace samples full-resolution pixel 2*p, not the center of a 2x2 box.
  let uv = (in.position.xy + vec2<f32>(0.5)) / vec2<f32>(textureDimensions(fallback, 0));
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
  let reconstructed = ssrReceiverSample(uv, packedReceiver, lod);
  if (reconstructed.coverage <= 1e-6) { return vec4<f32>(0.0); }
  let base = reconstructed.radiance;
  var filtered = base;
  if (lod < 1.0) {
    // Preserve the normal-compatible receiver reconstruction at the sharp
    // end while using one hardware-filtered read for the first roughness mip.
    // This keeps the transition continuous at lod == 1 and avoids the four
    // explicit footprint loads used by the old mip helper.
    if (textureNumLevels(radiance) > 1u) {
      filtered = mix(base, textureSampleLevel(radiance, radianceSampler, uv, 1.0), lod);
    }
  } else {
    filtered = sampleRoughSsr(uv, roughness);
  }
  let sample = vec4<f32>(filtered.rgb / max(filtered.a, 1e-6), filtered.a);
  let materialResponse = textureLoad(response, pixel, 0).rgb;
  // Receiver admission is independent of the central mirror ray. A rough
  // lobe can contain a visible wall even when that one ray misses its edge.
  // Preserve the current material's cutoff instead of borrowing a neighbor's
  // roughness policy from the filtered reflection pyramid.
  let receiverConfidence = 1.0 - smoothstep(roughnessLimit * 0.8, roughnessLimit, receiver.a);
  let confidence = clamp(min(receiverConfidence, sample.a), 0.0, 1.0) * environment.a;
  return vec4<f32>(confidence * (sample.rgb * materialResponse - environment.rgb), 0.0);
}
