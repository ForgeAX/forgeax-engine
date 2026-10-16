/**
 * One-shot projection of a GPU-decoded source texture into one 256x256 slice
 * of the shared light-texture array (Spot Cookies, Spot projectors,
 * RectAreaLight source textures).
 *
 * The kernel mirrors the renderer's CPU projection so both paths fill a slice
 * with the same linear RGBA8 mip chain: per-axis corner-aligned bilinear
 * upsampling or box integration of the covered span, texels clipped to
 * [0, 1] before filtering, and float 2x2 box-mean mips. `textureLoad` decodes block
 * formats (BC/ETC2/ASTC) in hardware and linearizes `-srgb` views, which is
 * why block-compressed sources take this path.
 *
 * `light_texture_resample` writes level 0; one `light_texture_reduce`
 * dispatch per further level averages 2x2 texels of the level above. Each
 * level is kept as floats for the next reduction and packed as RGBA8 rows
 * padded to the 256-byte copyBufferToTexture pitch. Reducing level by level
 * keeps every invocation to at most four loads; a single invocation summing a
 * whole level-0 footprint returns wrong 1x1 means on Lavapipe 23.2.
 */
export const LIGHT_TEXTURE_RESAMPLE_WGSL = /* wgsl */ `
const SLICE_SIZE : u32 = 256u;
const LEVEL_COUNT : u32 = 9u;
const ROW_ALIGN_WORDS : u32 = 64u;

struct ResampleParams {
  sourceSize : vec2<u32>,
  grayscale : u32,
  level : u32,
}

@group(0) @binding(0) var<uniform> params : ResampleParams;
@group(0) @binding(1) var source : texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> levels : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> packed : array<u32>;

struct AxisSpan {
  first : u32,
  end : u32,
  begin : f32,
  finish : f32,
  scale : f32,
  i0 : u32,
  i1 : u32,
  t : f32,
}

fn axisSpan(index : u32, length : u32) -> AxisSpan {
  var span : AxisSpan;
  span.scale = f32(length) / f32(SLICE_SIZE);
  if (span.scale < 1.0) {
    let position = clamp((f32(index) + 0.5) / f32(SLICE_SIZE), 0.0, 1.0) * f32(length - 1u);
    span.i0 = u32(floor(position));
    span.i1 = min(length - 1u, span.i0 + 1u);
    span.t = position - f32(span.i0);
    span.first = span.i0;
    span.end = span.i1 + 1u;
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
    return select(0.0, 1.0 - span.t, texel == span.i0) + select(0.0, span.t, texel == span.i1);
  }
  let coverage = min(span.finish, f32(texel + 1u)) - max(span.begin, f32(texel));
  return max(coverage, 0.0) / span.scale;
}

fn loadSource(x : u32, y : u32) -> vec4<f32> {
  let texel = textureLoad(source, vec2<u32>(x, y), 0u);
  let value = select(texel, vec4<f32>(texel.rrr, 1.0), params.grayscale != 0u);
  return clamp(value, vec4<f32>(0.0), vec4<f32>(1.0));
}

// First float texel of a level in the contiguous chain.
fn levelTexelOffset(level : u32) -> u32 {
  var offset = 0u;
  for (var l = 0u; l < level; l = l + 1u) {
    let size = SLICE_SIZE >> l;
    offset = offset + size * size;
  }
  return offset;
}

// First packed word of a level, each row padded to the copy pitch.
fn levelWordOffset(level : u32) -> u32 {
  var offset = 0u;
  for (var l = 0u; l < level; l = l + 1u) {
    let size = SLICE_SIZE >> l;
    offset = offset + max(size, ROW_ALIGN_WORDS) * size;
  }
  return offset;
}

fn store(level : u32, x : u32, y : u32, value : vec4<f32>) {
  let size = SLICE_SIZE >> level;
  levels[levelTexelOffset(level) + y * size + x] = value;
  packed[levelWordOffset(level) + y * max(size, ROW_ALIGN_WORDS) + x] = pack4x8unorm(value);
}

@compute @workgroup_size(8, 8, 1)
fn light_texture_resample(@builtin(global_invocation_id) id : vec3<u32>) {
  if (id.x >= SLICE_SIZE || id.y >= SLICE_SIZE) {
    return;
  }
  let spanX = axisSpan(id.x, params.sourceSize.x);
  let spanY = axisSpan(id.y, params.sourceSize.y);
  var sum = vec4<f32>(0.0);
  for (var y = spanY.first; y < spanY.end; y = y + 1u) {
    let weightY = axisWeight(spanY, y);
    for (var x = spanX.first; x < spanX.end; x = x + 1u) {
      sum = sum + loadSource(x, y) * (axisWeight(spanX, x) * weightY);
    }
  }
  store(0u, id.x, id.y, sum);
}

@compute @workgroup_size(8, 8, 1)
fn light_texture_reduce(@builtin(global_invocation_id) id : vec3<u32>) {
  let level = params.level;
  let size = SLICE_SIZE >> level;
  if (id.x >= size || id.y >= size) {
    return;
  }
  let above = levelTexelOffset(level - 1u);
  let row = above + (id.y * 2u) * (size * 2u) + id.x * 2u;
  let sum = levels[row] + levels[row + 1u] + levels[row + size * 2u] + levels[row + size * 2u + 1u];
  store(level, id.x, id.y, sum * 0.25);
}
`;
