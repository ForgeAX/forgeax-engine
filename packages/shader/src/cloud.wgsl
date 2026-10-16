#define_import_path forgeax_cloud::layer
// Renderer-owned procedural cloud helpers. Authoring, cache generation and
// the camera/solar/interior callers use this same density and Beer-Lambert
// vocabulary; the Standard material consumes the selected-sun shadow exactly
// once. The renderer writes the stable projection into the View tail after the
// cloud shadow producer has prepared its world-space resource. Keeping the
// projection as explicit arguments avoids importing the View global twice in
// material compositions that already own that binding.

struct CloudLayerParameters {
  seed: u32,
  baseHeight: f32,
  thickness: f32,
  scale: f32,
  coverage: f32,
  density: f32,
  wind: vec3<f32>,
  timeSeconds: f32,
};

const CLOUD_VERTICAL_CELLS: f32 = 1.0;
const CLOUD_VERTICAL_NOISE_CELLS: f32 = 2.0;

fn cloud_hash3(cell: vec3<i32>, seed: u32) -> f32 {
  var h = bitcast<u32>(cell.x) * 0x45d9f3bu;
  h = (h ^ (bitcast<u32>(cell.y) * 0x119de1f3u)) * 0x45d9f3bu;
  h = (h ^ (bitcast<u32>(cell.z) * 0x3449fu)) * 0x45d9f3bu;
  h = h ^ seed;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 13u)) * 0x27d4eb2du;
  return f32(h ^ (h >> 16u)) / 4294967296.0;
}

fn cloud_wrap_cell(value: i32, period: i32) -> i32 {
  let wrapped = value % period;
  return select(wrapped, wrapped + period, wrapped < 0);
}

fn cloud_hash3_periodic(
  cell: vec3<i32>,
  seed: u32,
  periodX: i32,
  periodY: i32,
  periodZ: i32,
) -> f32 {
  return cloud_hash3(
    vec3<i32>(
      cloud_wrap_cell(cell.x, periodX),
      cloud_wrap_cell(cell.y, periodY),
      cloud_wrap_cell(cell.z, periodZ),
    ),
    seed,
  );
}

fn cloud_value_noise(
  position: vec3<f32>,
  seed: u32,
  periodX: i32,
  periodY: i32,
  periodZ: i32,
) -> f32 {
  let cell = vec3<i32>(floor(position));
  let fraction = fract(position);
  let smoothFraction = fraction * fraction * (3.0 - 2.0 * fraction);
  let c000 = cloud_hash3_periodic(cell + vec3<i32>(0, 0, 0), seed, periodX, periodY, periodZ);
  let c100 = cloud_hash3_periodic(cell + vec3<i32>(1, 0, 0), seed, periodX, periodY, periodZ);
  let c010 = cloud_hash3_periodic(cell + vec3<i32>(0, 1, 0), seed, periodX, periodY, periodZ);
  let c110 = cloud_hash3_periodic(cell + vec3<i32>(1, 1, 0), seed, periodX, periodY, periodZ);
  let c001 = cloud_hash3_periodic(cell + vec3<i32>(0, 0, 1), seed, periodX, periodY, periodZ);
  let c101 = cloud_hash3_periodic(cell + vec3<i32>(1, 0, 1), seed, periodX, periodY, periodZ);
  let c011 = cloud_hash3_periodic(cell + vec3<i32>(0, 1, 1), seed, periodX, periodY, periodZ);
  let c111 = cloud_hash3_periodic(cell + vec3<i32>(1, 1, 1), seed, periodX, periodY, periodZ);
  let x00 = mix(c000, c100, smoothFraction.x);
  let x10 = mix(c010, c110, smoothFraction.x);
  let x01 = mix(c001, c101, smoothFraction.x);
  let x11 = mix(c011, c111, smoothFraction.x);
  return mix(mix(x00, x10, smoothFraction.y), mix(x01, x11, smoothFraction.y), smoothFraction.z);
}

fn cloud_cellular_noise(position: vec3<f32>, seed: u32, periodXZ: i32, periodY: i32) -> f32 {
  let cell = vec3<i32>(floor(position));
  let fraction = fract(position);
  var nearest = 1e9;
  var dz: i32 = -1;
  loop {
    var dy: i32 = -1;
    loop {
      var dx: i32 = -1;
      loop {
        let random = cloud_hash3_periodic(
          cell + vec3<i32>(dx, dy, dz),
          seed ^ 0x9e3779b9u,
          periodXZ,
          periodY,
          periodXZ,
        );
        let point = vec3<f32>(
          f32(dx) + fract(random * 17.0) - fraction.x,
          f32(dy) + fract(random * 31.0) - fraction.y,
          f32(dz) + fract(random * 47.0) - fraction.z,
        );
        nearest = min(nearest, dot(point, point));
        if (dx >= 1) { break; }
        dx = dx + 1;
      }
      if (dy >= 1) { break; }
      dy = dy + 1;
    }
    if (dz >= 1) { break; }
    dz = dz + 1;
  }
  return 1.0 - clamp(sqrt(nearest) * 1.25, 0.0, 1.0);
}

fn cloud_weather_field(position: vec3<f32>, seed: u32) -> f32 {
  return smoothstep(
    0.34,
    0.66,
    cloud_value_noise(
      vec3<f32>(position.x * 2.0, 0.37, position.z * 2.0),
      seed + 17041u,
      2,
      1,
      2,
    ),
  );
}

fn cloud_formation_field(position: vec3<f32>, seed: u32) -> vec3<f32> {
  let macroWarpX = cloud_value_noise(
    vec3<f32>(position.x * 2.0, position.y * CLOUD_VERTICAL_NOISE_CELLS + 3.0, position.z * 2.0),
    seed + 41023u,
    2,
    2,
    2,
  ) - 0.5;
  let macroWarpZ = cloud_value_noise(
    vec3<f32>(position.x * 2.0 + 5.0, position.y * CLOUD_VERTICAL_NOISE_CELLS - 7.0, position.z * 2.0),
    seed + 41023u,
    2,
    2,
    2,
  ) - 0.5;
  let bodyX = position.x + macroWarpX * 0.3;
  let bodyZ = position.z + macroWarpZ * 0.3;
  var noise = 0.0;
  var weight = 0.0;
  var amplitude = 0.5;
  var frequency = 1.0;
  for (var octave = 0u; octave < 4u; octave = octave + 1u) {
    let tilePeriod = 4.0 * frequency;
    noise = noise + cloud_value_noise(
      vec3<f32>(bodyX * tilePeriod, position.y * frequency * CLOUD_VERTICAL_NOISE_CELLS, bodyZ * tilePeriod),
      seed + octave * 1013u,
      i32(tilePeriod),
      i32(frequency * CLOUD_VERTICAL_NOISE_CELLS),
      i32(tilePeriod),
    ) * amplitude;
    weight = weight + amplitude;
    amplitude = amplitude * 0.4;
    frequency = frequency * 2.0;
  }
  let broad = noise / max(0.0001, weight);
  let cells = cloud_cellular_noise(
    vec3<f32>(bodyX * 4.0, position.y * CLOUD_VERTICAL_NOISE_CELLS, bodyZ * 4.0),
    seed + 5011u,
    4,
    i32(CLOUD_VERTICAL_NOISE_CELLS),
  );
  // Keep the broad field responsible for the silhouette and use cellular
  // noise as bounded breakup, matching the renderer's cached formation.
  let base = clamp(broad * 0.85 + cells * 0.15 + 0.15, 0.0, 1.0);
  let weather = cloud_weather_field(position, seed);
  let detailPosition = position * 3.0;
  let warpX = cloud_value_noise(
    vec3<f32>(detailPosition.x * 2.0, detailPosition.y * 2.0 + 11.0, detailPosition.z * 2.0),
    seed + 29011u,
    2,
    2,
    2,
  ) - 0.5;
  let warpZ = cloud_value_noise(
    vec3<f32>(detailPosition.x * 2.0 + 7.0, detailPosition.y * 2.0 - 5.0, detailPosition.z * 2.0),
    seed + 29011u,
    2,
    2,
    2,
  ) - 0.5;
  let erosion = cloud_cellular_noise(
    vec3<f32>(
      (detailPosition.x + warpX * 0.22) * 12.0,
      detailPosition.y * 3.0,
      (detailPosition.z + warpZ * 0.22) * 12.0,
    ),
    seed + 7919u,
    12,
    3,
  );
  return vec3<f32>(weather, base, erosion);
}

fn cloud_height_profile(height: f32, body: f32, weather: f32) -> f32 {
  // A body-dependent crown breaks the fixed horizontal slab silhouette while
  // keeping the profile smooth enough for the bounded ray step budget.
  let lowerEdge = 0.05 + (1.0 - body) * 0.1;
  let crownEdge = min(0.96, 0.6 + body * 0.3 + weather * 0.08);
  let lower = smoothstep(lowerEdge, min(1.0, lowerEdge + 0.12), height);
  let upper = 1.0 - smoothstep(crownEdge, min(1.0, crownEdge + 0.14), height);
  return lower * upper;
}

fn cloud_compose_density(height: f32, formation: vec3<f32>, coverage: f32) -> f32 {
  let threshold = 1.0 - coverage * (0.45 + formation.x * 0.55);
  let covered = smoothstep(0.0, 0.4, (formation.y - threshold) / max(0.001, 1.0 - threshold));
  let shaped = covered * cloud_height_profile(height, formation.y, formation.x);
  let erosion = (1.0 - formation.z) * 0.18;
  return clamp((shaped - erosion) / (1.0 - erosion), 0.0, 1.0);
}

fn cloud_density(params: CloudLayerParameters, worldPosition: vec3<f32>) -> f32 {
  let h = (worldPosition.y - params.baseHeight) / max(0.0001, params.thickness);
  if (h <= 0.0 || h >= 1.0 || params.density <= 0.0 || params.coverage <= 0.0) { return 0.0; }
  let advected = worldPosition + params.wind * params.timeSeconds;
  let advectedHeight = h +
    (advected.y - worldPosition.y) * params.scale / max(CLOUD_VERTICAL_CELLS, 0.000001);
  let p = vec3<f32>(
    advected.x * params.scale,
    fract(advectedHeight) * CLOUD_VERTICAL_CELLS,
    advected.z * params.scale,
  );
  let formation = cloud_formation_field(p, params.seed);
  return cloud_compose_density(h, formation, params.coverage) * params.density;
}

fn cloud_optical_transmittance(opticalDepth: f32) -> f32 {
  return exp(-max(0.0, opticalDepth));
}

// The cloud shadow map is a renderer-owned, texel-snapped world-space resource.
// It is sampled at each receiver position, so camera motion cannot move the
// shadow pattern and no camera/fog midpoint scalar can leak into lighting.
//
// The low sampled-texture variant has no spare view texture lane. It therefore
// keeps direct solar fully lit and omits this pair. `CLOUD_SHADOW_LOW_LIMIT`
// is injected only for material variants that declare
// `PROJECTOR_AVAILABLE=false`; authored and standalone programs without the
// override keep the regular 16/17 bindings.
#ifndef CLOUD_SHADOW_LOW_LIMIT
@group(0) @binding(16) var cloudShadowMap: texture_2d<f32>;
@group(0) @binding(17) var cloudShadowSampler: sampler;

fn cloud_direct_solar_factor(
  worldPosition: vec3<f32>,
  shadowOrigin: vec3<f32>,
  shadowRight: vec3<f32>,
  shadowUp: vec3<f32>,
  shadowProjection: vec4<f32>,
) -> f32 {
  let validReceiver =
    worldPosition.x == worldPosition.x && worldPosition.y == worldPosition.y &&
    worldPosition.z == worldPosition.z && all(abs(worldPosition) < vec3<f32>(3.402823e+38));
  let offset = worldPosition - shadowOrigin;
  let uv = vec2<f32>(dot(offset, shadowRight), dot(offset, shadowUp)) / max(shadowProjection.x, 1e-6) + vec2<f32>(0.5);
  let inRange = all(uv >= vec2<f32>(0.0)) && all(uv <= vec2<f32>(1.0));
  let available = shadowProjection.y > 0.5 && shadowProjection.z < 0.5 && shadowProjection.x > 0.0;
  let sampled = textureSampleLevel(cloudShadowMap, cloudShadowSampler, clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;
  // Low sun, no cloud producer, malformed receivers and receivers outside the
  // bounded map all retain the direct-sun fallback of one.
  return select(1.0, clamp(sampled, 0.0, 1.0), validReceiver && inRange && available);
}

fn cloud_apply_direct_solar(
  radiance: vec3<f32>,
  worldPosition: vec3<f32>,
  shadowOrigin: vec3<f32>,
  shadowRight: vec3<f32>,
  shadowUp: vec3<f32>,
  shadowProjection: vec4<f32>,
) -> vec3<f32> {
  return radiance * cloud_direct_solar_factor(
    worldPosition, shadowOrigin, shadowRight, shadowUp, shadowProjection,
  );
}
#else
// The minimum 16-sampled-texture profile has no spare view texture lane.
// Keep direct solar fully lit while the producer-owned cloud shadow map is
// unavailable; richer variants execute the sampled path above.
fn cloud_direct_solar_factor(
  worldPosition: vec3<f32>,
  shadowOrigin: vec3<f32>,
  shadowRight: vec3<f32>,
  shadowUp: vec3<f32>,
  shadowProjection: vec4<f32>,
) -> f32 {
  return 1.0;
}

fn cloud_apply_direct_solar(
  radiance: vec3<f32>,
  worldPosition: vec3<f32>,
  shadowOrigin: vec3<f32>,
  shadowRight: vec3<f32>,
  shadowUp: vec3<f32>,
  shadowProjection: vec4<f32>,
) -> vec3<f32> {
  return radiance;
}
#endif
