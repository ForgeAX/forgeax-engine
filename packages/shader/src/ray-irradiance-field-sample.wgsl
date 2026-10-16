#define_import_path forgeax_ray::irradiance_field_sample

// Irradiance Field sampling ABI. A consumer binds this group and calls
// sampleIrradianceField() or sampleRadianceCache(); the Renderer-owned field
// writes these buffers.
//
// Per probe the texel buffer holds IRRADIANCE_FIELD_PROBE_STRIDE vec4f:
//   [0, 64)    D = E / pi over the 8x8 octahedral map (cosine-convolved radiance)
//   [64, 128)  radiance L, 8x8 octahedral (the temporally filtered authority)
//   [128, 144) radiance L, 4x4 octahedral 2x2 prefilter of the 8x8 level
// Irradiance is derived from the radiance level every update, so the two never
// disagree; w = 1 marks a texel that has received at least one ray.
struct IrradianceField {
  // xyz lattice anchor (cell 0 of every level), w level-0 probe spacing.
  originSpacing: vec4f,
  // xyz per-level probe lattice, w total probe count.
  dimensionsCount: vec4u,
  // x normal bias, y view bias, z moments distance clamp (level 0; each scales
  // by 2^level), w cross-level blend band in cells of the finer level.
  bias: vec4f,
  // x clipmap level count, y probes per level, z pending native world instances,
  // w current scene trace bounds are contained in the live SDF sample box.
  levels: vec4u,
  // Per level: window min cell (toroidal origin), and the traced cell box
  // [validMin, validMax) a receiver may interpolate inside.
  window: array<vec4i, 4>,
  validMin: array<vec4i, 4>,
  validMax: array<vec4i, 4>,
}
@group(1) @binding(0) var<uniform> irradianceField: IrradianceField;
@group(1) @binding(1) var<storage, read> irradianceFieldProbes: array<vec4f>;
// Per texel mean and mean-square clamped ray distance.
@group(1) @binding(2) var<storage, read> irradianceFieldMoments: array<vec2f>;
// Per probe: x updates, y classification (IRRADIANCE_FIELD_PROBE_ACTIVE is the
// only state that contributes), zw the f16 xyz relocation offset from the
// lattice point; rays are traced from the relocated position.
@group(1) @binding(3) var<storage, read> irradianceFieldMeta: array<vec4u>;

#ifdef IRRADIANCE_FIELD_VISIBILITY
// Live fields derive this projection after Global SDF composition. Baked fields
// have no live region and retain the four-buffer sampling contract.
struct FieldVisibilityGrid { originSpacing: vec4f, dimensionsCount: vec4u, ranges: vec4f }
@group(1) @binding(4) var<uniform> fieldVisibilityGrid: FieldVisibilityGrid;
@group(1) @binding(5) var fieldVisibility: texture_3d<f32>;

fn fieldVisibilitySample(p: vec3f) -> vec2f {
  let dims = fieldVisibilityGrid.dimensionsCount.xyz;
  let q = (p - fieldVisibilityGrid.originSpacing.xyz) / fieldVisibilityGrid.originSpacing.w;
  let cell = vec3u(min(floor(q), vec3f(dims - vec3u(2u))));
  let f = q - vec3f(cell);
  var distance = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let offset = vec3u(k & 1u, (k >> 1u) & 1u, k >> 2u);
    let axis = select(vec3f(1.0) - f, f, offset > vec3u(0u));
    let weight = axis.x * axis.y * axis.z;
    if (!(weight > 0.0)) { continue; }
    let value = textureLoad(fieldVisibility, vec3i(cell + offset), 0).xy;
    if (value.y != 1.0) { return vec2f(0.0, -1.0); }
    distance += value.x * weight;
  }
  return vec2f(distance, 1.0);
}

// 1 = fully covered clear segment, 0 = occluded, -1 = unavailable transport.
// Keep the same conservative distance expansion as Global SDF traversal; no
// visibility floor can reintroduce a rejected corner through normalization.
fn fieldSegmentVisibility(origin: vec3f, endpoint: vec3f) -> f32 {
  let spacing = fieldVisibilityGrid.originSpacing.w;
  // Distance-only interpolation needs no gradient border. Outside portions are
  // clear only with the producer's current-scene containment proof.
  let lo = fieldVisibilityGrid.originSpacing.xyz;
  let hi = lo + vec3f(fieldVisibilityGrid.dimensionsCount.xyz - vec3u(1u)) * spacing;
  if (irradianceField.levels.w == 0u &&
      (any(origin < lo) || any(origin > hi) || any(endpoint < lo) || any(endpoint > hi))) { return -1.0; }
  let delta = endpoint - origin;
  let distance = length(delta);
  if (!(distance > 1e-6)) { return 1.0; }
  let direction = delta / distance;
  var near = 0.0;
  var far = distance;
  for (var axis = 0u; axis < 3u; axis++) {
    if (direction[axis] == 0.0) {
      if (origin[axis] < lo[axis] || origin[axis] > hi[axis]) { return 1.0; }
    } else {
      let a = (lo[axis] - origin[axis]) / direction[axis];
      let b = (hi[axis] - origin[axis]) / direction[axis];
      near = max(near, min(a, b));
      far = min(far, max(a, b));
    }
  }
  if (near > far) { return 1.0; }
  let h = spacing * 0.5;
  var t = near;
  var maximum = 0.0;
  for (var step = 0u; step < 256u; step++) {
    let sample = fieldVisibilitySample(clamp(origin + direction * t, lo, hi));
    if (sample.y < 0.0) { return -1.0; }
    maximum = max(maximum, sample.x);
    let expansion = h * clamp(maximum / (2.0 * h), 0.0, 1.0);
    if (sample.x < expansion) { return 0.0; }
    // The final covered point must satisfy the same distance/status test.
    // Jumping past it makes admission depend on the march phase: neighbouring
    // receivers alternately see a near-surface probe, producing concentric rings.
    if (t >= far) { return 1.0; }
    let next = t + max(sample.x, h * 0.25);
    if (!(next > t)) { return -1.0; }
    t = min(next, far);
  }
  return -1.0;
}
#endif

const IRRADIANCE_FIELD_PROBE_STRIDE = 144u;
const IRRADIANCE_FIELD_PROBE_ACTIVE = 1u;
const IRRADIANCE_FIELD_RADIANCE = 64u;
const IRRADIANCE_FIELD_RADIANCE_MIP = 128u;
// Cone half-angles (radians) each level resolves: one 8x8 texel, one 4x4
// texel, and the cosine lobe of the irradiance level (its half-power angle).
const RADIANCE_CACHE_CONES = vec3f(0.25, 0.5, 1.05);

fn irradianceFieldSpacing() -> f32 { return irradianceField.originSpacing.w; }

fn irradianceFieldLevelScale(level: u32) -> f32 { return f32(1u << level); }

// Toroidal storage slot of a level cell: independent of the window, so a
// scroll keeps every still-covered probe in place.
fn irradianceFieldProbeIndex(level: u32, cell: vec3i) -> u32 {
  let d = vec3i(irradianceField.dimensionsCount.xyz);
  let c = vec3u(((cell % d) + d) % d);
  let dims = irradianceField.dimensionsCount.xyz;
  return level * irradianceField.levels.y + (c.z * dims.y + c.y) * dims.x + c.x;
}

fn irradianceFieldOctEncode(direction: vec3f) -> vec2f {
  let n = direction / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (n.z >= 0.0) { return n.xy; }
  return (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
}

// Reflect edge taps across the octahedral seam, as a virtual one-texel
// border over the existing interior. All angular levels share this mapping.
struct IrradianceFieldTaps { index: vec4u, weight: vec4f }

fn irradianceFieldOctWrap(coordinate: vec2i, size: i32) -> vec2u {
  var c = coordinate;
  if (c.x < 0) { c = vec2i(-c.x - 1, size - 1 - c.y); }
  else if (c.x >= size) { c = vec2i(2 * size - c.x - 1, size - 1 - c.y); }
  if (c.y < 0) { c = vec2i(size - 1 - c.x, -c.y - 1); }
  else if (c.y >= size) { c = vec2i(size - 1 - c.x, 2 * size - c.y - 1); }
  return vec2u(c);
}

fn irradianceFieldOctTaps(direction: vec3f, size: u32) -> IrradianceFieldTaps {
  let xy = (irradianceFieldOctEncode(direction) * 0.5 + vec2f(0.5)) * f32(size) - vec2f(0.5);
  let base = vec2i(floor(xy));
  let f = xy - vec2f(base);
  var taps: IrradianceFieldTaps;
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2i(i32(tap & 1u), i32(tap >> 1u));
    let axis = select(vec2f(1.0) - f, f, offset > vec2i(0));
    let c = irradianceFieldOctWrap(base + offset, i32(size));
    taps.index[tap] = c.y * size + c.x;
    taps.weight[tap] = axis.x * axis.y;
  }
  return taps;
}

fn irradianceFieldLevel(probe: u32, first: u32, size: u32, direction: vec3f) -> vec4f {
  let taps = irradianceFieldOctTaps(direction, size);
  let base = probe * IRRADIANCE_FIELD_PROBE_STRIDE + first;
  // Unsupported taps never supply color or denominator; a resolved black tap does.
  var value = vec3f(0.0);
  var weight = 0.0;
  for (var tap = 0u; tap < 4u; tap++) {
    let stored = irradianceFieldProbes[base + taps.index[tap]];
    if (!(taps.weight[tap] > 0.0) || !(stored.w > 0.0)) { continue; }
    value += stored.xyz * taps.weight[tap];
    weight += taps.weight[tap];
  }
  if (!(weight > 0.0)) { return vec4f(0.0); }
  return vec4f(value / weight, 1.0);
}

fn irradianceFieldDepth(probe: u32, direction: vec3f) -> vec2f {
  let taps = irradianceFieldOctTaps(direction, 8u);
  var moments = vec2f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    moments += irradianceFieldMoments[probe * 64u + taps.index[tap]] * taps.weight[tap];
  }
  return moments;
}

fn irradianceFieldProbeOffset(state: vec4u) -> vec3f {
  return vec3f(unpack2x16float(state.z), unpack2x16float(state.w).x);
}

// Mean radiance over a cone around `direction` from one probe. Narrow cones read
// the 8x8 radiance level, wider cones blend to the 4x4 prefilter and then to the
// cosine-convolved level, whose value is E(direction) / pi.
// Blended angular levels require support from every endpoint with positive
// blend weight. A zero endpoint weight never requires that endpoint's data.
fn irradianceFieldConeBlend(a: vec4f, b: vec4f, t: f32) -> vec4f {
  if (t <= 0.0) { return a; }
  if (t >= 1.0) { return b; }
  if (!(a.w > 0.0 && b.w > 0.0)) { return vec4f(0.0); }
  return vec4f(mix(a.xyz, b.xyz, t), 1.0);
}

fn irradianceFieldCone(probe: u32, direction: vec3f, coneAngle: f32) -> vec4f {
  let cones = RADIANCE_CACHE_CONES;
  if (coneAngle >= cones.z) { return irradianceFieldLevel(probe, 0u, 8u, direction); }
  if (coneAngle >= cones.y) {
    return irradianceFieldConeBlend(irradianceFieldLevel(probe, IRRADIANCE_FIELD_RADIANCE_MIP, 4u, direction),
      irradianceFieldLevel(probe, 0u, 8u, direction), (coneAngle - cones.y) / (cones.z - cones.y));
  }
  let fine = irradianceFieldLevel(probe, IRRADIANCE_FIELD_RADIANCE, 8u, direction);
  if (coneAngle <= cones.x) { return fine; }
  return irradianceFieldConeBlend(fine, irradianceFieldLevel(probe, IRRADIANCE_FIELD_RADIANCE_MIP, 4u, direction),
    (coneAngle - cones.x) / (cones.y - cones.x));
}

// Lattice corners around a receiver with their normalized weights: trilinear x
// Chebyshev visibility^3, active probes only and the normal-side test, over the
// finest clipmap level whose traced box holds the receiver and, inside the
// blend band at that box's edge, the next coarser level (8 corners each).
// Diffuse and cache share the geometry rule; only supported angular samples
// contribute. Rejected fine directions fall back to the retained coarser level.
const IRRADIANCE_FIELD_CORNERS = 16u;
struct IrradianceFieldCorners { values: array<vec3f, 16>, weights: array<f32, 16>, valid: bool, incomplete: bool }

// Unnormalized corner weights of one level into slots [first, first + 8).
fn irradianceFieldLevelCorners(corners: ptr<function, IrradianceFieldCorners>, first: u32,
    level: u32, position: vec3f, normal: vec3f, viewDir: vec3f, direction: vec3f, coneAngle: f32) -> f32 {
  let scale = irradianceFieldLevelScale(level);
  let spacing = irradianceField.originSpacing.w * scale;
  let lo = irradianceField.validMin[level].xyz;
  let hi = irradianceField.validMax[level].xyz - vec3i(1);
  if (any(hi < lo)) { return 0.0; }
  let biased = position + (normal * irradianceField.bias.x + viewDir * irradianceField.bias.y) * scale;
  let q = clamp((biased - irradianceField.originSpacing.xyz) / spacing, vec3f(lo), vec3f(hi));
  let base = vec3i(min(floor(q), vec3f(max(hi - vec3i(1), lo))));
  let f = q - vec3f(base);
  var total = 0.0;
  for (var corner = 0u; corner < 8u; corner++) {
    let offset = vec3u(corner & 1u, (corner >> 1u) & 1u, corner >> 2u);
    let cell = base + vec3i(offset);
    // Cells outside the traced box hold another world cell or no history yet.
    if (any(cell > hi)) { continue; }
    let probe = irradianceFieldProbeIndex(level, cell);
    let state = irradianceFieldMeta[probe];
    // Untraced, inside and just-relocated probes contribute nothing.
    if (state.y != IRRADIANCE_FIELD_PROBE_ACTIVE) { continue; }
    // Trilinear weights stay on the lattice; visibility and the side test use
    // the relocated position the probe's rays and moments were traced from.
    let probePosition = irradianceField.originSpacing.xyz + vec3f(cell) * spacing
      + irradianceFieldProbeOffset(state);
    let toProbe = probePosition - position;
    if (dot(toProbe, normal) <= 0.0) { continue; }
    let axis = select(vec3f(1.0) - f, f, offset > vec3u(0u));
    let trilinear = axis.x * axis.y * axis.z;
    if (!(trilinear > 0.0)) { continue; }
    // Classification proves that rays reached this probe, not that the queried
    // radiance direction has lit support. Keep physical zero; reject absence.
    let value = irradianceFieldCone(probe, direction, coneAngle);
    if (!(value.w > 0.0)) { continue; }
    let fromProbe = biased - probePosition;
    let distance = length(fromProbe);
    let momentDirection = select(normal, fromProbe / distance, distance > 1e-6);
    let moments = irradianceFieldDepth(probe, momentDirection);
    let mean = moments.x;
    let variance = abs(mean * mean - moments.y);
    var visibility = 1.0;
    if (distance > mean) {
      let delta = distance - mean;
      let chebyshev = variance / (variance + delta * delta);
      visibility = chebyshev * chebyshev * chebyshev;
    }
    let weight = trilinear * visibility;
    if (!(weight > 0.0)) { continue; }
#ifdef IRRADIANCE_FIELD_VISIBILITY
    let segment = fieldSegmentVisibility(biased, probePosition);
    if (segment < 0.0) { (*corners).incomplete = true; return 0.0; }
    if (segment == 0.0) { continue; }
#endif
    (*corners).values[first + corner] = value.xyz;
    (*corners).weights[first + corner] = weight;
    total += weight;
  }
  return total;
}

fn irradianceFieldScale(corners: ptr<function, IrradianceFieldCorners>, first: u32, scale: f32) {
  for (var corner = first; corner < first + 8u; corner++) { (*corners).weights[corner] *= scale; }
}

fn irradianceFieldCorners(position: vec3f, normal: vec3f, viewDir: vec3f, direction: vec3f, coneAngle: f32) -> IrradianceFieldCorners {
  var corners: IrradianceFieldCorners;
  for (var corner = 0u; corner < IRRADIANCE_FIELD_CORNERS; corner++) {
    corners.values[corner] = vec3f(0.0);
    corners.weights[corner] = 0.0;
  }
  let count = max(irradianceField.levels.x, 1u);
  // Finest level whose traced box holds the receiver; alpha fades it to the next
  // level across the band at the box edge, so level boundaries stay continuous.
  var level = count - 1u;
  var alpha = 1.0;
  for (var l = 0u; l + 1u < count; l++) {
    let q = (position - irradianceField.originSpacing.xyz) / (irradianceField.originSpacing.w * irradianceFieldLevelScale(l));
    let lo = vec3f(irradianceField.validMin[l].xyz);
    let hi = vec3f(irradianceField.validMax[l].xyz - vec3i(1));
    let edge = min(q - lo, hi - q);
    let t = min(edge.x, min(edge.y, edge.z));
    if (!(t > 0.0)) { continue; }
    level = l;
    alpha = select(1.0, saturate(t / irradianceField.bias.w), irradianceField.bias.w > 0.0);
    break;
  }
  let fine = irradianceFieldLevelCorners(&corners, 0u, level, position, normal, viewDir, direction, coneAngle);
  var coarse = 0.0;
  // A fully invalid finer neighbourhood also falls back to the coarser level.
  if (level + 1u < count && (alpha < 1.0 || !(fine > 0.0))) {
    coarse = irradianceFieldLevelCorners(&corners, 8u, level + 1u, position, normal, viewDir, direction, coneAngle);
  }
  let wFine = select(0.0, alpha, fine > 0.0);
  let wCoarse = select(0.0, select(1.0 - alpha, 1.0, !(fine > 0.0)), coarse > 0.0);
  let total = wFine + wCoarse;
  corners.valid = total > 0.0 && !corners.incomplete;
  if (corners.valid) {
    irradianceFieldScale(&corners, 0u, select(0.0, wFine / (fine * total), fine > 0.0));
    irradianceFieldScale(&corners, 8u, select(0.0, wCoarse / (coarse * total), coarse > 0.0));
  }
  return corners;
}

// GGX lobe -> cone half-angle: twice the half-maximum half-vector angle,
// atan(alpha * sqrt(sqrt(2) - 1)), with alpha = roughness^2.
fn radianceCacheConeAngle(roughness: f32) -> f32 {
  return 2.0 * atan(0.643594 * roughness * roughness);
}

// Directional world radiance at a receiver: the same geometric weighting as
// diffuse, admitting supported probes for the requested cone of
// `coneAngle` radians around `direction`. w = 1 when a supported probe contributed.
fn sampleRadianceCacheAt(position: vec3f, normal: vec3f, viewDir: vec3f, direction: vec3f,
    coneAngle: f32) -> vec4f {
  // Retained lighting cannot stand in for geometry absent from this frame's TLAS.
  if (irradianceField.levels.z != 0u) { return vec4f(0.0); }
  let corners = irradianceFieldCorners(position, normal, viewDir, direction, coneAngle);
  if (corners.incomplete) { return vec4f(0.0, 0.0, 0.0, -1.0); }
  if (!corners.valid) { return vec4f(0.0); }
  var sum = vec3f(0.0);
  for (var corner = 0u; corner < IRRADIANCE_FIELD_CORNERS; corner++) {
    let weight = corners.weights[corner];
    if (weight > 0.0) { sum += corners.values[corner] * weight; }
  }
  return vec4f(sum, 1.0);
}

// Diffuse is the wide-cone cache query, sharing support and normalization.
// rgb = D = E / pi; w = 0 means no admissible angular sample.
fn sampleIrradianceField(position: vec3f, normal: vec3f, viewDir: vec3f) -> vec4f {
  return sampleRadianceCacheAt(position, normal, viewDir, normal, RADIANCE_CACHE_CONES.z);
}

// Free-space form: the query direction is also the side-test normal, so only
// probes ahead of the lookup point contribute (the screen-probe world fallback).
fn sampleRadianceCache(position: vec3f, direction: vec3f, coneAngle: f32) -> vec4f {
  return sampleRadianceCacheAt(position, direction, vec3f(0.0), direction, coneAngle);
}
