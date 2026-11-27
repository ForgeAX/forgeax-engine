// Project RGB radiance directly into the polynomial for diffuse E/pi.
// Only the final vector's w lane stores the accumulated solid angle.
const SKY_SH_PACKED_VECTORS: u32 = 7u;
const SKY_SH_TILES_PER_AXIS: u32 = 16u;
const SKY_SH_TILE_COUNT: u32 = 1536u;
const SKY_SH_REDUCE_WIDTH: u32 = 32u;

struct SkyShProjectionParams {
  cameraCube: u32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}

@group(0) @binding(0) var skyShSource: texture_cube<f32>;
@group(0) @binding(1) var skyShSampler: sampler;
@group(0) @binding(2) var<uniform> skyShParams: SkyShProjectionParams;
@group(0) @binding(3) var skyShPartials: texture_2d<f32>;

// Products of the normalized SH basis constants and the Lambert band factors.
const SKY_SH_INV_PI: f32 = 0.3183098861837907;
const SKY_SH_L0: f32 = SKY_SH_INV_PI / 4.0;
const SKY_SH_L1: f32 = SKY_SH_INV_PI / 2.0;
const SKY_SH_CROSS: f32 = 15.0 * SKY_SH_INV_PI / 16.0;
const SKY_SH_Z2: f32 = 5.0 * SKY_SH_INV_PI / 64.0;
const SKY_SH_X2_MINUS_Y2: f32 = 15.0 * SKY_SH_INV_PI / 64.0;

fn skyShPackedSample(slot: u32, n: vec3f, rgb: vec3f, weight: f32) -> vec4f {
  if (slot == 6u) {
    let axisDifference = n.x * n.x - n.y * n.y;
    return vec4f(rgb * (SKY_SH_X2_MINUS_Y2 * axisDifference * weight), weight);
  }

  // Fold the constant part of the zonal quadratic into the linear vector.
  let zTerm = SKY_SH_Z2 * (3.0 * n.z * n.z - 1.0);
  if (slot < 3u) {
    return vec4f(SKY_SH_L1 * n, SKY_SH_L0 - zTerm) * (rgb[slot] * weight);
  }

  let crossTerms = SKY_SH_CROSS * n.xyzz * n.yzzx;
  return vec4f(crossTerms.xy, 3.0 * zTerm, crossTerms.w) * (rgb[slot - 3u] * weight);
}

// Direction for the centre of a native cube texel. The direction set is
// symmetric; each sample uses the cube's addressing and a solid-angle weight.
fn skyShDirection(p: vec2f, face: u32) -> vec3f {
  switch face {
    case 0u: { return vec3f(1.0, -p.y, -p.x); }
    case 1u: { return vec3f(-1.0, -p.y, p.x); }
    case 2u: { return vec3f(p.x, 1.0, p.y); }
    case 3u: { return vec3f(p.x, -1.0, -p.y); }
    case 4u: { return vec3f(p.x, -p.y, 1.0); }
    default: { return vec3f(-p.x, -p.y, -1.0); }
  }
}

fn skyShSourceDirection(n: vec3f) -> vec3f {
  if (skyShParams.cameraCube == 0u) { return n; }
  // Match the capture-to-PMREM convention. Evaluate the polynomial in the
  // unrotated environment's axes and transform only the source lookup.
  if (abs(n.x) >= max(abs(n.y), abs(n.z))) { return vec3f(n.x, n.y, -n.z); }
  return vec3f(-n.x, n.y, n.z);
}

fn skyShProjectTile(slot: u32, tile: u32) -> vec4f {
  let side = textureDimensions(skyShSource, 0).x;
  let axis = SKY_SH_TILES_PER_AXIS;
  let tileExtent = (side + axis - 1u) / axis;
  let start = vec2u(tile % axis, (tile / axis) % axis) * tileExtent;
  let end = min(vec2u(side), start + vec2u(tileExtent));
  let face = tile / (axis * axis);
  var partial = vec4f(0.0);
  for (var y = start.y; y < end.y; y += 1u) {
    for (var x = start.x; x < end.x; x += 1u) {
      let uv = (vec2f(f32(x), f32(y)) + 0.5) * (2.0 / f32(side)) - 1.0;
      let direction = skyShDirection(uv, face);
      let invLength = inverseSqrt(dot(direction, direction));
      let n = direction * invLength;
      // The common 4/side^2 factor cancels when normalizing by total solid angle.
      let weight = invLength * invLength * invLength;
      let rgb = textureSampleLevel(skyShSource, skyShSampler, skyShSourceDirection(n), 0.0).rgb;
      let valid = (rgb >= vec3f(0.0)) & (rgb <= vec3f(65504.0));
      partial += skyShPackedSample(slot, n, select(vec3f(0.0), rgb, valid), weight);
    }
  }
  return partial;
}

fn skyShFinish(slot: u32, partial: vec4f, solidAngle: f32) -> vec4f {
  let lanes = vec4f(partial.xyz, select(partial.w, 0.0, slot == 6u));
  return lanes * (12.5663706144 / max(solidAngle, 1e-12));
}

@vertex fn sky_sh_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  return vec4f(select(-1.0, 3.0, index == 1u), select(-1.0, 3.0, index == 2u), 0.0, 1.0);
}

@fragment fn sky_sh_project(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(position.xy);
  return skyShProjectTile(pixel.x, pixel.y);
}

fn skyShReduceRow(slot: u32, row: u32, stride: u32) -> vec4f {
  let count = textureDimensions(skyShPartials, 0).y;
  let start = row * stride;
  var sum = vec4f(0.0);
  for (var i = start; i < min(start + stride, count); i += 1u) {
    sum += textureLoad(skyShPartials, vec2i(i32(slot), i32(i)), 0);
  }
  return sum;
}

@fragment fn sky_sh_reduce(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2u(position.xy);
  return skyShReduceRow(pixel.x, pixel.y, SKY_SH_REDUCE_WIDTH);
}

@fragment fn sky_sh_finish(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let slot = u32(position.x);
  let rows = textureDimensions(skyShPartials, 0).y;
  let partial = skyShReduceRow(slot, 0u, rows);
  var solidAngle = partial.w;
  if (slot != 6u) { solidAngle = skyShReduceRow(6u, 0u, rows).w; }
  return skyShFinish(slot, partial, solidAngle);
}

@group(0) @binding(4) var<storage, read_write> skyShComputePartials: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> skyShCoefficients: SkyShPolynomial;
var<workgroup> skyShSolidAngle: f32;

@compute @workgroup_size(64)
fn sky_sh_compute_project(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < SKY_SH_TILE_COUNT * SKY_SH_PACKED_VECTORS) {
    skyShComputePartials[id.x] = skyShProjectTile(
      id.x % SKY_SH_PACKED_VECTORS, id.x / SKY_SH_PACKED_VECTORS,
    );
  }
}

@compute @workgroup_size(SKY_SH_PACKED_VECTORS)
fn sky_sh_compute_reduce(@builtin(local_invocation_id) id: vec3u) {
  var partial = vec4f(0.0);
  for (var tile = 0u; tile < SKY_SH_TILE_COUNT; tile += 1u) {
    partial += skyShComputePartials[tile * SKY_SH_PACKED_VECTORS + id.x];
  }
  if (id.x == 6u) { skyShSolidAngle = partial.w; }
  workgroupBarrier();
  skyShCoefficients.terms[id.x] = skyShFinish(id.x, partial, skyShSolidAngle);
}
