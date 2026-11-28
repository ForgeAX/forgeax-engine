// UE 5.8.1 TSRSpatialAntiAliasing.usf SpatialAntiAliasingCS (CONFIG_ITERATIONS 8, quality preset 2,
// r.TSR.RejectionAntiAliasingQuality clamped to 2, cpp:1968) with TSRSpatialAntiAliasing.ush
// FindBrowsingDirection (ush:68-130), BrowseNeighborhoodBilinearOptimized (ush:265-373),
// ComputeDistanceToEdge (ush:448-495) and the 4 bit offset encoding (ush:497-560).
// The input-resolution luma is derived from the scene color texel by texel, so the bilinear
// tap between two neighbours is their exact average and both lanes read by texture load.
const TSR_AA_MIN_LUMINANCE: f32 = 0.05;
const TSR_AA_ITERATIONS: i32 = 8;
const TSR_AA_MAX_10_BIT: f32 = 64512.0;

// ComputeSpatialAntiAliaserLumaLDR (ShadingAnalysis.ush:173-187), SpatialAAExposure 0.5.
fn tsrAaLuma(p: vec2<i32>) -> f32 {
  let c = min(textureLoad(tsrScene, clamp(p, vec2<i32>(0), vec2<i32>(params.inputSize) - 1), 0).rgb *
    tsrExposure(params.flicker.z), vec3<f32>(TSR_AA_MAX_10_BIT));
  let luma = dot(c, vec3<f32>(0.299, 0.587, 0.114));
  return luma / (0.5 + luma);
}
// BilinearSampleAAInput (ush:44-60): a sample half a texel toward the edge side.
fn tsrAaBilinear(p: vec2<i32>, side: vec2<i32>) -> f32 {
  return 0.5 * (tsrAaLuma(p) + tsrAaLuma(p + side));
}
// EncodeSpatialAntiAliasingOffset / Decode (ush:497-560): 4 bits per channel over +-0.5.
fn tsrAaQuantize(v: vec2<f32>) -> vec2<f32> {
  return (clamp(round(v * 14.0) + 8.0, vec2<f32>(1.0), vec2<f32>(15.0)) - 8.0) * (0.5 / 7.0);
}
// (texel offset toward the edge, NoiseFiltering, 0, 0) for one input pixel. The reject stage stores
// ShouldSpatialAntiAlias (ShadingAnalysis.ush:204-211) in the first decision.a bit; other pixels stay zero. The
// reconstruct stage weights the offset (UpdateHistory.usf:1093-1105).
fn tsrSpatial(pixel: vec2<i32>) -> vec4<f32> {
  if (!tsrDecisionSpatial(textureLoad(tsrDecision, pixel, 0).a)) { return vec4<f32>(0.0); }
  let c = tsrAaLuma(pixel);
  let n = tsrAaLuma(pixel + vec2<i32>(0, -1));
  let s = tsrAaLuma(pixel + vec2<i32>(0, 1));
  let e = tsrAaLuma(pixel + vec2<i32>(1, 0));
  let w = tsrAaLuma(pixel + vec2<i32>(-1, 0));
  let ne = tsrAaLuma(pixel + vec2<i32>(1, -1));
  let nw = tsrAaLuma(pixel + vec2<i32>(-1, -1));
  let se = tsrAaLuma(pixel + vec2<i32>(1, 1));
  let sw = tsrAaLuma(pixel + vec2<i32>(-1, 1));
  // FindBrowsingDirection.
  let horizontalVariation = abs(0.5 * (ne + nw) - n) + abs(0.5 * (e + w) - c) + abs(0.5 * (se + sw) - s);
  let verticalVariation = abs(0.5 * (ne + se) - e) + abs(0.5 * (n + s) - c) + abs(0.5 * (nw + sw) - w);
  let diffN = abs(n - c);
  let diffS = abs(s - c);
  let diffE = abs(e - c);
  let diffW = abs(w - c);
  let browseVertically = horizontalVariation > verticalVariation;
  let noise = max(
    saturate(2.0 * abs(0.5 * (e + w) - c) - max(diffE, diffW)),
    saturate(2.0 * abs(0.5 * (n + s) - c) - max(diffN, diffS)));
  var direction = vec2<i32>(1, 0);
  var side = vec2<i32>(0, select(1, -1, diffN > diffS));
  var edgeLuma = select(s, n, diffN > diffS);
  if (browseVertically) {
    direction = vec2<i32>(0, 1);
    side = vec2<i32>(select(1, -1, diffW > diffE), 0);
    edgeLuma = select(e, w, diffW > diffE);
  }
  let lumaDelta = abs(edgeLuma - c) * 0.5;
  if (lumaDelta <= TSR_AA_MIN_LUMINANCE) { return vec4<f32>(0.0, 0.0, noise, 0.0); }
  let browseDelta = saturate(lumaDelta / TSR_AA_MIN_LUMINANCE);
  // BrowseNeighborhoodBilinearOptimized: walk both ways along the edge until the bilinear luma
  // leaves the band between the pixel and its edge neighbour (usf:99-153).
  let merged = 0.5 * (edgeLuma + c);
  let minLuma = merged - 0.25 * abs(edgeLuma - c);
  let maxLuma = merged + 0.25 * abs(edgeLuma - c);
  let edgeMoreLuminous = edgeLuma > c;
  var stopMinP = false;
  var stopMaxP = false;
  var stopMinN = false;
  var stopMaxN = false;
  var lengthP = TSR_AA_ITERATIONS;
  var lengthN = TSR_AA_ITERATIONS;
  for (var i = 1; i <= TSR_AA_ITERATIONS; i++) {
    let sampleP = tsrAaBilinear(pixel + direction * i, side);
    let sampleN = tsrAaBilinear(pixel - direction * i, side);
    let byMinP = sampleP < minLuma && !stopMaxP;
    let byMaxP = sampleP > maxLuma && !stopMinP;
    let byMinN = sampleN < minLuma && !stopMaxN;
    let byMaxN = sampleN > maxLuma && !stopMinN;
    stopMinP = stopMinP || byMinP;
    stopMaxP = stopMaxP || byMaxP;
    stopMinN = stopMinN || byMinN;
    stopMaxN = stopMaxN || byMaxN;
    lengthP -= select(0, 1, stopMinP || stopMaxP);
    lengthN -= select(0, 1, stopMinN || stopMaxN);
  }
  let incrementP = select(stopMinP, stopMaxP, edgeMoreLuminous);
  let incrementN = select(stopMinN, stopMaxN, edgeMoreLuminous);
  let decrementP = select(stopMaxP, stopMinP, edgeMoreLuminous);
  let decrementN = select(stopMaxN, stopMinN, edgeMoreLuminous);
  // ComputeDistanceToEdge.
  let inverseLength = 1.0 / (1.0 + f32(lengthN) + f32(lengthP));
  var distance = 0.0;
  if (!incrementN && !incrementP && !decrementP && !decrementN) {
    distance = 0.0;
  } else if (incrementN && incrementP) {
    distance = 0.5;
  } else if (decrementN && decrementP) {
    distance = 0.0;
  } else if (incrementN) {
    distance = 0.5 - (f32(lengthN) + 0.5) * inverseLength;
  } else if (incrementP) {
    distance = 0.5 - (f32(lengthP) + 0.5) * inverseLength;
  }
  let offset = tsrAaEncode(tsrAaQuantize(vec2<f32>(side) * (browseDelta * distance)));
  return vec4<f32>(offset, round(noise * 255.0) / 255.0, 0.0);
}
