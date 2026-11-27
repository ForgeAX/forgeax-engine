#define_import_path forgeax_standard::subsurface_diffusion
#import forgeax_pbr::gbuffer::{decodeStandardGBufferNormal, standardGBufferValid, standardSubsurfaceActive, usesDefaultGBuffer}

@group(0) @binding(0) var diffuse : texture_2d<f32>;
@group(0) @binding(1) var profiles : texture_2d<u32>;
@group(0) @binding(2) var normals : texture_2d<u32>;
@group(0) @binding(3) var depth : texture_depth_2d;
struct DiffusionParams {
  projection : vec4<f32>, // near, far, orthographic, support in sigma units
  scale : vec4<f32>, // half-grid/presentation x and y, indirect row length, tap limit
  compactProfiles : array<vec4<u32>, 4>,
};
@group(0) @binding(4) var<uniform> params : DiffusionParams;
@group(0) @binding(5) var halfDiffuseOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var horizontalOut : texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var verticalOut : texture_storage_2d<rgba16float, write>;
// Two packed uint lanes per half texel: representative full-resolution index,
// then the RGB radius tuple and coverage flags. Storage is written by setup
// and read by the filters and recombination. Black radiance is a valid sample.
@group(0) @binding(8) var<storage, read_write> guideOut : array<vec2<u32>>;
@group(0) @binding(9) var<storage, read> guide : array<vec2<u32>>;
// Counts (H/V), horizontal membership flags, then the H and V tile arrays.
@group(0) @binding(10) var<storage, read_write> setupTiles : array<atomic<u32>>;
@group(0) @binding(11) var<storage, read> filterTiles : array<u32>;
// H dispatch (3 words), V dispatch (3), and additive draw (4).
@group(0) @binding(12) var<storage, read_write> commands : array<atomic<u32>>;

@group(0) @binding(13) var halfDiffuse : texture_2d<f32>;
@group(0) @binding(14) var horizontal : texture_2d<f32>;
@group(0) @binding(15) var vertical : texture_2d<f32>;

const TILE_SIZE : u32 = 8u;
const PROFILE_MASK : u32 = 0x00ffffffu;
const GUIDE_VALID : u32 = 1u << 24u;
const GUIDE_MIXED : u32 = 1u << 25u;
const GUIDE_COVERAGE_SHIFT : u32 = 26u;
const NO_TILE : u32 = 0xffffffffu;
var<workgroup> tileDemand : atomic<u32>;

fn distanceFromDepth(d : f32) -> f32 {
  let n = params.projection.x;
  let f = params.projection.y;
  return select(n / max(d + (1.0 - d) * n / f, 1e-7), f - d * (f - n), params.projection.z > 0.5);
}

fn inside(pixel : vec2<i32>, dims : vec2<i32>) -> bool {
  return all(pixel >= vec2<i32>(0)) && all(pixel < dims);
}

fn halfDimensions() -> vec2<u32> {
  return (textureDimensions(depth) + vec2<u32>(1)) / 2u;
}

fn tileDimensions() -> vec2<u32> {
  return (halfDimensions() + vec2<u32>(TILE_SIZE - 1u)) / TILE_SIZE;
}

fn supportRadius(radius : vec3<f32>) -> vec3<f32> {
  return min(vec3<f32>(params.scale.w),
    floor(radius * params.projection.w / 3.0 + vec3<f32>(0.0001)));
}

fn profileRadius(key : u32) -> vec3<f32> {
  return unpack4x8unorm(key).rgb * 12.0;
}

struct Surface {
  normal : vec3<f32>,
  distance : f32,
  profile : u32,
};

fn readSurface(pixel : vec2<i32>) -> Surface {
  let words = textureLoad(profiles, pixel, 0).rg;
  var profile = words.g;
  if (usesDefaultGBuffer()) {
    let id = words.r & 255u;
    if (id == 0u || id > 16u) { return Surface(vec3<f32>(0.0), 0.0, 0u); }
    let index = id - 1u;
    profile = params.compactProfiles[index >> 2u][index & 3u] | (words.r & 0xff000000u);
  }
  if (!standardSubsurfaceActive(profile)) { return Surface(vec3<f32>(0.0), 0.0, 0u); }
  let packed = textureLoad(normals, pixel, 0).rg;
  let d = textureLoad(depth, pixel, 0);
  if (!select(standardGBufferValid(packed), packed.x != 0u, usesDefaultGBuffer()) || d <= 0.0) { return Surface(vec3<f32>(0.0), 0.0, 0u); }
  return Surface(decodeStandardGBufferNormal(packed).xyz, distanceFromDepth(d), profile);
}

fn compatible(center : Surface, sample : Surface) -> bool {
  return sample.profile != 0u &&
    (sample.profile & PROFILE_MASK) == (center.profile & PROFILE_MASK) &&
    dot(center.normal, sample.normal) >= 0.8 &&
    abs(center.distance - sample.distance) <= max(0.001, 0.01 * center.distance);
}

fn appendTile(phase : u32, tile : u32, tileCount : u32) {
  let index = atomicAdd(&setupTiles[phase], 1u);
  // Deduplicated membership bounds each queue by the number of tiles.
  if (index >= tileCount) { return; }
  atomicStore(&setupTiles[2u + tileCount * (1u + phase) + index], tile);
  let rowLength = u32(params.scale.z);
  atomicMax(&commands[phase * 3u], min(rowLength, index + 1u));
  atomicMax(&commands[phase * 3u + 1u], index / rowLength + 1u);
  atomicStore(&commands[phase * 3u + 2u], 1u);
}

fn setupHalfPixel(pixel : vec2<u32>) {
  let dims = textureDimensions(depth);
  let source = vec2<i32>(pixel * 2u);
  var representative = vec2<u32>(0);
  var surfaces : array<Surface, 4>;
  var sampleCount = 0u;
  var activeCount = 0u;
  var mixed = false;
  var sum = vec3<f32>(0.0);
  for (var i = 0u; i < 4u; i += 1u) {
    let fullPixel = source + vec2<i32>(i32(i & 1u), i32(i >> 1u));
    if (!inside(fullPixel, vec2<i32>(dims))) { continue; }
    sampleCount += 1u;
    let sample = readSurface(fullPixel);
    if (sample.profile == 0u) { continue; }
    if (activeCount == 0u) {
      representative = vec2<u32>(fullPixel);
    }
    if (!mixed) {
      // Every pair must belong to the same surface. A third corner close to
      // each side of a crease must not bridge across incompatible normals.
      for (var j = 0u; j < activeCount; j += 1u) {
        let previous = surfaces[j];
        if (!compatible(previous, sample) || !compatible(sample, previous)) {
          mixed = true;
          break;
        }
      }
    }
    surfaces[activeCount] = sample;
    activeCount += 1u;
    sum += textureLoad(diffuse, fullPixel, 0).rgb;
  }

  let index = pixel.y * halfDimensions().x + pixel.x;
  var metadata = 0u;
  var color = vec3<f32>(0.0);
  if (activeCount > 0u) {
    atomicOr(&tileDemand, 1u);
    metadata = (surfaces[0].profile & PROFILE_MASK) | (activeCount << GUIDE_COVERAGE_SHIFT);
    if (mixed || activeCount != sampleCount) {
      metadata |= GUIDE_MIXED;
    } else {
      metadata |= GUIDE_VALID;
      color = sum / f32(activeCount);
      atomicOr(&tileDemand, 2u);
    }
  }
  guideOut[index] = vec2<u32>(representative.y * dims.x + representative.x, metadata);
  let point = vec2<i32>(pixel);
  textureStore(halfDiffuseOut, point, vec4<f32>(color, 0.0));
  textureStore(horizontalOut, point, vec4<f32>(0.0));
  textureStore(verticalOut, point, vec4<f32>(0.0));
}

@compute @workgroup_size(8, 8)
fn cs_subsurface_setup(@builtin(workgroup_id) group : vec3<u32>, @builtin(local_invocation_index) local : u32,
  @builtin(global_invocation_id) global : vec3<u32>) {
  if (local == 0u) { atomicStore(&tileDemand, 0u); }
  workgroupBarrier();
  if (all(global.xy < halfDimensions())) { setupHalfPixel(global.xy); }
  workgroupBarrier();
  if (local != 0u) { return; }

  let demand = atomicLoad(&tileDemand);
  if ((demand & 1u) != 0u) {
    atomicStore(&commands[6], 3u);
    atomicStore(&commands[7], 1u);
  }
  if ((demand & 2u) == 0u) { return; }

  let tiles = tileDimensions();
  let count = tiles.x * tiles.y;
  appendTile(1u, group.y * tiles.x + group.x, count);
  // V reads H from neighboring tile rows. Expand H demand before dispatching the
  // filters, and deduplicate across all V tiles in this setup stage.
  let taps = u32(supportRadius(vec3<f32>(12.0 * params.scale.y)).x);
  let halo = i32((taps + TILE_SIZE - 1u) / TILE_SIZE);
  for (var y = max(0, i32(group.y) - halo); y <= min(i32(tiles.y) - 1, i32(group.y) + halo); y += 1) {
    let tile = u32(y) * tiles.x + group.x;
    if (atomicExchange(&setupTiles[2u + tile], 1u) == 0u) {
      appendTile(0u, tile, count);
    }
  }
}

fn filterTile(group : vec2<u32>, phase : u32) -> u32 {
  let ordinal = group.x + group.y * u32(params.scale.z);
  let tiles = tileDimensions();
  let tileCount = tiles.x * tiles.y;
  if (ordinal >= min(filterTiles[phase], tileCount)) { return NO_TILE; }
  return filterTiles[2u + tileCount * (1u + phase) + ordinal];
}

fn guideFor(pixel : vec2<i32>) -> vec2<u32> {
  let point = vec2<u32>(pixel);
  return guide[point.y * halfDimensions().x + point.x];
}

fn representativeSurface(value : vec2<u32>) -> Surface {
  let width = textureDimensions(depth).x;
  return readSurface(vec2<i32>(i32(value.x % width), i32(value.x / width)));
}

fn gaussianWeight(offset : f32, radius : vec3<f32>) -> vec3<f32> {
  let safeRadius = max(radius, vec3<f32>(0.0001));
  return select(vec3<f32>(0.0), exp(-4.5 * offset * offset / (safeRadius * safeRadius)),
    vec3<f32>(offset) <= supportRadius(radius));
}

fn filterAxis(pixel : vec2<i32>, source : texture_2d<f32>, axis : vec2<i32>, scale : f32) -> vec3<f32> {
  let guides = guideFor(pixel);
  if ((guides.y & GUIDE_VALID) == 0u) { return vec3<f32>(0.0); }
  let base = textureLoad(source, pixel, 0).rgb;
  let center = representativeSurface(guides);
  let key = guides.y & PROFILE_MASK;
  let radius = profileRadius(key) * scale;
  let dims = vec2<i32>(halfDimensions());
  var sum = base;
  var denominator = vec3<f32>(1.0);
  for (var offset = 1; offset <= i32(params.scale.w); offset += 1) {
    let weight = gaussianWeight(f32(offset), radius);
    if (all(weight == vec3<f32>(0.0))) { break; }
    for (var sign = -1; sign <= 1; sign += 2) {
      let point = pixel + axis * (offset * sign);
      var selected = base;
      if (inside(point, dims)) {
        let sample = guideFor(point);
        if ((sample.y & (PROFILE_MASK | GUIDE_VALID)) == (key | GUIDE_VALID) &&
            compatible(center, representativeSurface(sample))) {
          selected = textureLoad(source, point, 0).rgb;
        }
      }
      sum += selected * weight;
      denominator += weight;
    }
  }
  return sum / denominator;
}

@compute @workgroup_size(8, 8)
fn cs_subsurface_horizontal(@builtin(workgroup_id) group : vec3<u32>, @builtin(local_invocation_id) local : vec3<u32>) {
  let tile = filterTile(group.xy, 0u);
  if (tile == NO_TILE) { return; }
  let tileWidth = tileDimensions().x;
  let point = vec2<u32>(tile % tileWidth, tile / tileWidth) * TILE_SIZE + local.xy;
  if (any(point >= halfDimensions())) { return; }
  let pixel = vec2<i32>(point);
  textureStore(horizontalOut, pixel, vec4<f32>(filterAxis(pixel, halfDiffuse, vec2<i32>(1, 0), params.scale.x), 0.0));
}

@compute @workgroup_size(8, 8)
fn cs_subsurface_vertical(@builtin(workgroup_id) group : vec3<u32>, @builtin(local_invocation_id) local : vec3<u32>) {
  let tile = filterTile(group.xy, 1u);
  if (tile == NO_TILE) { return; }
  let tileWidth = tileDimensions().x;
  let point = vec2<u32>(tile % tileWidth, tile / tileWidth) * TILE_SIZE + local.xy;
  if (any(point >= halfDimensions())) { return; }
  let pixel = vec2<i32>(point);
  textureStore(verticalOut, pixel, vec4<f32>(filterAxis(pixel, horizontal, vec2<i32>(0, 1), params.scale.y), 0.0));
}

@vertex
fn vs_subsurface(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(select(-1.0, 3.0, index == 1u), select(-1.0, 3.0, index == 2u), 0.0, 1.0);
}

@fragment
fn fs_subsurface(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy);
  let center = readSurface(pixel);
  if (center.profile == 0u) { discard; }
  let original = textureLoad(diffuse, pixel, 0).rgb;
  if ((guideFor(pixel / 2).y & GUIDE_VALID) == 0u) { return vec4<f32>(original, 0.0); }
  let halfPosition = position.xy * 0.5 - vec2<f32>(0.5);
  let base = vec2<i32>(floor(halfPosition));
  let phase = fract(halfPosition);
  let dims = vec2<i32>(halfDimensions());
  let key = center.profile & PROFILE_MASK;
  var sum = vec3<f32>(0.0);
  var denominator = 0.0;
  for (var i = 0u; i < 4u; i += 1u) {
    let offset = vec2<i32>(i32(i & 1u), i32(i >> 1u));
    let point = base + offset;
    if (!inside(point, dims)) { continue; }
    let sample = guideFor(point);
    if ((sample.y & (PROFILE_MASK | GUIDE_VALID)) != (key | GUIDE_VALID) ||
        !compatible(center, representativeSurface(sample))) { continue; }
    let weight = select(vec2<f32>(1.0) - phase, phase, offset != vec2<i32>(0));
    let contribution = weight.x * weight.y;
    sum += textureLoad(vertical, point, 0).rgb * contribution;
    denominator += contribution;
  }
  if (denominator <= 0.0) { return vec4<f32>(original, 0.0); }
  let radius = profileRadius(key) * max(params.scale.x, params.scale.y);
  let filtered = select(original, sum / denominator, supportRadius(radius) > vec3<f32>(0.0));
  return vec4<f32>(mix(original, filtered, f32(center.profile >> 24u) / 255.0), 0.0);
}
