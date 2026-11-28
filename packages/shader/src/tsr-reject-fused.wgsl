// Fused single-pass compute UE 5.8.1 TSRRejectShading (TSRRejectShading.usf:670-912).
// Replaces five passes (clamp, measure, resurrect-clamp, resurrect-measure, reject) and eight
// rgba16float transient textures; resurrection is workgroup-ballot gated as in UE (usf:762-790).
// 16x16 output core inside a 28x28 LDS tile (6-pixel apron); 12,552 bytes < 16 KiB portable limit.
@group(0) @binding(0) var tsrInput: texture_2d<f32>;
@group(0) @binding(1) var tsrHistory: texture_2d<f32>;
@group(0) @binding(2) var tsrMoireError: texture_2d<f32>;
@group(0) @binding(3) var tsrDecimate: texture_2d<f32>;
@group(0) @binding(4) var tsrResurrected: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;
@group(0) @binding(6) var<uniform> params: TsrParams;
@group(0) @binding(7) var guideOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var decisionOutput: texture_storage_2d<rgba8unorm, write>;

var<workgroup> rejectTileA: array<vec2<u32>, 784>;
var<workgroup> rejectTileB: array<vec2<u32>, 784>;
var<workgroup> rejectAnyResurrect: atomic<u32>;
var<workgroup> rejectDoResurrect: u32;

fn tsrRejectPack(v: vec4<f32>) -> vec2<u32> {
  return vec2<u32>(pack2x16float(v.xy), pack2x16float(v.zw));
}
fn tsrRejectUnpack(p: vec2<u32>) -> vec4<f32> {
  return vec4<f32>(unpack2x16float(p.x), unpack2x16float(p.y));
}

// Run AnnihilateMutually3x3 -> MeasureRejection -> Max3x3(Median3x3) across the 28x28 tile.
// Called unconditionally for ordinary history, and under a uniform workgroup ballot for resurrection.
fn tsrFusedMeasureBlend(
  tileOrigin: vec2<i32>,
  lane: u32,
  coreLocal: vec2<i32>,
  useMoire: bool,
  useResurrect: bool,
) -> TsrBlend {
  let error = vec3<f32>(TSR_QUANTIZATION_ERROR);
  let minL = max(vec2<i32>(0), -tileOrigin);
  let maxL = min(vec2<i32>(27), vec2<i32>(params.inputSize) - 1 - tileOrigin);

  // Step 0: load 28x28 SMCS input and candidate history into LDS.
  for (var n = lane; n < 784u; n += 256u) {
    let lx = i32(n % 28u);
    let ly = i32(n / 28u);
    let p = tileOrigin + vec2<i32>(lx, ly);
    let a = tsrSmcs(tsrLoadIn(tsrInput, p).rgb);
    var b: vec3<f32>;
    if (useResurrect) { b = tsrSmcs(tsrLoadIn(tsrResurrected, p).rgb); }
    else { b = tsrSmcs(tsrLoadIn(tsrHistory, p).rgb); }
    rejectTileA[n] = tsrRejectPack(vec4<f32>(a, 0.0));
    rejectTileB[n] = tsrRejectPack(vec4<f32>(b, 0.0));
  }
  workgroupBarrier();

  // Step 1: AnnihilateMutually3x3 first pass (26x26 -> [1..26]).
  var s1A: array<vec3<f32>, 3>;
  var s1B: array<vec3<f32>, 3>;
  for (var k = 0u; k < 3u; k++) {
    let n = lane + k * 256u;
    if (n >= 676u) { continue; }
    let lx = i32(n % 26u) + 1;
    let ly = i32(n / 26u) + 1;
    var inLo = vec3<f32>(1e30);
    var inHi = vec3<f32>(-1e30);
    var hiLo = vec3<f32>(1e30);
    var hiHi = vec3<f32>(-1e30);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let j = u32(q.y * 28 + q.x);
        let a = tsrRejectUnpack(rejectTileA[j]).rgb;
        let b = tsrRejectUnpack(rejectTileB[j]).rgb;
        inLo = min(inLo, a);
        inHi = max(inHi, a);
        hiLo = min(hiLo, b);
        hiHi = max(hiHi, b);
      }
    }
    let cPos = clamp(vec2<i32>(lx, ly), minL, maxL);
    let cIdx = u32(cPos.y * 28 + cPos.x);
    let cA = tsrRejectUnpack(rejectTileA[cIdx]).rgb;
    let cB = tsrRejectUnpack(rejectTileB[cIdx]).rgb;
    s1A[k] = tsrFastClamp(cB, inLo, inHi);
    s1B[k] = tsrFastClamp(cA, hiLo, hiHi);
  }
  workgroupBarrier();
  for (var k = 0u; k < 3u; k++) {
    let n = lane + k * 256u;
    if (n >= 676u) { continue; }
    let lx = i32(n % 26u) + 1;
    let ly = i32(n / 26u) + 1;
    let idx = u32(ly * 28 + lx);
    rejectTileA[idx] = tsrRejectPack(vec4<f32>(s1A[k], 0.0));
    rejectTileB[idx] = tsrRejectPack(vec4<f32>(s1B[k], 0.0));
  }
  workgroupBarrier();

  // Step 2: AnnihilateMutually3x3 second pass (24x24 -> [2..25]).
  var s2A: array<vec3<f32>, 3>;
  var s2B: array<vec3<f32>, 3>;
  for (var k = 0u; k < 3u; k++) {
    let n = lane + k * 256u;
    if (n >= 576u) { continue; }
    let lx = i32(n % 24u) + 2;
    let ly = i32(n / 24u) + 2;
    var inLo = vec3<f32>(1e30);
    var inHi = vec3<f32>(-1e30);
    var hiLo = vec3<f32>(1e30);
    var hiHi = vec3<f32>(-1e30);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let j = u32(q.y * 28 + q.x);
        let a = tsrRejectUnpack(rejectTileA[j]).rgb;
        let b = tsrRejectUnpack(rejectTileB[j]).rgb;
        inLo = min(inLo, a);
        inHi = max(inHi, a);
        hiLo = min(hiLo, b);
        hiHi = max(hiHi, b);
      }
    }
    let p = tileOrigin + vec2<i32>(lx, ly);
    let ownA = tsrSmcs(tsrLoadIn(tsrInput, p).rgb);
    var ownB: vec3<f32>;
    if (useResurrect) { ownB = tsrSmcs(tsrLoadIn(tsrResurrected, p).rgb); }
    else { ownB = tsrSmcs(tsrLoadIn(tsrHistory, p).rgb); }
    s2A[k] = tsrFastClamp(ownA, inLo, inHi);
    s2B[k] = tsrFastClamp(ownB, hiLo, hiHi);
  }
  workgroupBarrier();
  for (var k = 0u; k < 3u; k++) {
    let n = lane + k * 256u;
    if (n >= 576u) { continue; }
    let lx = i32(n % 24u) + 2;
    let ly = i32(n / 24u) + 2;
    let idx = u32(ly * 28 + lx);
    rejectTileA[idx] = tsrRejectPack(vec4<f32>(s2A[k], 0.0));
    rejectTileB[idx] = tsrRejectPack(vec4<f32>(s2B[k], 0.0));
  }
  workgroupBarrier();

  // Step 3: 3x3 blur, total variation, inputBoxSize and filteredHistory (22x22 -> [3..24]).
  // Registers keep filteredInput, filteredHistory and inputBoxSize for the exact same threads in Step 4.
  var myBlur: array<vec3<f32>, 2>;
  var myTv: array<vec3<f32>, 2>;
  var myFiltHist: array<vec3<f32>, 2>;
  var myBoxSize: array<vec3<f32>, 2>;
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 484u) { continue; }
    let lx = i32(n % 22u) + 3;
    let ly = i32(n / 22u) + 3;
    var blur = vec3<f32>(0.0);
    var sumC = vec3<f32>(0.0);
    var sumD = vec3<f32>(0.0);
    var centerC = vec3<f32>(0.0);
    var centerD = vec3<f32>(0.0);
    var filtHist = vec3<f32>(0.0);
    var cLo = vec3<f32>(1e30);
    var cHi = vec3<f32>(-1e30);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let j = u32(q.y * 28 + q.x);
        let c = tsrRejectUnpack(rejectTileA[j]).rgb;
        let h = tsrRejectUnpack(rejectTileB[j]).rgb;
        let own = tsrSmcs(tsrLoadIn(tsrInput, tileOrigin + q).rgb);
        let d = abs(own - c);
        let w = tsrBlurWeight(x, y);
        blur += c * w;
        filtHist += h * w;
        sumC += c;
        sumD += d;
        cLo = min(cLo, c);
        cHi = max(cHi, c);
        if (x == 0 && y == 0) { centerC = c; centerD = d; }
      }
    }
    myBlur[k] = blur;
    myTv[k] = min(abs(1.125 * centerD - 0.125 * sumD), abs(1.125 * centerC - 0.125 * sumC));
    myFiltHist[k] = filtHist;
    myBoxSize[k] = cHi - cLo;
  }
  workgroupBarrier();
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 484u) { continue; }
    let lx = i32(n % 22u) + 3;
    let ly = i32(n / 22u) + 3;
    let idx = u32(ly * 28 + lx);
    rejectTileA[idx] = tsrRejectPack(vec4<f32>(myBlur[k], 0.0));
    rejectTileB[idx] = tsrRejectPack(vec4<f32>(myTv[k], 0.0));
  }
  workgroupBarrier();

  // Step 4: MeasureRejection (20x20 -> [4..23], same thread ownership as Step 3).
  var myRaw: array<vec4<f32>, 2>;
  var myDelta: array<vec3<f32>, 2>;
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 484u) { continue; }
    let lx = i32(n % 22u) + 3;
    let ly = i32(n / 22u) + 3;
    if (lx < 4 || lx > 23 || ly < 4 || ly > 23) { continue; }
    var boxLow = vec3<f32>(1e30);
    var boxHigh = vec3<f32>(-1e30);
    var variation = vec3<f32>(0.0);
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let q = clamp(vec2<i32>(lx + x, ly + y), minL, maxL);
        let j = u32(q.y * 28 + q.x);
        let b = tsrRejectUnpack(rejectTileA[j]).rgb;
        let tv = tsrRejectUnpack(rejectTileB[j]).rgb;
        boxLow = min(boxLow, b);
        boxHigh = max(boxHigh, b);
        variation += tv * tsrBlurWeight(x, y);
      }
    }
    let inputBoxSize = myBoxSize[k];
    var clampError = max(error, variation);
    clampError = max(clampError, inputBoxSize * (TSR_FILTERING_WEIGHT * 0.25));
    clampError = clampError + error;
    boxLow = boxLow - clampError;
    boxHigh = boxHigh + clampError;
    let moireError = select(0.0, tsrLoadIn(tsrMoireError, tileOrigin + vec2<i32>(lx, ly)).r, useMoire);
    let moireSize = vec3<f32>(TSR_MOIRE_LUMA_TO_CHANNEL * moireError);
    let filteredHistory = myFiltHist[k];
    let filteredInput = myBlur[k];
    let clampedFiltered = tsrFastClamp(filteredHistory,
      min(boxLow, boxHigh - moireSize), max(boxHigh, boxLow + moireSize));
    let clampedEnergy = abs(clampedFiltered - filteredHistory);
    let energySum = clampedEnergy.x + clampedEnergy.y + clampedEnergy.z;
    let energyAmount = select(vec3<f32>(0.0), clampedEnergy / energySum, energySum > 0.0);
    var boxSize = inputBoxSize * TSR_FILTERING_WEIGHT + error * (2.0 * TSR_FILTERING_WEIGHT);
    boxSize = max(boxSize, energyAmount * (TSR_FILTERING_WEIGHT * 3.0 * moireError));
    let delta = max(abs(filteredInput - filteredHistory), boxSize);
    let factor = saturate(vec3<f32>(1.0) - clampedEnergy / delta);
    myRaw[k] = vec4<f32>(clampedEnergy, tsrMin3(factor));
    myDelta[k] = delta;
  }
  workgroupBarrier();
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 484u) { continue; }
    let lx = i32(n % 22u) + 3;
    let ly = i32(n / 22u) + 3;
    if (lx < 4 || lx > 23 || ly < 4 || ly > 23) { continue; }
    let idx = u32(ly * 28 + lx);
    rejectTileA[idx] = tsrRejectPack(myRaw[k]);
    rejectTileB[idx] = tsrRejectPack(vec4<f32>(myDelta[k], 0.0));
  }
  workgroupBarrier();

  // Step 5a: Median3x3 of raw (18x18 -> [5..22]); keep delta in rejectTileB until Step 5b.
  var myMed: array<vec4<f32>, 2>;
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 324u) { continue; }
    let lx = i32(n % 18u) + 5;
    let ly = i32(n / 18u) + 5;
    var lows = vec4<f32>(-1e30);
    var highs = vec4<f32>(1e30);
    var mids: array<vec4<f32>, 3>;
    for (var x = -1; x <= 1; x++) {
      let qa = clamp(vec2<i32>(lx + x, ly - 1), minL, maxL);
      let qb = clamp(vec2<i32>(lx + x, ly), minL, maxL);
      let qc = clamp(vec2<i32>(lx + x, ly + 1), minL, maxL);
      let a = tsrRejectUnpack(rejectTileA[u32(qa.y * 28 + qa.x)]);
      let b = tsrRejectUnpack(rejectTileA[u32(qb.y * 28 + qb.x)]);
      let c = tsrRejectUnpack(rejectTileA[u32(qc.y * 28 + qc.x)]);
      lows = max(lows, min(a, min(b, c)));
      highs = min(highs, max(a, max(b, c)));
      mids[x + 1] = tsrMedian3(a, b, c);
    }
    myMed[k] = tsrMedian3(lows, tsrMedian3(mids[0], mids[1], mids[2]), highs);
  }
  workgroupBarrier();
  for (var k = 0u; k < 2u; k++) {
    let n = lane + k * 256u;
    if (n >= 324u) { continue; }
    let lx = i32(n % 18u) + 5;
    let ly = i32(n / 18u) + 5;
    rejectTileA[u32(ly * 28 + lx)] = tsrRejectPack(myMed[k]);
  }
  workgroupBarrier();

  // Step 5b: MaxRGBMinA3x3 on 16x16 output core ([6..21]).
  let clx = coreLocal.x + 6;
  let cly = coreLocal.y + 6;
  var energy = vec3<f32>(0.0);
  var clampBlend = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = clamp(vec2<i32>(clx + x, cly + y), minL, maxL);
      let med = tsrRejectUnpack(rejectTileA[u32(q.y * 28 + q.x)]);
      energy = max(energy, med.rgb);
      clampBlend = min(clampBlend, med.a);
    }
  }
  let cPos = clamp(vec2<i32>(clx, cly), minL, maxL);
  let delta = tsrRejectUnpack(rejectTileB[u32(cPos.y * 28 + cPos.x)]).rgb;
  return TsrBlend(tsrMin3(saturate(vec3<f32>(1.0) - energy / delta)), clampBlend);
}

@compute @workgroup_size(16, 16)
fn tsr_reject_fused(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>,
  @builtin(local_invocation_id) local: vec3<u32>,
  @builtin(local_invocation_index) lane: u32,
) {
  let tileOrigin = vec2<i32>(group.xy * 16u) - vec2<i32>(6);
  let coreLocal = vec2<i32>(local.xy);
  let inside = all(id.xy < vec2<u32>(params.inputSize));
  let pixel = vec2<i32>(id.xy);

  if (lane == 0u) {
    atomicStore(&rejectAnyResurrect, 0u);
    rejectDoResurrect = 0u;
  }

  var blend = tsrFusedMeasureBlend(tileOrigin, lane, coreLocal, true, false);
  let input = tsrLoadIn(tsrInput, pixel).rgb;
  var history = tsrLoadIn(tsrHistory, pixel);
  let disoccluded = history.a < 0.5;
  var resurrection = vec4<f32>(0.0, 0.0, 0.0, -1.0);
  var closer = false;
  if (inside && params.resurrection.x != 0u && blend.rejection < 0.5) {
    resurrection = tsrLoadIn(tsrResurrected, pixel);
    if (resurrection.a >= 0.0 && tsrResurrectionCloser(tsrInput, tsrHistory, tsrResurrected, pixel)) {
      closer = true;
      atomicOr(&rejectAnyResurrect, 1u);
    }
  }
  workgroupBarrier();
  if (lane == 0u) {
    rejectDoResurrect = atomicLoad(&rejectAnyResurrect);
  }
  workgroupBarrier();

  var resurrect = false;
  if (workgroupUniformLoad(&rejectDoResurrect) != 0u) {
    let candidate = tsrFusedMeasureBlend(tileOrigin, lane, coreLocal, false, true);
    if (closer && candidate.rejection - blend.rejection > 0.1) {
      resurrect = true;
      blend = candidate;
      history = vec4<f32>(resurrection.rgb, history.a);
    }
  }

  if (!inside) { return; }
  let rejection = blend.rejection;
  var boxLow = vec3<f32>(1e30);
  var boxHigh = vec3<f32>(-1e30);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = tsrSmcs(tsrLoadIn(tsrInput, pixel + vec2<i32>(x, y)).rgb);
      boxLow = min(boxLow, c);
      boxHigh = max(boxHigh, c);
    }
  }
  let aliasingVisible = dot(boxHigh - boxLow, vec3<f32>(0.299, 0.587, 0.114)) > 0.05;
  let freshHistory = disoccluded && !resurrect;
  let spatialAntiAlias = aliasingVisible && (rejection < 0.25 || freshHistory);
  let ratio = params.inputSize.x / params.outputSize.x;
  let theoric = 1.0 / (1.0 + TSR_HISTORY_SAMPLE_COUNT / (ratio * ratio));
  let total = select(saturate(1.0 - rejection * 4.0), 1.0, disoccluded);
  let blendFinal = max(max(theoric, 1.0 - rejection), total);
  let exposedInput = tsrAddPerceptionAdd(tsrGcsToLinear(input));
  let exposedHistory = tsrAddPerceptionAdd(tsrGcsToLinear(history.rgb));
  let guide = tsrLinearToGcs(tsrRemovePerceptionAdd(
    exposedInput * blendFinal - exposedHistory * (blendFinal - 1.0)));
  let inputUncertainty = tsrLoadIn(tsrDecimate, pixel).r;
  var historyUncertainty = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let uncertainty = tsrLoadIn(tsrDecimate, pixel + vec2<i32>(x, y)).g;
      historyUncertainty = min(historyUncertainty,
        select(uncertainty, resurrection.a, resurrect && x == 0 && y == 0));
    }
  }
  let disableClamp = select(min(blend.clampBlend, min(inputUncertainty, historyUncertainty)), 0.0, freshHistory);
  let increaseValidity = select(blend.clampBlend, 0.0, freshHistory);
  let mask = (select(0.0, 1.0, spatialAntiAlias) + select(0.0, 2.0, resurrect)) * (1.0 / 255.0);
  textureStore(guideOutput, pixel, vec4<f32>(guide, inputUncertainty));
  textureStore(decisionOutput, pixel, vec4<f32>(rejection, disableClamp, 1.0 - increaseValidity, mask));
}
