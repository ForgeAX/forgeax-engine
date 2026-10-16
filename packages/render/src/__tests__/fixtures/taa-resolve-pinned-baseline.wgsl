// Pinned test-only baseline for taa-neighborhood-equivalence.dawn.test.ts.
// Copied from packages/shader/src/taa-resolve.wgsl at commit fc641abefbdc07a074d2b8473b52b37bcb26f85d.
// SHA-256 (source body): 4a7a7c7def9cb860da2a92ad960aa6be1d41d6c6551e0e77093cd5d2cc99ea9d.
// This fixture is intentionally immutable when production TAA changes.
#define_import_path forgeax_view::taa_resolve

// Keep the fragment input shape explicit for compilers that tree-shake imported
// type declarations before resolving the vertex entry point.
struct FullscreenOutput {
  @builtin(position) position : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

fn fullscreen_triangle(vertex_index : u32) -> FullscreenOutput {
  var x : f32 = -1.0;
  var y : f32 = -1.0;
  if (vertex_index == 1u) {
    x = 3.0;
  }
  if (vertex_index == 2u) {
    y = 3.0;
  }
  let u : f32 = (x + 1.0) * 0.5;
  let v : f32 = 1.0 - (y + 1.0) * 0.5;
  var out : FullscreenOutput;
  out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>(u, v);
  return out;
}

struct TaaResolveParams {
  currentJitterUv : vec2<f32>,
  historyValid : u32,
  temporalFrameIndex : u32,
  hasSecondaryReactivity : u32,
};

struct TaaResolveOutput {
  @location(0) color : vec4<f32>,
  @location(1) temporal : vec4<f32>,
  @location(2) stability : f32,
};

@group(1) @binding(0) var currentColor : texture_2d<f32>;
@group(1) @binding(1) var currentSampler : sampler;
@group(1) @binding(2) var historyColor : texture_2d<f32>;
@group(1) @binding(3) var historySampler : sampler;
@group(1) @binding(4) var historyTemporal : texture_2d<f32>;
@group(1) @binding(5) var temporalSampler : sampler;
@group(1) @binding(6) var currentTemporal : texture_2d<f32>;
@group(1) @binding(7) var currentTemporalSampler : sampler;
@group(1) @binding(8) var<uniform> params : TaaResolveParams;
@group(1) @binding(9) var historyStability : texture_2d<f32>;
@group(1) @binding(10) var secondaryReactivity : texture_2d<f32>;

fn sampleSecondaryReactivity(uv : vec2<f32>) -> f32 {
  if (params.hasSecondaryReactivity == 0u) { return 0.0; }
  let size = vec2<i32>(textureDimensions(secondaryReactivity));
  let center = vec2<i32>(uv * vec2<f32>(size));
  var reactive = 0.0;
  // Conservatively cover the reconstruction footprint, including producers
  // on a reduced-resolution lattice. Never interpolate a motion flag away.
  for (var y = -3; y <= 3; y++) {
    for (var x = -3; x <= 3; x++) {
      let pixel = clamp(center + vec2<i32>(x, y), vec2<i32>(0), size - vec2<i32>(1));
      let value = textureLoad(secondaryReactivity, pixel, 0).r;
      if (value != value || abs(value) > 3.402823e+38) { return 1.0; }
      reactive = max(reactive, clamp(value, 0.0, 1.0));
    }
  }
  return reactive;
}

// One complete eight-phase jitter cycle must settle after motion/rejection.
// Store the state in a private r8unorm attachment; temporal-v1's
// reactive lane includes secondary-source changes; receiver velocity and depth
// remain unchanged for downstream effects such as Motion Blur.
const TAA_STABILITY_FRAMES : f32 = 8.0;
const TAA_HISTORY_SETTLE_FRAMES : f32 = 128.0;

fn taaStableAge(previous : f32, accepted : bool, temporal : vec4<f32>, priorMotion : vec2<f32>) -> f32 {
  let stationary = max(length(temporal.xy), length(priorMotion)) < 1e-5;
  let count = min(floor(clamp(previous, 0.0, 1.0) * 255.0 + 0.5), TAA_HISTORY_SETTLE_FRAMES);
  return select(0.0, min(count + 1.0, TAA_HISTORY_SETTLE_FRAMES), accepted && temporal.w == 0.0 && stationary);
}

fn rgbToYCoCg(rgb : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(rgb, vec3<f32>(0.25, 0.5, 0.25)),
    dot(rgb, vec3<f32>(0.5, 0.0, -0.5)),
    dot(rgb, vec3<f32>(-0.25, 0.5, -0.25)),
  );
}

fn yCoCgToRgb(value : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(value.x + value.y - value.z, value.x + value.z, value.x - value.y - value.z);
}

fn luminance(rgb : vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn taaAccumulationWeight(frameIndex : u32, steadyWeight : f32) -> f32 {
  let samples = f32(frameIndex);
  return min(steadyWeight, samples / (samples + 1.0));
}

// Karis, High Quality Temporal Supersampling (SIGGRAPH 2014), slide 20.
// With linear luminance, these normalized weights are equivalent to
// T(C)=C/(1+luma(C)), temporal blending, then T^-1(C)=C/(1-luma(C)).
// One scalar per color preserves chroma and avoids an unstable explicit
// inverse near one. History and the post-processing output remain HDR.
fn blendTaaHistory(current : vec3<f32>, history : vec3<f32>, historyWeight : f32) -> vec3<f32> {
  let currentWeight = (1.0 - historyWeight) / (1.0 + max(0.0, luminance(current)));
  let previousWeight = historyWeight / (1.0 + max(0.0, luminance(history)));
  return (current * currentWeight + history * previousWeight) / max(currentWeight + previousWeight, 0.00001);
}

// Render-target FP16 conversion can consistently round down. Feeding that
// error back every frame darkens history, increasingly so at high weights.
// Choose between the two exactly representable neighbors without bias before
// the attachment conversion. One shared RGB threshold preserves neutral color;
// frame/pixel hashing avoids locking rounding to the eight jitter phases.
fn taaRoundingNoise(pixel : vec2<u32>, frame : u32) -> f32 {
  var bits = pixel.x * 0x9e3779b9u + pixel.y * 0x85ebca6bu + frame * 0xc2b2ae35u;
  bits = (bits ^ (bits >> 16u)) * 0x7feb352du;
  bits = (bits ^ (bits >> 15u)) * 0x846ca68bu;
  bits = bits ^ (bits >> 16u);
  return f32(bits >> 8u) / 16777216.0;
}

fn roundTaaHistory(color : vec3<f32>, noise : f32) -> vec3<f32> {
  let magnitude = min(abs(color), vec3<f32>(65504.0));
  let exponent = (bitcast<vec3<u32>>(magnitude) >> vec3<u32>(23u)) & vec3<u32>(255u);
  // Normal spacing is 2^(exponent - 127 - 10); subnormals use 2^-24.
  let step = bitcast<vec3<f32>>((max(exponent, vec3<u32>(113u)) - vec3<u32>(10u)) << vec3<u32>(23u));
  let scaled = magnitude / step;
  let integral = floor(scaled);
  let rounded = (integral + select(vec3<f32>(0.0), vec3<f32>(1.0), vec3<f32>(noise) < scaled - integral)) * step;
  return select(rounded, -rounded, color < vec3<f32>(0.0));
}

struct TaaCurrentTemporal {
  temporal : vec4<f32>,
  depthEdge : bool,
};

fn closestCurrentTemporal(pixel : vec2<i32>, dimensions : vec2<i32>) -> TaaCurrentTemporal {
  let clamped = clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));
  var closest = textureLoad(currentTemporal, clamped, 0);
  var farthestDepth = closest.z;
  var hasBackground = closest.z < 0.0;
  // Jitter changes coverage at silhouettes and subpixel gaps. Select the
  // nearest valid surface in the reconstruction footprint, carrying its
  // motion and reactive flag together. The negative clear depth is absent
  // geometry, not a surface closer than every real sample.
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let samplePixel = clamp(pixel + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1));
      let candidate = textureLoad(currentTemporal, samplePixel, 0);
      hasBackground = hasBackground || candidate.z < 0.0;
      farthestDepth = max(farthestDepth, candidate.z);
      if (candidate.z >= 0.0 && (closest.z < 0.0 || candidate.z < closest.z)) {
        closest = candidate;
      }
    }
  }
  // Three.js TRAA exempts current depth edges from the disocclusion test.
  // Use the existing logarithmic-depth tolerance, not a perspective threshold.
  return TaaCurrentTemporal(closest, closest.z >= 0.0 &&
    (hasBackground || farthestDepth - closest.z > 0.0025 + closest.z * 0.01));
}

fn taaNeighborhood(uv : vec2<f32>, current : vec3<f32>, settled : bool) -> array<vec3<f32>, 25> {
  let dimensions = vec2<i32>(textureDimensions(currentColor));
  let pixel = vec2<i32>(uv * vec2<f32>(dimensions));
  var samples : array<vec3<f32>, 25>;
  var index = 0u;
  // The symmetric union of the 3x3 bilinear supports stays centered across
  // subpixel jitter signs. A 4x4 box anchored to floor(uv*size-0.5) shifts by
  // one texel at zero jitter, periodically clipping otherwise valid history.
  // During motion retain the eight nearest neighbors plus current only.
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let delta = vec2<i32>(x, y);
      if (!settled && (any(abs(delta) > vec2<i32>(1)) || all(delta == vec2<i32>(0)))) {
        samples[index] = current;
      } else {
        samples[index] = textureLoad(currentColor, clamp(pixel + vec2<i32>(x, y), vec2<i32>(0), dimensions - vec2<i32>(1)), 0).rgb;
      }
      index++;
    }
  }
  return samples;
}

fn clipTaaHistory(current : vec3<f32>, neighbors : array<vec3<f32>, 25>, history : vec3<f32>) -> vec3<f32> {
  // Build bounds in the clipping space. Transforming RGB extrema is invalid:
  // the chroma axes contain negative coefficients and can collapse or invert.
  var clipMin = rgbToYCoCg(current);
  var clipMax = clipMin;
  for (var i = 0u; i < 25u; i++) {
    let sample = rgbToYCoCg(neighbors[i]);
    clipMin = min(clipMin, sample);
    clipMax = max(clipMax, sample);
  }
  return yCoCgToRgb(clamp(rgbToYCoCg(history), clipMin, clipMax));
}

struct TaaClipDecision {
  history : vec3<f32>,
  state : f32,
};

fn resolveTaaClipping(clipped : vec3<f32>, history : vec3<f32>, previous : f32, age : f32) -> TaaClipDecision {
  // Codes 0..128 are accepted stationary age. The remaining 42 codes store
  // 1..7 consecutive misses in one of six signed RGB directions. Reversing
  // direction or finding support breaks the streak, so one dark jitter phase
  // cannot erase the accumulated coverage of a thin bright surface. Eight
  // persistent misses restore clipping even without motion. Color clipping
  // must not invalidate the accepted geometric reconstruction footprint.
  if (age < TAA_HISTORY_SETTLE_FRAMES) {
    // Release phase-local clipping while accumulation is still responsive.
    // Waiting until the 0.99 history weight has engaged locks in the earlier
    // clipped mean and makes a static image drift for hundreds more frames.
    return TaaClipDecision(mix(clipped, history, smoothstep(TAA_STABILITY_FRAMES, 64.0, age)), age / 255.0);
  }
  let delta = clipped - history;
  let magnitude = abs(delta);
  var axis = 0u;
  if (magnitude.y > magnitude.x) { axis = 1u; }
  if (magnitude.z > magnitude[axis]) { axis = 2u; }
  let scale = max(1.0, max(abs(history.x), max(abs(history.y), abs(history.z))));
  if (magnitude[axis] <= scale * 0.00001) {
    return TaaClipDecision(history, TAA_HISTORY_SETTLE_FRAMES / 255.0);
  }
  let direction = axis * 2u + select(0u, 1u, delta[axis] > 0.0);
  let code = u32(floor(clamp(previous, 0.0, 1.0) * 255.0 + 0.5));
  var streak = 1u;
  if (code >= 129u && code <= 170u) {
    let prior = code - 129u;
    if (prior / 7u == direction) { streak = prior % 7u + 2u; }
  }
  if (streak >= 8u) { return TaaClipDecision(clipped, TAA_HISTORY_SETTLE_FRAMES / 255.0); }
  return TaaClipDecision(history, f32(129u + direction * 7u + streak - 1u) / 255.0);
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertexIndex);
}

fn fs_taa_resolve(in : FullscreenOutput) -> TaaResolveOutput {
  let dimensions = vec2<i32>(textureDimensions(currentColor, 0));
  let currentUv = in.uv + params.currentJitterUv;
  let current = textureSampleLevel(currentColor, currentSampler, currentUv, 0.0);
  let pixel = vec2<i32>(currentUv * vec2<f32>(dimensions));
  let currentSample = closestCurrentTemporal(pixel, dimensions);
  let sceneTemporal = currentSample.temporal;
  let temporal = vec4<f32>(sceneTemporal.xyz,
    max(sceneTemporal.w, sampleSecondaryReactivity(currentUv)));
  let historyUv = in.uv - temporal.xy;
  let historyInBounds = all(historyUv >= vec2<f32>(0.0)) && all(historyUv <= vec2<f32>(1.0));
  let history = textureSampleLevel(historyColor, historySampler, historyUv, 0.0);
  let previousTemporal = textureSampleLevel(historyTemporal, temporalSampler, historyUv, 0.0);
  let depthDelta = abs(previousTemporal.z - temporal.z);
  let depthThreshold = 0.0025 + temporal.z * 0.01;
  let rejected =
    params.historyValid == 0u ||
    !historyInBounds ||
    temporal.z < 0.0 ||
    ((previousTemporal.z < 0.0 || depthDelta > depthThreshold) && !currentSample.depthEdge);
  let historyPixel = clamp(vec2<i32>(historyUv * vec2<f32>(dimensions)), vec2<i32>(0), dimensions - vec2<i32>(1));
  let priorStability = textureLoad(historyStability, historyPixel, 0).r;
  let stableAge = taaStableAge(priorStability, !rejected, temporal, previousTemporal.xy);
  let clipped = clipTaaHistory(current.rgb, taaNeighborhood(currentUv, current.rgb, stableAge >= TAA_STABILITY_FRAMES), history.rgb);
  let clipping = resolveTaaClipping(clipped, history.rgb, priorStability, stableAge);
  let clippedHistoryRgb = clipping.history;
  let reactiveFactor = 1.0 - clamp(temporal.w, 0.0, 1.0);
  let velocityFactor = 1.0 - clamp(length(temporal.xy) * 64.0, 0.0, 1.0);
  // Motion ending is not the same as settled radiance. Keep fast recovery
  // for 64 stationary frames before reducing the residual jitter response.
  // Any rejection, receiver motion, or secondary reactivity resets this age.
  let steadyWeight = mix(0.95, 0.99, smoothstep(64.0, TAA_HISTORY_SETTLE_FRAMES, stableAge));
  let progressiveWeight = taaAccumulationWeight(params.temporalFrameIndex, steadyWeight);
  // Depth is a disocclusion gate, not a continuous history fade. A sloped
  // static surface changes sampled depth under jitter without changing its
  // identity; attenuating accepted history makes those edges oscillate.
  let historyWeight = progressiveWeight * reactiveFactor * velocityFactor;
  let resolved = select(blendTaaHistory(current.rgb, clippedHistoryRgb, historyWeight), current.rgb, rejected);
  return TaaResolveOutput(
    vec4<f32>(roundTaaHistory(resolved, taaRoundingNoise(vec2<u32>(in.position.xy), params.temporalFrameIndex)), current.a),
    temporal,
    clipping.state,
  );
}

@fragment
fn fs_main(in : FullscreenOutput) -> TaaResolveOutput {
  return fs_taa_resolve(in);
}
