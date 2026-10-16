#define_import_path forgeax_view::bloom_downsample

// @forgeax/engine-shader - bloom-downsample.wgsl
// One production downsample module serves D0 extraction and D1..D4 fixed
// thirteen-tap spatial reduction. The graph supplies one parameter slice per
// pass; no axis or radius variant exists.
// linearHdrColorDomain: every output remains scene-linear HDR until the
// Output Transform after the Bloom composite.

#import forgeax_view::common::{FullscreenOutput, clampLinearHdr, fullscreen_triangle}

struct BloomDownsampleParams {
  threshold      : f32,
  softKnee       : f32,
  destinationW   : f32,
  destinationH   : f32,
  level          : f32,
  pad0           : f32,
  pad1           : f32,
  pad2           : f32,
};

@group(0) @binding(0) var src  : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var<uniform> params : BloomDownsampleParams;

const REC709_LUMA : vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

fn extractBloom(color : vec3<f32>) -> vec3<f32> {
  let c = max(color, vec3<f32>(0.0));
  // The source and every Bloom target are rgba16float, so 65504 is the
  // representable HDR ceiling.  Clamp the luminance before thresholding to
  // make the maximum finite sample exactly equal to the maximum threshold
  // despite small dot-product rounding on different GPU backends.
  let luma = min(max(dot(c, REC709_LUMA), 0.0), 65504.0);
  let threshold = params.threshold;
  if threshold == 0.0 {
    return c;
  }
  let knee = threshold * params.softKnee;
  if knee == 0.0 {
    return c * max(luma - threshold, 0.0) / max(luma, 1e-6);
  }
  // Keep the knee offset grouped before adding scene luminance.  At the
  // finite HDR ceiling, subtracting two near-65504 values first loses the
  // fractional source value on implementations that round the expression.
  let q = clamp(luma + (knee - threshold), 0.0, 2.0 * knee);
  let soft = q * q / (4.0 * knee);
  let response = max(luma - threshold, soft);
  return c * response / max(luma, 1e-6);
}

fn loadCoveredAverage(pixel : vec2<u32>) -> vec3<f32> {
  // Map the destination texel to its exact source-space rectangle.  Ceil
  // halving makes odd extents overlap two source texels on an axis (and up to
  // four in 2D), so an equal 2x2 average would over-weight the edge texel.
  // The extraction is deliberately applied before coverage weighting.
  let sourceSize = vec2<f32>(textureDimensions(src));
  let destinationSize = vec2<f32>(params.destinationW, params.destinationH);
  let sourceMin = vec2<f32>(pixel) * sourceSize / destinationSize;
  let sourceMax = vec2<f32>(pixel + vec2<u32>(1u)) * sourceSize / destinationSize;
  let first = vec2<i32>(floor(sourceMin));
  let last = vec2<i32>(ceil(sourceMax));
  var sum = vec3<f32>(0.0);
  var coverage = 0.0;
  for (var y = first.y; y < last.y; y = y + 1) {
    for (var x = first.x; x < last.x; x = x + 1) {
      let texelMin = vec2<f32>(f32(x), f32(y));
      let texelMax = texelMin + vec2<f32>(1.0);
      let overlapMin = max(sourceMin, texelMin);
      let overlapMax = min(sourceMax, texelMax);
      let weight = max(overlapMax.x - overlapMin.x, 0.0) * max(overlapMax.y - overlapMin.y, 0.0);
      if weight > 0.0 {
        sum = sum + extractBloom(textureLoad(src, vec2<i32>(x, y), 0).rgb) * weight;
        coverage = coverage + weight;
      }
    }
  }
  return clampLinearHdr(sum / max(coverage, 1e-6));
}

fn fixedDownsample(uv : vec2<f32>) -> vec3<f32> {
  let sourceTexel = 1.0 / vec2<f32>(textureDimensions(src));
  var result = textureSampleLevel(src, samp, uv, 0.0).rgb * 0.125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>( 2.0,  0.0) * sourceTexel, 0.0).rgb * 0.0625;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>(-2.0,  0.0) * sourceTexel, 0.0).rgb * 0.0625;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>( 0.0,  2.0) * sourceTexel, 0.0).rgb * 0.0625;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>( 0.0, -2.0) * sourceTexel, 0.0).rgb * 0.0625;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>( 2.0,  2.0) * sourceTexel, 0.0).rgb * 0.03125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>(-2.0,  2.0) * sourceTexel, 0.0).rgb * 0.03125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>( 2.0, -2.0) * sourceTexel, 0.0).rgb * 0.03125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>(-2.0, -2.0) * sourceTexel, 0.0).rgb * 0.03125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>( 1.0,  1.0) * sourceTexel, 0.0).rgb * 0.125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>(-1.0,  1.0) * sourceTexel, 0.0).rgb * 0.125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>( 1.0, -1.0) * sourceTexel, 0.0).rgb * 0.125;
  result = result + textureSampleLevel(src, samp, uv + vec2<f32>(-1.0, -1.0) * sourceTexel, 0.0).rgb * 0.125;
  return result;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let pixel = vec2<u32>(in.position.xy);
  let isD0 = params.level == 0.0;
  var result : vec3<f32>;
  if isD0 {
    result = loadCoveredAverage(pixel);
  } else {
    result = fixedDownsample(in.uv);
  }
  return vec4<f32>(clampLinearHdr(result), 1.0);
}
