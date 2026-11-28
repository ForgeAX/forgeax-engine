// Fused single-pass compute UE 5.8.1 ComputeMoireError (TSRShadingAnalysis.ush:215-491).
// Replaces four separate passes (clamp, measure, update, history) and three rgba16float transients.
// 16x16 output core inside a 32x32 LDS tile (8-pixel apron); 12,288 bytes < 16 KiB portable limit.
@group(0) @binding(0) var moireOpaqueTex: texture_2d<f32>;
@group(0) @binding(1) var moirePreviousTex: texture_2d<f32>;
@group(0) @binding(2) var moireSceneTex: texture_2d<f32>;
@group(0) @binding(3) var moireGuideTex: texture_2d<f32>;
@group(0) @binding(4) var moireEdgeTex: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;
@group(0) @binding(6) var<uniform> params: TsrParams;
@group(0) @binding(7) var moireHistoryOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var moireErrorOutput: texture_storage_2d<rgba16float, write>;

var<workgroup> moireA: array<u32, 1024>;
var<workgroup> moireB: array<u32, 1024>;
var<workgroup> moireC: array<u32, 1024>;

fn tsrMoirePack(a: f32, b: f32) -> u32 { return pack2x16float(vec2<f32>(a, b)); }
fn tsrMoireUnpack(v: u32) -> vec2<f32> { return unpack2x16float(v); }
fn tsrMoireMedian3(a: vec2<f32>, b: vec2<f32>, c: vec2<f32>) -> vec2<f32> {
  return max(min(a, b), min(max(a, b), c));
}

@compute @workgroup_size(16, 16)
fn tsr_moire(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  let tileOrigin = vec2<i32>(group.xy * 16u) - vec2<i32>(8);
  let minL = max(vec2<i32>(0), -tileOrigin);
  let maxL = min(vec2<i32>(31), vec2<i32>(params.inputSize) - 1 - tileOrigin);
  let exposure = tsrExposure(params.flicker.z);

  // Step 0: load 32x32 pre-fog GLuma^2 (InputLuma in SMCS) and previous moire luma^2.
  for (var n = lane; n < 1024u; n += 256u) {
    let p = tileOrigin + vec2<i32>(i32(n & 31u), i32(n >> 5u));
    let a = tsrLoadIn(moireOpaqueTex, p).x;
    let b = tsrLoadIn(moirePreviousTex, p).x;
    moireA[n] = tsrMoirePack(a * a, b * b);
  }
  workgroupBarrier();

  // Step 1: AnnihilateMutuallySingleChannel3x3 first pass (30x30 -> [1..30]).
  for (var n = lane; n < 900u; n += 256u) {
    let lx = i32(n % 30u) + 1;
    let ly = i32(n / 30u) + 1;
    var inBox = vec2<f32>(1e30, -1e30);
    var histBox = vec2<f32>(1e30, -1e30);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let v = tsrMoireUnpack(moireA[u32(q.y * 32 + q.x)]);
        inBox = vec2<f32>(min(inBox.x, v.x), max(inBox.y, v.x));
        histBox = vec2<f32>(min(histBox.x, v.y), max(histBox.y, v.y));
      }
    }
    let idx = u32(ly * 32 + lx);
    let cPos = clamp(vec2<i32>(lx, ly), minL, maxL);
    let center = tsrMoireUnpack(moireA[u32(cPos.y * 32 + cPos.x)]);
    let boundary = min(max(center.y, inBox.x), inBox.y);
    let guide = min(max(center.x, histBox.x), histBox.y);
    moireB[idx] = tsrMoirePack(boundary, guide);
  }
  workgroupBarrier();

  // Step 2: AnnihilateMutuallySingleChannel3x3 second pass (28x28 -> [2..29]).
  for (var n = lane; n < 784u; n += 256u) {
    let lx = i32(n % 28u) + 2;
    let ly = i32(n / 28u) + 2;
    var inBound = vec2<f32>(1e30, -1e30);
    var histBound = vec2<f32>(1e30, -1e30);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let v = tsrMoireUnpack(moireB[u32(q.y * 32 + q.x)]);
        inBound = vec2<f32>(min(inBound.x, v.x), max(inBound.y, v.x));
        histBound = vec2<f32>(min(histBound.x, v.y), max(histBound.y, v.y));
      }
    }
    let idx = u32(ly * 32 + lx);
    let cPos = clamp(vec2<i32>(lx, ly), minL, maxL);
    let center = tsrMoireUnpack(moireA[u32(cPos.y * 32 + cPos.x)]);
    let inputC2 = min(max(center.x, inBound.x), inBound.y);
    let historyC2 = min(max(center.y, histBound.x), histBound.y);
    moireC[idx] = tsrMoirePack(inputC2, historyC2);
  }
  workgroupBarrier();

  // Step 3: 3x3 blur + total variation of inputC2 and |own - inputC2| (26x26 -> [3..28]).
  for (var n = lane; n < 676u; n += 256u) {
    let lx = i32(n % 26u) + 3;
    let ly = i32(n / 26u) + 3;
    var blur = 0.0;
    var sumC = 0.0;
    var sumD = 0.0;
    var centerC = 0.0;
    var centerD = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let j = u32(q.y * 32 + q.x);
        let c = tsrMoireUnpack(moireC[j]).x;
        let own = tsrMoireUnpack(moireA[j]).x;
        let d = abs(own - c);
        blur += c * tsrBlurWeight(x, y);
        sumC += c;
        sumD += d;
        if (x == 0 && y == 0) { centerC = c; centerD = d; }
      }
    }
    let tv = min(abs(1.125 * centerD - 0.125 * sumD), abs(1.125 * centerC - 0.125 * sumC));
    moireB[u32(ly * 32 + lx)] = tsrMoirePack(blur, tv);
  }
  workgroupBarrier();

  // Step 4: MeasureRejection single-channel (24x24 -> [4..27]) + post-opaque luma modification.
  var rawTmp: array<vec2<f32>, 3>;
  var dmTmp: array<vec2<f32>, 3>;
  for (var k = 0u; k < 3u; k++) {
    let n = lane + k * 256u;
    if (n >= 576u) { continue; }
    let lx = i32(n % 24u) + 4;
    let ly = i32(n / 24u) + 4;
    let cPos = clamp(vec2<i32>(lx, ly), minL, maxL);
    let cIdx = u32(cPos.y * 32 + cPos.x);
    var boxLow = 1e30;
    var boxHigh = -1e30;
    var c2Low = 1e30;
    var c2High = -1e30;
    var variation = 0.0;
    var filteredHistory = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let j = u32(q.y * 32 + q.x);
        let bt = tsrMoireUnpack(moireB[j]);
        let ch = tsrMoireUnpack(moireC[j]);
        let w = tsrBlurWeight(x, y);
        boxLow = min(boxLow, bt.x);
        boxHigh = max(boxHigh, bt.x);
        c2Low = min(c2Low, ch.x);
        c2High = max(c2High, ch.x);
        variation += bt.y * w;
        filteredHistory += ch.y * w;
      }
    }
    let filteredInput = tsrMoireUnpack(moireB[cIdx]).x;
    let inputBoxSize = c2High - c2Low;
    var clampError = max(TSR_QUANTIZATION_ERROR, variation);
    clampError = max(clampError, inputBoxSize * (TSR_FILTERING_WEIGHT * 0.25));
    clampError = clampError + TSR_QUANTIZATION_ERROR;
    boxLow = boxLow - clampError;
    boxHigh = boxHigh + clampError;
    let boxSize = inputBoxSize * TSR_FILTERING_WEIGHT + TSR_QUANTIZATION_ERROR * (2.0 * TSR_FILTERING_WEIGHT);
    let clampedHistory = min(max(filteredHistory, boxLow), boxHigh);
    let delta = max(abs(filteredInput - filteredHistory), boxSize);
    let energy = abs(clampedHistory - filteredHistory);
    rawTmp[k] = vec2<f32>(energy, saturate(1.0 - max(energy, 0.0) / delta));
    var modification = 0.0;
    if (lx >= 5 && lx <= 26 && ly >= 5 && ly <= 26) {
      let own = tsrMoireUnpack(moireA[cIdx]).x;
      let sceneGcs = tsrLinearToGcs(tsrLoadIn(moireSceneTex, tileOrigin + vec2<i32>(lx, ly)).rgb * exposure);
      let sceneLuma = dot(sceneGcs * sceneGcs, vec3<f32>(1.0 / 3.0));
      modification = max(abs(own - sceneLuma) - TSR_MOIRE_LUMA_ENCODING_ERROR, 0.0);
    }
    dmTmp[k] = vec2<f32>(delta, modification);
  }
  workgroupBarrier();
  for (var k = 0u; k < 3u; k++) {
    let n = lane + k * 256u;
    if (n >= 576u) { continue; }
    let lx = i32(n % 24u) + 4;
    let ly = i32(n / 24u) + 4;
    let idx = u32(ly * 32 + lx);
    moireC[idx] = tsrMoirePack(rawTmp[k].x, rawTmp[k].y);
    moireB[idx] = tsrMoirePack(dmTmp[k].x, dmTmp[k].y);
  }
  workgroupBarrier();

  // Step 5a: Median3x3 of (energy, rawRejection) (22x22 -> [5..26]).
  var medTmp: array<vec2<f32>, 2>;
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 484u) { continue; }
    let lx = i32(n % 22u) + 5;
    let ly = i32(n / 22u) + 5;
    var lows = vec2<f32>(-1e30);
    var highs = vec2<f32>(1e30);
    var mids: array<vec2<f32>, 3>;
    for (var x = -1; x <= 1; x++) {
      let qa = clamp(vec2<i32>(lx + x, ly - 1), minL, maxL);
      let qb = clamp(vec2<i32>(lx + x, ly), minL, maxL);
      let qc = clamp(vec2<i32>(lx + x, ly + 1), minL, maxL);
      let a = tsrMoireUnpack(moireC[u32(qa.y * 32 + qa.x)]);
      let b = tsrMoireUnpack(moireC[u32(qb.y * 32 + qb.x)]);
      let c = tsrMoireUnpack(moireC[u32(qc.y * 32 + qc.x)]);
      lows = max(lows, min(a, min(b, c)));
      highs = min(highs, max(a, max(b, c)));
      mids[x + 1] = tsrMoireMedian3(a, b, c);
    }
    medTmp[k] = tsrMoireMedian3(lows, tsrMoireMedian3(mids[0], mids[1], mids[2]), highs);
  }
  workgroupBarrier();
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 484u) { continue; }
    let lx = i32(n % 22u) + 5;
    let ly = i32(n / 22u) + 5;
    moireC[u32(ly * 32 + lx)] = tsrMoirePack(medTmp[k].x, medTmp[k].y);
  }
  workgroupBarrier();

  // Step 5b: MaxRMinG3x3 + simulated TSRUpdateHistory + flicker gradient test (20x20 -> [6..25]).
  var updTmp: array<vec2<f32>, 2>;
  var ownTmp: array<vec2<f32>, 2>;
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 400u) { continue; }
    let lx = i32(n % 20u) + 6;
    let ly = i32(n / 20u) + 6;
    let cPos = clamp(vec2<i32>(lx, ly), minL, maxL);
    let cIdx = u32(cPos.y * 32 + cPos.x);
    var energy = 0.0;
    var clampBlend = 1.0;
    var filteredModification = 0.0;
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let j = u32(q.y * 32 + q.x);
        let med = tsrMoireUnpack(moireC[j]);
        energy = max(energy, med.x);
        clampBlend = min(clampBlend, med.y);
        filteredModification += tsrMoireUnpack(moireB[j]).y * tsrBlurWeight(x, y);
      }
    }
    let delta = tsrMoireUnpack(moireB[cIdx]).x;
    let blendFinal = saturate(1.0 - max(energy, 0.0) / delta);
    let input = tsrMoireUnpack(moireA[cIdx]).x;
    let ql = clamp(vec2<i32>(lx - 1, ly), minL, maxL);
    let qr = clamp(vec2<i32>(lx + 1, ly), minL, maxL);
    let qt = clamp(vec2<i32>(lx, ly - 1), minL, maxL);
    let qd = clamp(vec2<i32>(lx, ly + 1), minL, maxL);
    let l = tsrMoireUnpack(moireA[u32(ql.y * 32 + ql.x)]).x;
    let r = tsrMoireUnpack(moireA[u32(qr.y * 32 + qr.x)]).x;
    let t = tsrMoireUnpack(moireA[u32(qt.y * 32 + qt.x)]).x;
    let d = tsrMoireUnpack(moireA[u32(qd.y * 32 + qd.x)]).x;
    let low = min(input, min(min(l, r), min(t, d)));
    let high = max(input, max(max(l, r), max(t, d)));
    let previous = tsrLoadIn(moirePreviousTex, tileOrigin + vec2<i32>(lx, ly));
    let previousLuma = previous.x * previous.x;
    let finalPrevious = mix(min(max(previousLuma, low), high), previousLuma, clampBlend);
    let finalBlend = max(1.0 - blendFinal, TSR_MOIRE_MIN_BLEND);
    let finalHistory = input * finalBlend - finalPrevious * (finalBlend - 1.0);
    let ghosting = input * TSR_MOIRE_MIN_BLEND - previousLuma * (TSR_MOIRE_MIN_BLEND - 1.0);
    let rawGradient = finalHistory - ghosting;
    let gradient = sign(rawGradient) * max(abs(rawGradient) - filteredModification, 0.0);
    let previousGradient = tsrMoireGradient(previous.y);
    let withinError = abs(gradient) < TSR_MOIRE_ENCODING_ERROR || abs(previousGradient) < TSR_MOIRE_ENCODING_ERROR;
    let isFlicker = select(1.0, 0.0,
      gradient * previousGradient > 0.0 || withinError || params.historyValid == 0u);
    updTmp[k] = vec2<f32>(min(abs(previousGradient), abs(gradient)) * isFlicker, isFlicker);
    ownTmp[k] = vec2<f32>(gradient, sqrt(max(finalHistory, 0.0)));
  }
  workgroupBarrier();
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 400u) { continue; }
    let lx = i32(n % 20u) + 6;
    let ly = i32(n / 20u) + 6;
    let idx = u32(ly * 32 + lx);
    moireA[idx] = tsrMoirePack(updTmp[k].x, updTmp[k].y);
    moireC[idx] = tsrMoirePack(ownTmp[k].x, ownTmp[k].y);
  }
  workgroupBarrier();

  // Step 6: 5x5 dilation + history update on 16x16 output core ([8..23]).
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let pixel = vec2<i32>(id.xy);
  let lx = i32(local.x) + 8;
  let ly = i32(local.y) + 8;
  let idx = u32(ly * 32 + lx);
  var variationContribution = 0.0;
  var countContribution = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
      let neighbour = tsrMoireUnpack(moireA[u32(q.y * 32 + q.x)]);
      variationContribution = max(variationContribution, neighbour.x);
      countContribution = max(countContribution, neighbour.y);
    }
  }
  let ownUpd = tsrMoireUnpack(moireA[idx]);
  let ownVal = tsrMoireUnpack(moireC[idx]);
  let previous = tsrLoadIn(moirePreviousTex, pixel);
  let isStatic = 1.0 - tsrLoadIn(moireEdgeTex, pixel).a;
  let previousGradient = tsrMoireGradient(previous.y);
  let previousVariation = previous.z * (1.0 - TSR_MOIRE_MIN_BLEND) * isStatic;
  let previousCount = previous.w * TSR_MOIRE_MAX_COUNT * (1.0 - TSR_MOIRE_MIN_BLEND) * isStatic;
  var gradient = previousGradient * (TSR_MOIRE_MIN_BLEND - 1.0) * (ownUpd.y - 1.0) + ownVal.x;
  var variation = previousVariation + variationContribution;
  var count = previousCount + countContribution;
  if (tsrLoadIn(moireGuideTex, pixel).a < 0.5) {
    gradient = 0.0;
    variation = 0.0;
    count = 0.0;
  }
  let quantized = floor(count * (255.0 / TSR_MOIRE_MAX_COUNT)) * (TSR_MOIRE_MAX_COUNT / 255.0);
  let inverseCount = select(0.0, 1.0 / count, count > 0.0);
  variation = variation * quantized * inverseCount;
  let fadeIn = saturate(count * params.flicker.x - 0.5);
  let error = (abs(variation * inverseCount) + count * TSR_MOIRE_ENCODING_ERROR) * fadeIn;
  let modification = tsrMoireUnpack(moireB[idx]).y;
  textureStore(moireHistoryOutput, pixel,
    vec4<f32>(ownVal.y, gradient * (127.0 / 255.0) + 127.0 / 255.0, variation, quantized / TSR_MOIRE_MAX_COUNT));
  textureStore(moireErrorOutput, pixel, vec4<f32>(saturate(error * isStatic - modification), 0.0, 0.0, 0.0));
}
