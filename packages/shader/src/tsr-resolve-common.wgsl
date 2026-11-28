// UE 5.8.1 TSRResolveHistory.usf reference path (ResolveHistoryCS, usf:297-345): the history,
// which may be larger than the output (r.TSR.History.ScreenPercentage, cpp:2059-2070), is
// downsampled to the output with a 4x4 Mitchell-Netravali kernel (B = C = 1/3, usf:82-83,
// KERNEL_SIZE 4) weighted by HdrWeight4 (TSRColorSpace.ush:166-238), clamped to the min/max of
// the sixteen taps (CONFIG_CLAMP) and to the 10 bit float range (usf:355). UE samples bilinear at
// texel centers, which is a texel load clamped to the viewport edge.
const TSR_MN_B: f32 = 1.0 / 3.0;
const TSR_MN_C: f32 = 1.0 / 3.0;
const TSR_RESOLVE_MAX_10_BIT: f32 = 64512.0;

// MitchellNetravali (usf:105-124); the linear term of the inner cubic is zero.
fn tsrMitchellNetravali(d: f32) -> f32 {
  if (d < 1.0) {
    return (6.0 - 2.0*TSR_MN_B)/6.0 + d*d*((-18.0 + 12.0*TSR_MN_B + 6.0*TSR_MN_C)/6.0
      + d*(12.0 - 9.0*TSR_MN_B - 6.0*TSR_MN_C)/6.0);
  }
  if (d < 2.0) {
    return (8.0*TSR_MN_B + 24.0*TSR_MN_C)/6.0 + d*((-12.0*TSR_MN_B - 48.0*TSR_MN_C)/6.0
      + d*((6.0*TSR_MN_B + 30.0*TSR_MN_C)/6.0 + d*(-TSR_MN_B - 6.0*TSR_MN_C)/6.0));
  }
  return 0.0;
}

fn tsrResolveHistory(pixel: vec2<i32>) -> vec4<f32> {
  let historySize = vec2<f32>(textureDimensions(tsrHistory));
  // Position of the output pixel center in the history (DispatchThreadToHistoryPixelPos).
  let position = (vec2<f32>(pixel) + 0.5) * historySize / params.outputSize;
  let topLeft = floor(position + (0.5 - 2.0)) + 0.5;
  var color = vec4<f32>(0.0);
  var weight = 0.0;
  var low = vec4<f32>(3.0e38);
  var high = vec4<f32>(0.0);
  for (var x = 0; x < 4; x++) {
    for (var y = 0; y < 4; y++) {
      let samplePosition = topLeft + vec2<f32>(f32(x), f32(y));
      let texel = clamp(vec2<i32>(floor(samplePosition)), vec2<i32>(0), vec2<i32>(historySize) - 1);
      let sample = textureLoad(tsrHistory, texel, 0);
      let offset = abs(samplePosition - position);
      let w = tsrMitchellNetravali(offset.x) * tsrMitchellNetravali(offset.y) * tsrHdrWeight4(sample.rgb, params.flicker.z);
      low = min(low, sample);
      high = max(high, sample);
      color += w * sample;
      weight += w;
    }
  }
  // SafeRcp: a zero weight sum yields black.
  let resolved = select(vec4<f32>(0.0), color / weight, weight != 0.0);
  return clamp(clamp(resolved, low, high), vec4<f32>(0.0), vec4<f32>(TSR_RESOLVE_MAX_10_BIT));
}
