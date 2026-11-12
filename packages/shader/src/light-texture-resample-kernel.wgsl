#define_import_path forgeax_lighting::light_texture_resample_kernel
struct ResampleParams {
  sourceSize : vec2<u32>,
  grayscale : u32,
  level : u32,
  viewportOrigin : vec2<u32>,
  outputSizeAndRowAlignWords : vec2<u32>,
}

struct AxisSpan {
  first : u32,
  end : u32,
  begin : f32,
  finish : f32,
  scale : f32,
  firstIndex : u32,
  secondIndex : u32,
  t : f32,
}

fn axisSpan(index : u32, length : u32, outputSize : u32) -> AxisSpan {
  var span : AxisSpan;
  span.scale = f32(length) / f32(outputSize);
  if (span.scale < 1.0) {
    let position = clamp((f32(index) + 0.5) / f32(outputSize), 0.0, 1.0) * f32(length - 1u);
    span.firstIndex = u32(floor(position));
    span.secondIndex = min(length - 1u, span.firstIndex + 1u);
    span.t = position - f32(span.firstIndex);
    span.first = span.firstIndex;
    span.end = span.secondIndex + 1u;
    return span;
  }
  span.begin = f32(index) * span.scale;
  span.finish = span.begin + span.scale;
  span.first = u32(floor(span.begin));
  span.end = min(length, u32(ceil(span.finish)));
  return span;
}

fn axisWeight(span : AxisSpan, texel : u32) -> f32 {
  if (span.scale < 1.0) {
    return select(0.0, 1.0 - span.t, texel == span.firstIndex) + select(0.0, span.t, texel == span.secondIndex);
  }
  let coverage = min(span.finish, f32(texel + 1u)) - max(span.begin, f32(texel));
  return max(coverage, 0.0) / span.scale;
}

fn loadSource(source : texture_2d<f32>, x : u32, y : u32, grayscale : u32) -> vec4<f32> {
  let texel = textureLoad(source, vec2<u32>(x, y), 0u);
  let value = select(texel, vec4<f32>(texel.rrr, 1.0), grayscale != 0u);
  return clamp(value, vec4<f32>(0.0), vec4<f32>(1.0));
}

fn reconstructPixel(
  source : texture_2d<f32>,
  sourceSize : vec2<u32>,
  grayscale : u32,
  pixel : vec2<u32>,
  outputSize : u32,
) -> vec4<f32> {
  let spanX = axisSpan(pixel.x, sourceSize.x, outputSize);
  let spanY = axisSpan(pixel.y, sourceSize.y, outputSize);
  var sum = vec4<f32>(0.0);
  for (var y = spanY.first; y < spanY.end; y = y + 1u) {
    let weightY = axisWeight(spanY, y);
    for (var x = spanX.first; x < spanX.end; x = x + 1u) {
      sum = sum + loadSource(source, x, y, grayscale) * (axisWeight(spanX, x) * weightY);
    }
  }
  return sum;
}

fn meanFour(a : vec4<f32>, b : vec4<f32>, c : vec4<f32>, d : vec4<f32>) -> vec4<f32> {
  return (a + b + c + d) * 0.25;
}

fn reducePixel(previous : texture_2d<f32>, pixel : vec2<u32>) -> vec4<f32> {
  let row = pixel * 2u;
  let a = textureLoad(previous, row, 0u);
  let b = textureLoad(previous, row + vec2<u32>(1u, 0u), 0u);
  let c = textureLoad(previous, row + vec2<u32>(0u, 1u), 0u);
  let d = textureLoad(previous, row + vec2<u32>(1u, 1u), 0u);
  return meanFour(a, b, c, d);
}

fn levelTexelOffset(level : u32, outputSize : u32) -> u32 {
  var offset = 0u;
  for (var l = 0u; l < level; l = l + 1u) {
    let size = outputSize >> l;
    offset = offset + size * size;
  }
  return offset;
}

fn levelWordOffset(level : u32, outputSize : u32, rowAlignWords : u32) -> u32 {
  var offset = 0u;
  for (var l = 0u; l < level; l = l + 1u) {
    let size = outputSize >> l;
    offset = offset + max(size, rowAlignWords) * size;
  }
  return offset;
}
