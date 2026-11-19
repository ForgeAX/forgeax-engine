#define_import_path forgeax_view::standard_output_v2

// Native Grade / Final output. The V1 TonemapParams ABI remains independent.
#import forgeax_view::common::{FullscreenOutput, fullscreen_triangle, ditherUnorm8}
#import forgeax_view::output_encoding::{toOutputGamut}
#import forgeax_view::tone_mapping::{mapTone}

// STANDARD_OUTPUT_V2_PARAMS_LAYOUT. Continuous effect values are uniforms,
// never source substitutions or shader variant axes.
struct StandardOutputV2Params {
  exposureTone: vec4<f32>, // neutral candidate, manual exposure, white point, tone mode
  whiteBalanceR: vec4<f32>,
  whiteBalanceG: vec4<f32>,
  whiteBalanceB: vec4<f32>,
  fringeLut: vec4<f32>, // red/green lens scales, start offset, LUT strength
  bloom: vec4<f32>, // intensity, radius, reserved
  vignette: vec4<f32>, // intensity, radius, softness, reserved
  vignetteColor: vec4<f32>,
  finish: vec4<f32>, // grain intensity, grain size, sharpen, elapsed seconds
  policy: vec4<u32>, // output gamut, linear Grade seam, dither, finish at encoding
};

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(1) @binding(0) var outputLut: texture_3d<f32>;
@group(1) @binding(1) var outputLutSampler: sampler;
@group(0) @binding(2) var<uniform> output: StandardOutputV2Params;
@group(0) @binding(3) var<uniform> candidate: vec4<f32>;
@group(0) @binding(4) var bloom0: texture_2d<f32>;
@group(0) @binding(5) var bloom1: texture_2d<f32>;
@group(0) @binding(6) var bloom2: texture_2d<f32>;
@group(0) @binding(7) var bloom3: texture_2d<f32>;
@group(0) @binding(8) var bloom4: texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}

fn encodeSrgb(color: vec3<f32>) -> vec3<f32> {
  let low = color * 12.92;
  let high = 1.055 * pow(max(color, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, color <= vec3<f32>(0.0031308));
}

fn decodeSrgb(color: vec3<f32>) -> vec3<f32> {
  return select(
    pow((color + 0.055) / 1.055, vec3<f32>(2.4)),
    color / 12.92,
    color <= vec3<f32>(0.04045),
  );
}

fn sampleScene(uv: vec2<f32>) -> vec4<f32> {
  let center = textureSampleLevel(source, sourceSampler, uv, 0.0);
  if (all(output.fringeLut.xy == vec2<f32>(0.0))) { return center; }
  // The same UE lens-space model as LensEffects; Bloom samples the unshifted
  // scene independently and is added only after this scene-color lookup.
  let lens = uv * 2.0 - 1.0;
  let pull = sign(lens) * saturate(abs(lens) - output.fringeLut.z);
  let redUv = (lens - pull * output.fringeLut.x) * 0.5 + 0.5;
  let greenUv = (lens - pull * output.fringeLut.y) * 0.5 + 0.5;
  return vec4<f32>(
    textureSampleLevel(source, sourceSampler, redUv, 0.0).r,
    textureSampleLevel(source, sourceSampler, greenUv, 0.0).g,
    center.b, center.a,
  );
}

fn bloomWeight(factor: f32) -> f32 { return mix(factor, 1.2 - factor, output.bloom.y); }

fn sampleBloom(uv: vec2<f32>) -> vec3<f32> {
  return output.bloom.x / 3.0 * (
    textureSampleLevel(bloom0, sourceSampler, uv, 0.0).rgb * bloomWeight(1.0)
    + textureSampleLevel(bloom1, sourceSampler, uv, 0.0).rgb * bloomWeight(0.8)
    + textureSampleLevel(bloom2, sourceSampler, uv, 0.0).rgb * bloomWeight(0.6)
    + textureSampleLevel(bloom3, sourceSampler, uv, 0.0).rgb * bloomWeight(0.4)
    + textureSampleLevel(bloom4, sourceSampler, uv, 0.0).rgb * bloomWeight(0.2)
  );
}

fn gradeScene(scene: vec3<f32>, bloom: vec3<f32>) -> vec3<f32> {
  // Working Rec.709 can be negative for valid wide-gamut colors. Bound
  // binary16 magnitude here; the selected output gamut owns the LDR clamp.
  let exposed = clamp(scene + bloom, vec3<f32>(-65504.0), vec3<f32>(65504.0)) * max(candidate.x, 0.0);
  let balanced = vec3<f32>(
    dot(output.whiteBalanceR.xyz, exposed),
    dot(output.whiteBalanceG.xyz, exposed),
    dot(output.whiteBalanceB.xyz, exposed),
  );
  return mapTone(balanced, output.exposureTone.y, output.exposureTone.z,
    u32(output.exposureTone.w), output.policy.x);
}

fn gradeLut(color: vec3<f32>) -> vec3<f32> {
  let size = f32(textureDimensions(outputLut).x);
  let encoded = encodeSrgb(clamp(color, vec3<f32>(0.0), vec3<f32>(1.0)));
  let uvw = encoded * ((size - 1.0) / size) + 0.5 / size;
  let mapped = decodeSrgb(textureSampleLevel(outputLut, outputLutSampler, uvw, 0.0).rgb);
  return mix(color, mapped, output.fringeLut.w);
}

fn luma(color: vec3<f32>) -> f32 { return dot(color, vec3<f32>(0.299, 0.587, 0.114)); }

fn hash12(position: vec2<f32>) -> f32 {
  var p = fract(vec3<f32>(position.x, position.y, position.x) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

fn finishNoise(color: vec3<f32>, position: vec2<f32>) -> vec3<f32> {
  var result = color;
  if (output.finish.x > 0.0) {
    let pixel = floor((position - 0.5) / max(output.finish.y, 1.0)) + 0.5;
    let seed = pixel + fract(output.finish.w * vec2<f32>(7.31, 3.17)) * vec2<f32>(311.7, 173.3);
    let grain = hash12(seed) + hash12(seed + 57.3) - 1.0;
    let light = luma(result);
    let weight = mix(1.0, 0.30, smoothstep(0.25, 0.9, light))
      * (0.35 + 0.65 * smoothstep(0.0, 0.08, light));
    result += grain * output.finish.x * weight;
  }
  if (output.policy.z != 0u) {
    result = ditherUnorm8(result, position);
  }
  return result;
}

fn finishGrade(color: vec3<f32>, alpha: f32, input: FullscreenOutput) -> vec4<f32> {
  let distance = length((input.uv - 0.5) * 2.0);
  let vignette = smoothstep(output.vignette.y,
    output.vignette.y + max(output.vignette.z, 0.0001), distance) * output.vignette.x;
  let linear = mix(color, output.vignetteColor.rgb, vignette);
  if (output.policy.y != 0u) { return vec4<f32>(linear, alpha); }
  return encodeGrade(linear, alpha, input);
}

fn encodeGrade(linear: vec3<f32>, alpha: f32, input: FullscreenOutput) -> vec4<f32> {
  var encoded = vec4<f32>(clamp(encodeSrgb(toOutputGamut(linear, output.policy.x)), vec3<f32>(0.0), vec3<f32>(1.0)), alpha);
  if (output.policy.w != 0u) {
    encoded = unpack4x8unorm(pack4x8unorm(encoded));
    encoded = vec4<f32>(finishNoise(encoded.rgb, input.position.xy), encoded.a);
  }
  return encoded;
}

@fragment fn fs_encode(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let linear = textureSampleLevel(source, sourceSampler, input.uv, 0.0);
  return encodeGrade(linear.rgb, linear.a, input);
}

@fragment fn fs_grade(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = sampleScene(input.uv);
  return finishGrade(gradeScene(scene.rgb, vec3<f32>(0.0)), scene.a, input);
}

@fragment fn fs_grade_lut(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = sampleScene(input.uv);
  return finishGrade(gradeLut(gradeScene(scene.rgb, vec3<f32>(0.0))), scene.a, input);
}

@fragment fn fs_grade_bloom(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = sampleScene(input.uv);
  return finishGrade(gradeScene(scene.rgb, sampleBloom(input.uv)), scene.a, input);
}

@fragment fn fs_grade_lut_bloom(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = sampleScene(input.uv);
  return finishGrade(gradeLut(gradeScene(scene.rgb, sampleBloom(input.uv))), scene.a, input);
}

fn filterEncoded(uv: vec2<f32>, fxaa: bool) -> vec4<f32> {
  let center = textureSampleLevel(source, sourceSampler, uv, 0.0);
  if (!fxaa && output.finish.z == 0.0) { return center; }
  let texel = 1.0 / vec2<f32>(textureDimensions(source));
  let nw = textureSampleLevel(source, sourceSampler, uv + texel * vec2<f32>(-1.0, -1.0), 0.0).rgb;
  let ne = textureSampleLevel(source, sourceSampler, uv + texel * vec2<f32>(1.0, -1.0), 0.0).rgb;
  let sw = textureSampleLevel(source, sourceSampler, uv + texel * vec2<f32>(-1.0, 1.0), 0.0).rgb;
  let se = textureSampleLevel(source, sourceSampler, uv + texel * vec2<f32>(1.0, 1.0), 0.0).rgb;
  let light = vec4<f32>(luma(nw), luma(ne), luma(sw), luma(se));
  let minimum = min(luma(center.rgb), min(min(light.x, light.y), min(light.z, light.w)));
  let maximum = max(luma(center.rgb), max(max(light.x, light.y), max(light.z, light.w)));
  let contrast = maximum - minimum;
  var color = center.rgb;
  if (fxaa && contrast > max(0.0312, maximum * 0.10)) {
    var direction = vec2<f32>(-(light.x + light.y - light.z - light.w),
      light.x + light.z - light.y - light.w);
    let reduce = max(dot(light, vec4<f32>(0.03125)), 0.0078125);
    direction = clamp(direction / (min(abs(direction.x), abs(direction.y)) + reduce),
      vec2<f32>(-8.0), vec2<f32>(8.0)) * texel;
    let a = 0.5 * (
      textureSampleLevel(source, sourceSampler, uv - direction / 6.0, 0.0).rgb
      + textureSampleLevel(source, sourceSampler, uv + direction / 6.0, 0.0).rgb);
    let b = a * 0.5 + 0.25 * (
      textureSampleLevel(source, sourceSampler, uv - direction * 0.5, 0.0).rgb
      + textureSampleLevel(source, sourceSampler, uv + direction * 0.5, 0.0).rgb);
    color = select(b, a, luma(b) < minimum || luma(b) > maximum);
  }
  color += (center.rgb - (nw + ne + sw + se) * 0.25) * output.finish.z
    * (1.0 - smoothstep(0.04, 0.22, contrast));
  return vec4<f32>(color, center.a);
}

@fragment fn fs_final(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let color = filterEncoded(input.uv, false);
  return vec4<f32>(finishNoise(color.rgb, input.position.xy), color.a);
}

@fragment fn fs_final_fxaa(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let color = filterEncoded(input.uv, true);
  return vec4<f32>(finishNoise(color.rgb, input.position.xy), color.a);
}
