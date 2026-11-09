// Both lanes evaluate the same unjittered analysis and flicker history.
struct TsrAnalysisResult {
  @location(0) guide: vec4<f32>,
  @location(1) moire: vec4<f32>,
  @location(2) decision: vec4<f32>,
};
fn tsrAnalyze(pixel: vec2<i32>, tileOrigin: vec2<i32>) -> TsrAnalysisResult {
  let uv = (vec2<f32>(pixel) + 0.5) / params.inputSize;
  let currentUv = uv + params.jitter;
  let inputGeometry = tsrClosestTemporal(sceneTemporal, currentUv, 1);
  var geometry = inputGeometry;
  if (params.hasCoverage != 0u) {
    let ratio=vec2<f32>(textureDimensions(coverage))/params.inputSize;
    let scale=max(ratio.x,ratio.y);
    let radius=min(3,i32(ceil(scale)))+i32(ceil(max(scale-1.0,0.0)*0.5));
    let full=tsrClosestTemporal(coverage,currentUv,radius);
    if (full.packed.z >= 0.0) { geometry = full; }
    // A clear output sample cannot erase a real input-raster witness.
    // Positive-depth invalidity on either producer remains a hard veto.
    if (inputGeometry.packed.z >= 0.0 && inputGeometry.packed.w >= 1.0) { geometry = inputGeometry; }
  }
  let temporal = unpackSceneTemporalV1(geometry.packed);
  let previousUv = uv - temporal.motionUv;
  let previousGuideUv = previousUv * params.previousInputSize /
    vec2<f32>(textureDimensions(previousGuide));
  let oldTemporal = unpackSceneTemporalV1(textureLoad(previousTemporal,
    tsrPixel(previousUv, textureDimensions(previousTemporal)), 0));
  let speed = length(temporal.motionUv * vec2<f32>(textureDimensions(previousTemporal)));
  let valid = params.historyValid != 0u && params.analysisValid != 0u &&
    tsrInside(previousUv) && tsrGeometryMatches(temporal, oldTemporal, geometry.depthEdge, speed);
  var mean = vec3<f32>(0.0);
  var opaqueMean = vec3<f32>(0.0);
  var low = vec3<f32>(1.0);
  var high = vec3<f32>(0.0);
  // A phase-correct three-texel box integrates encoded current samples onto
  // the unjittered input lattice. Its fractional boundary covers four texels;
  // Guide history and rejection are never stored on the jittered raster grid.
  let position = currentUv * params.inputSize;
  let base = vec2<i32>(floor(position-1.5));
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let rawPixel = base + vec2<i32>(x,y);
      let axis = clamp(vec2<f32>(2.0)-abs(vec2<f32>(rawPixel)+0.5-position),vec2<f32>(0.0),vec2<f32>(1.0));
      let weight = axis.x*axis.y;
      let p = clamp(rawPixel,vec2<i32>(0),vec2<i32>(params.inputSize)-1);
      let c = tsrAnalyzeGuide(p, tileOrigin);
      mean += c * (weight/9.0);
      opaqueMean += tsrAnalyzeOpaque(p, tileOrigin) * (weight/9.0);
      if (weight > 0.0) { low = min(low,c); high = max(high,c); }
    }
  }
  let oldGuide = textureSampleLevel(previousGuide, linearSampler, previousGuideUv, 0.0).rgb;
  // Time statistics share the unjittered Guide lattice. Cancel object motion;
  // preserve discrete confidence and idle state with one point read.
  let moireUv = (uv-temporal.motionUv)*params.previousInputSize /
    vec2<f32>(textureDimensions(previousMoire));
  let oldMoire = textureLoad(previousMoire, tsrPixel(moireUv,textureDimensions(previousMoire)), 0);
  let luma = tsrLuma(opaqueMean);
  // Transparency, fog and post producers can alter final color without a
  // corresponding opaque velocity. They never qualify for anti-flicker
  // relaxation merely because the underlying opaque geometry is stationary.
  let modified = max(max(abs(opaqueMean.x-mean.x), abs(opaqueMean.y-mean.y)), abs(opaqueMean.z-mean.z)) > 0.01;
  let gradient = select(0.0, luma - oldMoire.x, valid);
  let oldGradient = select(0.0, oldMoire.y * 2.0 - 1.0, valid);
  let stationary = valid && speed < 0.25 && temporal.reactive < 0.01 && !modified;
  let significant = abs(gradient) > 0.0001;
  let reversed = significant && gradient * oldGradient < -0.00000001;
  // A sparse subpixel surface may appear once per jitter cycle. Track a
  // bounded peak envelope instead of averaging that coverage down to zero.
  let decay = exp(-clamp(params.deltaSeconds, 0.001, 0.25) / 0.5);
  let amplitude = select(0.0, max(max(oldMoire.z*decay,abs(gradient)),tsrLuma(high-low)), valid);
  // Keep the last significant direction through a coverage plateau. Pack
  // reversal confidence in the integer part and idle time in the fraction;
  // an unchanged signal expires within one 60 Hz jitter cycle in real time.
  var reversals = clamp(floor(oldMoire.w),0.0,8.0);
  let idleStep = params.deltaSeconds*60.0/8.0;
  var idle = fract(oldMoire.w) + idleStep;
  var direction = select(oldGradient,gradient,significant);
  if (reversed) {
    idle = idleStep;
    reversals = min(reversals+1.0,8.0);
  }
  if (!stationary || idle >= 1.0) { reversals = 0.0; idle = 0.0; direction = 0.0; }
  let age = max(reversals-1.0,0.0)/7.0;
  let relaxation = select(0.0, min(amplitude * age, 1.0), stationary);
  let range = high - low;
  let tolerance = vec3<f32>(1.0/255.0 + relaxation) + range * 0.5;
  // A stationary signal cannot lose support solely to RGBA8 Guide rounding.
  let error = max(abs(mean - oldGuide) - vec3<f32>(1.0/255.0), vec3<f32>(0.0)) / tolerance;
  // Expected variation inside the current footprint retains full support;
  // only its continuous shoulder erodes history. Sub-threshold residuals
  // must not restart the reconstruction at every Halton phase.
  let acceptance = select(0.0, clamp(2.0 - max(max(error.x,error.y),error.z),0.0,1.0), valid);
  return TsrAnalysisResult(vec4<f32>(mean, 1.0),
    vec4<f32>(luma, direction * 0.5 + 0.5, amplitude, reversals + idle),
    vec4<f32>(acceptance, relaxation, temporal.reactive, select(0.0, 1.0, valid)));
}
