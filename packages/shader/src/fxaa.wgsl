#define_import_path forgeax_view::fxaa

// @forgeax/engine-shader - fxaa.wgsl
// (feat-20260528-fxaa-post-processing / w4; algorithm rewritten
//  feat-20260531-fxaa-shader-correctness-fix).
//
// FXAA 3.11 fragment shader -- faithful port of the canonical Simon
// Rodriguez reference (same lineage as Bevy's WGSL port), adapted to
// forgeax naga_oil conventions. Hardcoded "High" quality preset: 12-step
// edge search with compile-time step multipliers (the only UBO field is the
// final-output dither switch; there are no quality #ifdef branches).
//
// Vertex stage: imports the SSOT fullscreen_triangle() from
// forgeax_view::common (single large triangle, research Finding 1).
//
// Fragment stage: computes perceptual luma via rgb2luma (sqrt of Rec.601
// weighted sum -- matches the canonical reference), performs a directional
// edge search, then blends along the edge with a sub-pixel aliasing term.
// Texture dimensions are obtained via textureDimensions() for resize-agnostic
// behavior (AC-08).
//
// Sampling and edge distances stay in texel space. Integer center/neighbour
// reads preserve the source grid; fractional luma-search samples use explicit
// bilinear interpolation. Normalized hardware filtering can perturb tied luma
// comparisons differently across backends and choose a different edge end.
// Final color keeps hardware filtering; its UNORM result may round by one byte.
//
// Bindings (group 0):
//   @binding(0) screenTexture : texture_2d<f32>  -- sampled pass-domain input
//   @binding(1) samp          : sampler           -- linear filterable sampler
//   @binding(2) params        : FxaaParams        -- final-output policy
// DOMAIN: the positive LUT path samples and writes linear-LDR values. Its
// ditherEnabled uniform is forced to zero because the following fs_encode_only
// surface writer owns the sole OETF and final dither. The legacy direct path
// may still enable the same bounded dither when FXAA is itself the surface
// writer; that legacy route remains display-encoded. FXAA never performs an
// OETF.

#import forgeax_view::common::{FullscreenOutput, ditherUnorm8}
#import forgeax_view::common::fullscreen_triangle

const EDGE_THRESHOLD_MIN: f32 = 0.0312;
const EDGE_THRESHOLD_MAX: f32 = 0.125;
const SUBPIXEL_QUALITY: f32 = 0.75;
const ITERATIONS: i32 = 12;

@group(0) @binding(0) var screenTexture: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

struct FxaaParams {
  // Zero for graph-owned linear-LDR intermediates; non-zero is reserved for a
  // direct final surface writer and never performs color-space conversion.
  ditherEnabled: f32,
  // Keep the uniform block at one 16-byte slot. WebGL2/GLES uniform-buffer
  // validation uses the std140-aligned block size, while the host uploads a
  // four-f32 (16-byte) payload.
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(2) var<uniform> params: FxaaParams;

fn rgb2luma(rgb: vec3<f32>) -> f32 {
  return sqrt(dot(rgb, vec3<f32>(0.299, 0.587, 0.114)));
}

fn loadColor(pixel: vec2<i32>) -> vec4<f32> {
  let last = vec2<i32>(textureDimensions(screenTexture)) - vec2<i32>(1);
  return textureLoad(screenTexture, clamp(pixel, vec2<i32>(0), last), 0);
}

fn sampleColor(position: vec2<f32>) -> vec4<f32> {
  let texel = position - vec2<f32>(0.5);
  let lower = vec2<i32>(floor(texel));
  let weight = fract(texel);
  let first = loadColor(lower);
  if weight.x == 0.0 {
    return mix(first, loadColor(lower + vec2<i32>(0, 1)), weight.y);
  }
  if weight.y == 0.0 {
    return mix(first, loadColor(lower + vec2<i32>(1, 0)), weight.x);
  }
  return mix(
    mix(first, loadColor(lower + vec2<i32>(1, 0)), weight.x),
    mix(loadColor(lower + vec2<i32>(0, 1)), loadColor(lower + vec2<i32>(1, 1)), weight.x),
    weight.y,
  );
}

fn sampleLuma(position: vec2<f32>) -> f32 {
  return rgb2luma(sampleColor(position).rgb);
}

// High-preset edge-search step multipliers (canonical FXAA 3.11 QUALITY
// table for the 12-tap variant): steps 0..4 = 1.0, then ramps to 8.0.
fn qualityStep(i: i32) -> f32 {
  if i < 5 {
    return 1.0;
  }
  if i == 5 {
    return 1.5;
  }
  if i < 10 {
    return 2.0;
  }
  if i == 10 {
    return 4.0;
  }
  return 8.0;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(in: FullscreenOutput) -> @location(0) vec4<f32> {
  // Pixel centers and all edge-search steps retain exact texel coordinates.
  let position = in.position.xy;

  let pixel = vec2<i32>(in.position.xy);
  let centerSample = loadColor(pixel);
  let centerColor = centerSample.rgb;
  let lumaCenter = rgb2luma(centerColor);

  // Lumas of the 4 direct neighbours.
  let lumaDown = rgb2luma(loadColor(pixel + vec2<i32>(0, 1)).rgb);
  let lumaUp = rgb2luma(loadColor(pixel + vec2<i32>(0, -1)).rgb);
  let lumaLeft = rgb2luma(loadColor(pixel + vec2<i32>(-1, 0)).rgb);
  let lumaRight = rgb2luma(loadColor(pixel + vec2<i32>(1, 0)).rgb);

  let lumaMin = min(lumaCenter, min(min(lumaDown, lumaUp), min(lumaLeft, lumaRight)));
  let lumaMax = max(lumaCenter, max(max(lumaDown, lumaUp), max(lumaLeft, lumaRight)));
  let lumaRange = lumaMax - lumaMin;

  // Not on an edge (or in a near-uniform region): pass the centre through.
  if lumaRange < max(EDGE_THRESHOLD_MIN, lumaMax * EDGE_THRESHOLD_MAX) {
    return vec4<f32>(
      select(centerColor, ditherUnorm8(centerColor, in.position.xy), params.ditherEnabled > 0.5),
      centerSample.a,
    );
  }

  // Lumas of the 4 corners.
  let lumaDownLeft = rgb2luma(loadColor(pixel + vec2<i32>(-1, 1)).rgb);
  let lumaUpRight = rgb2luma(loadColor(pixel + vec2<i32>(1, -1)).rgb);
  let lumaUpLeft = rgb2luma(loadColor(pixel + vec2<i32>(-1, -1)).rgb);
  let lumaDownRight = rgb2luma(loadColor(pixel + vec2<i32>(1, 1)).rgb);

  let lumaDownUp = lumaDown + lumaUp;
  let lumaLeftRight = lumaLeft + lumaRight;

  let lumaLeftCorners = lumaDownLeft + lumaUpLeft;
  let lumaDownCorners = lumaDownLeft + lumaDownRight;
  let lumaRightCorners = lumaDownRight + lumaUpRight;
  let lumaUpCorners = lumaUpRight + lumaUpLeft;

  // Estimate horizontal vs vertical gradient.
  let edgeHorizontal =
    abs(-2.0 * lumaLeft + lumaLeftCorners) +
    abs(-2.0 * lumaCenter + lumaDownUp) * 2.0 +
    abs(-2.0 * lumaRight + lumaRightCorners);
  let edgeVertical =
    abs(-2.0 * lumaUp + lumaUpCorners) +
    abs(-2.0 * lumaCenter + lumaLeftRight) * 2.0 +
    abs(-2.0 * lumaDown + lumaDownCorners);

  let isHorizontal = edgeHorizontal >= edgeVertical;

  // Negative then positive axis neighbours match the sign of stepLength.
  let luma1 = select(lumaLeft, lumaUp, isHorizontal);
  let luma2 = select(lumaRight, lumaDown, isHorizontal);
  let gradient1 = luma1 - lumaCenter;
  let gradient2 = luma2 - lumaCenter;

  let is1Steepest = abs(gradient1) >= abs(gradient2);
  let gradientScaled = 0.25 * max(abs(gradient1), abs(gradient2));

  // One-texel step perpendicular to the edge, in texel space.
  var stepLength = 1.0;

  var lumaLocalAverage = 0.0;
  if is1Steepest {
    stepLength = -stepLength;
    lumaLocalAverage = 0.5 * (luma1 + lumaCenter);
  } else {
    lumaLocalAverage = 0.5 * (luma2 + lumaCenter);
  }

  // Shift the position by half a texel toward the edge.
  var currentPosition = position;
  if isHorizontal {
    currentPosition.y += stepLength * 0.5;
  } else {
    currentPosition.x += stepLength * 0.5;
  }

  // Walk along the edge in both directions until the luma delta exceeds the
  // local gradient (= we left the edge) or we run out of iterations.
  let edgeStep = select(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 0.0),
    isHorizontal,
  );

  var position1 = currentPosition - edgeStep;
  var position2 = currentPosition + edgeStep;

  var lumaEnd1 = sampleLuma(position1) - lumaLocalAverage;
  var lumaEnd2 = sampleLuma(position2) - lumaLocalAverage;

  var reached1 = abs(lumaEnd1) >= gradientScaled;
  var reached2 = abs(lumaEnd2) >= gradientScaled;
  var reachedBoth = reached1 && reached2;

  if !reached1 {
    position1 -= edgeStep;
  }
  if !reached2 {
    position2 += edgeStep;
  }

  if !reachedBoth {
    var i = 1;
    loop {
      if i >= ITERATIONS || reachedBoth {
        break;
      }
      let q = qualityStep(i);
      if !reached1 {
        lumaEnd1 = sampleLuma(position1) - lumaLocalAverage;
        reached1 = abs(lumaEnd1) >= gradientScaled;
      }
      if !reached2 {
        lumaEnd2 = sampleLuma(position2) - lumaLocalAverage;
        reached2 = abs(lumaEnd2) >= gradientScaled;
      }
      reachedBoth = reached1 && reached2;
      if !reached1 {
        position1 -= edgeStep * q;
      }
      if !reached2 {
        position2 += edgeStep * q;
      }
      i += 1;
    }
  }

  // Distances to each end of the edge, along the edge axis.
  let distance1 = select(position.y - position1.y, position.x - position1.x, isHorizontal);
  let distance2 = select(position2.y - position.y, position2.x - position.x, isHorizontal);

  let isDirection1 = distance1 < distance2;
  let distanceFinal = min(distance1, distance2);
  let edgeThickness = distance1 + distance2;
  let pixelOffsetRaw = -distanceFinal / edgeThickness + 0.5;

  // Only blend if the centre luma is on the correct side of the edge --
  // guards against haloing.
  let isLumaCenterSmaller = lumaCenter < lumaLocalAverage;
  let correctVariation1 = (lumaEnd1 < 0.0) != isLumaCenterSmaller;
  let correctVariation2 = (lumaEnd2 < 0.0) != isLumaCenterSmaller;
  let correctVariation = select(correctVariation2, correctVariation1, isDirection1);
  let finalOffset = select(0.0, pixelOffsetRaw, correctVariation);

  // Sub-pixel anti-aliasing: weight by the local 3x3 luma contrast.
  let lumaAverage =
    (1.0 / 12.0) *
    (2.0 * (lumaDownUp + lumaLeftRight) + lumaLeftCorners + lumaRightCorners);
  let subPixelOffset1 = clamp(abs(lumaAverage - lumaCenter) / lumaRange, 0.0, 1.0);
  let subPixelOffset2 = (-2.0 * subPixelOffset1 + 3.0) * subPixelOffset1 * subPixelOffset1;
  let subPixelOffsetFinal = subPixelOffset2 * subPixelOffset2 * SUBPIXEL_QUALITY;

  let pixelOffset = max(finalOffset, subPixelOffsetFinal);

  // Apply the perpendicular offset, in texel space.
  var finalPosition = position;
  if isHorizontal {
    finalPosition.y += pixelOffset * stepLength;
  } else {
    finalPosition.x += pixelOffset * stepLength;
  }

  let finalSample = textureSampleLevel(screenTexture, samp, finalPosition / vec2<f32>(textureDimensions(screenTexture)), 0.0);
  let finalColor = finalSample.rgb;
  return vec4<f32>(
    select(finalColor, ditherUnorm8(finalColor, in.position.xy), params.ditherEnabled > 0.5),
    finalSample.a,
  );
}
