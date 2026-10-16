/** Canonical cloud optical coefficients shared by CPU preparation and WGSL. */
export const CLOUD_VERTICAL_CELLS = 1;
export const CLOUD_EXTINCTION_COEFFICIENT = 0.03;

/** Minimal copy compute; one invocation owns one packed u32 cache element. */
export const CLOUD_DENSITY_COMPUTE_WGSL = /* wgsl */ `
struct CloudCacheParams { count: u32, }
@group(0) @binding(0) var<storage, read> sourceDensity: array<u32>;
@group(0) @binding(1) var<storage, read_write> cachedDensity: array<u32>;
@group(0) @binding(2) var<uniform> params: CloudCacheParams;
@compute @workgroup_size(64)
fn cloud_density_cache(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.count) { return; }
  cachedDensity[id.x] = sourceDensity[id.x];
}
`;

/**
 * Cloud view transport. The View group is the renderer-owned camera/light
 * source of truth; group(1) carries frame-local cloud parameters, depth and
 * the bounded packed 3D cache. Camera, solar-column and cloud-interior
 * integration all call cloud_density(), so wind only changes the sample
 * coordinate and never the authored field.
 */
export const CLOUD_VIEW_FULLSCREEN_WGSL = /* wgsl */ `
const CLOUD_VERTICAL_CELLS: f32 = ${CLOUD_VERTICAL_CELLS};
const CLOUD_VERTICAL_NOISE_CELLS: f32 = 2.0;

struct CloudCameraView {
  worldViewProj: mat4x4<f32>,
  lightDir: vec3<f32>,
  lightColor: vec3<f32>,
  cameraPos: vec3<f32>,
  lightViewProj_A: mat4x4<f32>,
  inverseViewProj: mat4x4<f32>,
  lightViewProj_B: mat4x4<f32>,
  lightViewProj_C: mat4x4<f32>,
  lightViewProj_D: mat4x4<f32>,
  splitPlanes: array<vec4<f32>, 4>,
  cascadeCount: f32,
  cascadeBlend: f32,
  depthBias: f32,
  normalBias: f32,
  directionalShadowFilter: vec4<f32>,
  spotLightViewProj: array<mat4x4<f32>, 4>,
  temporalCurrentViewProj: mat4x4<f32>,
  temporalPreviousViewProj: mat4x4<f32>,
  temporalProjection: vec4<f32>,
  temporalPreviousCameraPos: vec4<f32>,
  ssrParams: vec4<f32>,
};

struct CloudViewParams {
  layer: vec4<f32>,       // baseHeight, thickness, scale, density
  field: vec4<f32>,       // coverage, timeSeconds, maxDistance, seed
  wind: vec4<f32>,        // xyz m/s
  sunDirection: vec4<f32>,
  sunRadiance: vec4<f32>,
  integration: vec4<u32>, // cacheResolution, viewSteps, solarSteps, reserved
  shadowOrigin: vec4<f32>,
  shadowRight: vec4<f32>,
  shadowUp: vec4<f32>,
  shadowProjection: vec4<f32>, // range, valid, lowSun, texelSize
  temporal: vec4<f32>,          // valid, reset, historyWeight, reserved
};

@group(0) @binding(0) var<uniform> view: CloudCameraView;
@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var<uniform> cloud: CloudViewParams;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var previousRadiance: texture_2d<f32>;
@group(1) @binding(6) var previousTransmittance: texture_2d<f32>;
@group(1) @binding(7) var previousDepth: texture_2d<f32>;
@group(1) @binding(8) var<storage, read> densityCache: array<u32>;

struct CloudViewOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

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
  // Keep the broad field responsible for the cloud silhouette and use the
  // cellular term as bounded breakup. A broad-dominant mix reads as fewer,
  // wider formations instead of evenly spaced foam balls.
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

fn cloud_analytic_density(position: vec3<f32>) -> f32 {
  let height = (position.y - cloud.layer.x) / max(0.000001, cloud.layer.y);
  if (height <= 0.0 || height >= 1.0 || cloud.layer.w <= 0.0 || cloud.field.x <= 0.0) { return 0.0; }
  let advected = position + cloud.wind.xyz * cloud.field.y;
  let advectedHeight = height +
    cloud.wind.y * cloud.field.y * cloud.layer.z / max(CLOUD_VERTICAL_CELLS, 0.000001);
  let p = vec3<f32>(
    advected.x * cloud.layer.z,
    fract(advectedHeight) * CLOUD_VERTICAL_CELLS,
    advected.z * cloud.layer.z,
  );
  let formation = cloud_formation_field(p, u32(round(cloud.field.w)));
  return cloud_compose_density(height, formation, cloud.field.x) * cloud.layer.w;
}

fn cloud_cache_byte(index: u32) -> f32 {
  let word = densityCache[index >> 2u];
  let shift = (index & 3u) * 8u;
  return f32((word >> shift) & 255u) / 255.0;
}

fn cloud_cache_component(plane: u32, index: u32, stride: u32) -> f32 {
  return cloud_cache_byte(plane * stride + index);
}

fn cloud_cache_trilinear(
  plane: u32,
  resolution: u32,
  x0: u32,
  x1: u32,
  y0: u32,
  y1: u32,
  z0: u32,
  z1: u32,
  fx: f32,
  fy: f32,
  fz: f32,
) -> f32 {
  let stride = resolution * resolution * resolution;
  let layer = resolution * resolution;
  let c000 = cloud_cache_component(plane, z0 * layer + y0 * resolution + x0, stride);
  let c100 = cloud_cache_component(plane, z0 * layer + y0 * resolution + x1, stride);
  let c010 = cloud_cache_component(plane, z0 * layer + y1 * resolution + x0, stride);
  let c110 = cloud_cache_component(plane, z0 * layer + y1 * resolution + x1, stride);
  let c001 = cloud_cache_component(plane, z1 * layer + y0 * resolution + x0, stride);
  let c101 = cloud_cache_component(plane, z1 * layer + y0 * resolution + x1, stride);
  let c011 = cloud_cache_component(plane, z1 * layer + y1 * resolution + x0, stride);
  let c111 = cloud_cache_component(plane, z1 * layer + y1 * resolution + x1, stride);
  let x00 = mix(c000, c100, fx);
  let x10 = mix(c010, c110, fx);
  let x01 = mix(c001, c101, fx);
  let x11 = mix(c011, c111, fx);
  return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz);
}

fn cloud_density(position: vec3<f32>) -> f32 {
  let height = (position.y - cloud.layer.x) / max(0.000001, cloud.layer.y);
  if (height <= 0.0 || height >= 1.0 || cloud.layer.w <= 0.0 || cloud.field.x <= 0.0) { return 0.0; }
  let resolution = cloud.integration.x;
  if (resolution < 4u) { return max(cloud_analytic_density(position), 0.0); }
  let periodCoordinate = fract((position.xz + cloud.wind.xz * cloud.field.y) * cloud.layer.z);
  let x = fract(periodCoordinate.x - 0.5 / f32(resolution)) * f32(resolution);
  let z = fract(periodCoordinate.y - 0.5 / f32(resolution)) * f32(resolution);
  let advectedHeight = height +
    cloud.wind.y * cloud.field.y * cloud.layer.z / max(CLOUD_VERTICAL_CELLS, 0.000001);
  let y = fract(advectedHeight - 0.5 / f32(resolution)) * f32(resolution);
  let x0 = u32(floor(x));
  let y0 = u32(floor(y));
  let z0 = u32(floor(z));
  let x1 = (x0 + 1u) % resolution;
  let y1 = (y0 + 1u) % resolution;
  let z1 = (z0 + 1u) % resolution;
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let fz = z - f32(z0);
  let weather = cloud_cache_trilinear(0u, resolution, x0, x1, y0, y1, z0, z1, fx, fy, fz);
  let body = cloud_cache_trilinear(1u, resolution, x0, x1, y0, y1, z0, z1, fx, fy, fz);
  // Repeat only the independent erosion plane: fine boundary structure with
  // the same eight packed reads and the same cache allocation.
  let detail = fract(vec3<f32>(periodCoordinate.x, advectedHeight, periodCoordinate.y) * 3.0 - vec3<f32>(0.5 / f32(resolution))) * f32(resolution);
  let d0 = vec3<u32>(floor(detail));
  let d1 = (d0 + vec3<u32>(1u)) % vec3<u32>(resolution);
  let df = fract(detail);
  let erosion = cloud_cache_trilinear(2u, resolution, d0.x, d1.x, d0.y, d1.y, d0.z, d1.z, df.x, df.y, df.z);
  return cloud_compose_density(height, vec3<f32>(weather, body, erosion), cloud.field.x) * cloud.layer.w;
}

fn cloud_layer_interval(origin: vec3<f32>, direction: vec3<f32>, maxDistance: f32) -> vec2<f32> {
  if (abs(direction.y) < 0.000001) {
    if (origin.y < cloud.layer.x || origin.y > cloud.layer.x + cloud.layer.y) {
      return vec2<f32>(1.0, 0.0);
    }
    return vec2<f32>(0.0, maxDistance);
  }
  let lower = (cloud.layer.x - origin.y) / direction.y;
  let upper = (cloud.layer.x + cloud.layer.y - origin.y) / direction.y;
  return vec2<f32>(
    max(0.0, min(lower, upper)),
    min(maxDistance, max(lower, upper)),
  );
}

fn cloud_solar_transmittance(position: vec3<f32>) -> f32 {
  let sunDirection = normalize(-view.lightDir);
  let solarDistance = select(cloud.field.z, cloud.shadowProjection.x, cloud.shadowProjection.x > 0.0);
  let interval = cloud_layer_interval(position, sunDirection, solarDistance);
  if (interval.y <= interval.x) { return 1.0; }
  let steps = min(cloud.integration.z, 64u);
  let stepLength = (interval.y - interval.x) / max(1.0, f32(steps));
  var opticalDepth = 0.0;
  let solarJitter = cloud_solar_jitter(position);
  for (var index = 0u; index < 64u; index = index + 1u) {
    if (index >= steps) { break; }
    let samplePosition = position + sunDirection * (interval.x + (f32(index) + solarJitter) * stepLength);
    opticalDepth = opticalDepth + cloud_density(samplePosition) * ${CLOUD_EXTINCTION_COEFFICIENT} * stepLength;
  }
  return exp(-max(opticalDepth, 0.0));
}

fn cloud_henyey_greenstein(cosTheta: f32, g: f32) -> f32 {
  let denominator = max(0.0001, 1.0 + g * g - 2.0 * g * cosTheta);
  return (1.0 - g * g) / (denominator * sqrt(denominator)) * 0.0795774715;
}

fn cloud_phase(cosTheta: f32) -> f32 {
  // A bounded dual lobe gives a readable forward highlight and a small
  // back-scatter rim without another solar march.
  return cloud_henyey_greenstein(cosTheta, 0.55) * 0.8 +
    cloud_henyey_greenstein(cosTheta, -0.2) * 0.2;
}

// Reuse the same remaining-path optical depth for two bounded scattering
// orders. This adds arithmetic only; no extra density or light-ray samples.
fn cloud_incident_light(solarT: f32, cosTheta: f32, height: f32) -> vec3<f32> {
  let direct = solarT * cloud_phase(cosTheta);
  let multiple = (0.5 * pow(solarT, 0.5) + 0.25 * pow(solarT, 0.25)) * 0.0795774715;
  let skyFill = mix(0.025, 0.075, smoothstep(0.1, 0.85, height));
  // Match volume-integrate: the shared DirectionalLight value uses the
  // unnormalized phase convention. Convert the normalized HG basis once.
  return cloud.sunRadiance.xyz *
    (vec3<f32>((direct + multiple) * 12.5663706144) + vec3<f32>(0.72, 0.84, 1.0) * skyFill);
}

fn cloud_ray_jitter(pixel: vec2<f32>) -> f32 {
  // A stable per-pixel offset removes view-step contour bands without adding
  // a frame-varying noise source that would fight temporal reprojection.
  return fract(sin(dot(pixel, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}

fn cloud_solar_jitter(position: vec3<f32>) -> f32 {
  // Dither the light-column samples in world space so low shadow-step
  // profiles do not paint parallel contour bands across cloud bases.
  return fract(sin(dot(position.xz, vec2<f32>(19.193, 47.117))) * 15731.743);
}

fn reconstruct_world(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = view.inverseViewProj * ndc;
  return world.xyz / max(abs(world.w), 1e-30);
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> CloudViewOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output: CloudViewOut;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  // WebGPU clip-space Y grows upward while sampled framebuffer rows and the
  // depth texture use a top-left origin. Keep this one top-left UV for color,
  // depth and inverse-projection reconstruction; flipping only the final
  // color would leave the camera ray and depth cut mirrored.
  output.uv = vec2<f32>(
    positions[index].x * 0.5 + 0.5,
    1.0 - (positions[index].y * 0.5 + 0.5),
  );
  return output;
}

@fragment
fn fs_main(input: CloudViewOut) -> @location(0) vec4<f32> {
  // The shadow producer uses this same production density/cache contract but
  // rasterizes a camera-independent, texel-snapped light-space map. It does
  // not consume scene colour; the generic fullscreen host still supplies the
  // input binding to keep the feature binding ABI single and validated.
  if (cloud.integration.w == 1u) {
    let projection = cloud.shadowProjection;
    if (projection.y < 0.5 || projection.z > 0.5 || projection.x <= 0.0) {
      return vec4<f32>(1.0);
    }
    let offset = (input.uv - vec2<f32>(0.5)) * projection.x;
    let receiver = cloud.shadowOrigin.xyz +
      cloud.shadowRight.xyz * offset.x + cloud.shadowUp.xyz * offset.y;
    let sunDirection = normalize(-view.lightDir);
    let interval = cloud_layer_interval(receiver, sunDirection, projection.x);
    if (interval.y <= interval.x) { return vec4<f32>(1.0); }
    let steps = min(cloud.integration.z, 64u);
    let stepLength = (interval.y - interval.x) / max(1.0, f32(steps));
    var opticalDepth = 0.0;
    var firstHeight = 1.0;
    var lastHeight = 0.0;
    var occupied = false;
    let solarJitter = cloud_solar_jitter(receiver);
    for (var index = 0u; index < 64u; index = index + 1u) {
      if (index >= steps) { break; }
      let samplePosition = receiver + sunDirection *
        (interval.x + (f32(index) + solarJitter) * stepLength);
      let localDensity = cloud_density(samplePosition);
      opticalDepth = opticalDepth + localDensity * ${CLOUD_EXTINCTION_COEFFICIENT} * stepLength;
      if (localDensity > 0.0001) {
        let sampleHeight = clamp(
          (samplePosition.y - cloud.layer.x) / max(0.0001, cloud.layer.y),
          0.0,
          1.0,
        );
        if (!occupied) { firstHeight = sampleHeight; }
        lastHeight = sampleHeight;
        occupied = true;
      }
    }
    let transmittance = exp(-max(opticalDepth, 0.0));
    // R stores full-column transmittance. G/B preserve the first/last
    // occupied normalized layer heights so interior samples can estimate the
    // remaining segment without pretending optical depth is uniform through
    // the whole layer. A stores the integrated optical depth and distinguishes
    // an empty projected column from a valid, nearly-clear one.
    return vec4<f32>(
      transmittance,
      select(1.0, firstHeight, occupied),
      select(0.0, lastHeight, occupied),
      select(0.0, opticalDepth, occupied),
    );
  }
  // The shadow producer branch above is per-fragment (its light-space
  // interval depends on the rasterized receiver), so derivative-based
  // sampling here would violate WGSL uniform-control-flow rules. The cloud
  // scene path already owns an explicit level-0 sampler contract.
  // Keep point semantics for the current full-resolution scene path. The
  // half-resolution transport contract is introduced with its own resolve
  // shader so this path retains the established depth convention.
  let depthPixel = vec2<i32>(input.position.xy);
  let depth = textureLoad(sceneDepth, depthPixel, 0);
  let farWorld = reconstruct_world(input.uv, 0.5);
  let sceneWorld = reconstruct_world(input.uv, clamp(depth, 0.0, 1.0));
  let ray = normalize(farWorld - view.cameraPos);
  let rayJitter = cloud_ray_jitter(input.position.xy);
  // Geometry beyond the cloud domain must not extend that domain only on
  // its silhouette; sky and geometry rays share the same integration limit.
  let sceneDistance = min(cloud.field.z, select(cloud.field.z, length(sceneWorld - view.cameraPos), depth > 0.0));
  let interval = cloud_layer_interval(view.cameraPos, ray, sceneDistance);

  // The depth producer shares the same camera ray, interval and density
  // contract as the display path. It writes a cloud representative world
  // position and a validity bit so history remains comparable after camera
  // translation or rotation and never uses an opaque scene distance as a
  // proxy for a participating medium.
  if (cloud.integration.w == 2u) {
    if (interval.y <= interval.x) { return vec4<f32>(sceneWorld, 0.0); }
    let depthSteps = min(cloud.integration.y, 64u);
    let depthStepLength = (interval.y - interval.x) / max(1.0, f32(depthSteps));
    var depthTransmittance = 1.0;
    var weightedDistance = 0.0;
    var opticalWeight = 0.0;
    for (var depthIndex = 0u; depthIndex < 64u; depthIndex = depthIndex + 1u) {
      if (depthIndex >= depthSteps) { break; }
      let sampleDistance = interval.x + (f32(depthIndex) + rayJitter) * depthStepLength;
      let samplePosition = view.cameraPos + ray * sampleDistance;
      let localDensity = cloud_density(samplePosition);
      let localTransmittance = exp(-max(localDensity * ${CLOUD_EXTINCTION_COEFFICIENT} * depthStepLength, 0.0));
      let weight = depthTransmittance * (1.0 - localTransmittance);
      weightedDistance = weightedDistance + sampleDistance * weight;
      opticalWeight = opticalWeight + weight;
      depthTransmittance = depthTransmittance * localTransmittance;
    }
    let hasCloud = opticalWeight > 0.00001;
    let representativeDistance = select(sceneDistance, weightedDistance / opticalWeight, hasCloud);
    let representativeWorld = view.cameraPos + ray * representativeDistance;
    return vec4<f32>(representativeWorld, select(0.0, 1.0, hasCloud));
  }

  let scene = textureSampleLevel(sceneColor, sceneSampler, input.uv, 0.0);
  if (interval.y <= interval.x) { return scene; }
  let steps = min(cloud.integration.y, 64u);
  let stepLength = (interval.y - interval.x) / max(1.0, f32(steps));
  var transmittance = 1.0;
  var scattering = vec3<f32>(0.0);
  var weightedDistance = 0.0;
  var opticalWeight = 0.0;
  let sunDirection = normalize(-view.lightDir);
  for (var index = 0u; index < 64u; index = index + 1u) {
    if (index >= steps) { break; }
    let distance = interval.x + (f32(index) + rayJitter) * stepLength;
    let samplePosition = view.cameraPos + ray * distance;
    let localDensity = cloud_density(samplePosition);
    let extinction = localDensity * ${CLOUD_EXTINCTION_COEFFICIENT} * stepLength;
    let localTransmittance = exp(-max(extinction, 0.0));
    let depthWeight = transmittance * (1.0 - localTransmittance);
    weightedDistance = weightedDistance + distance * depthWeight;
    opticalWeight = opticalWeight + depthWeight;
    // Empty samples are common in the separated-cloud field. Avoid a nested
    // solar march for them and stop once the camera path is effectively opaque.
    if (localDensity > 0.0001 && transmittance > 0.01) {
      let solarTransmittance = cloud_solar_transmittance(samplePosition);
      let cloudHeight = clamp(
        (samplePosition.y - cloud.layer.x) / max(0.0001, cloud.layer.y), 0.0, 1.0,
      );
      scattering = scattering + cloud_incident_light(
        solarTransmittance, dot(ray, sunDirection), cloudHeight,
      ) * depthWeight;
    }
    transmittance = transmittance * localTransmittance;
    if (transmittance < 0.01) { break; }
  }
  let hasCloud = opticalWeight > 0.00001;
  let representativeDistance = select(sceneDistance, weightedDistance / opticalWeight, hasCloud);
  let representativeWorld = view.cameraPos + ray * representativeDistance;
  // Wind is an advective coordinate change. Reproject the cloud point into
  // the previous frame's world before applying the previous camera matrix;
  // authored field values remain immutable.
  let windDelta = cloud.wind.xyz * max(0.0, cloud.field.y - cloud.temporal.w);
  // cloud_density evaluates the authored field at position + wind*time.
  // Keeping the same field sample in the previous frame therefore advances
  // the previous world point by the elapsed wind delta as well.
  let previousCloudWorld = representativeWorld + windDelta;
  let previousCloudClip = view.temporalPreviousViewProj * vec4<f32>(previousCloudWorld, 1.0);
  let previousCloudNdc = previousCloudClip.xyz / max(abs(previousCloudClip.w), 0.00001);
  let previousCloudUv = vec2<f32>(
    previousCloudNdc.x * 0.5 + 0.5,
    1.0 - (previousCloudNdc.y * 0.5 + 0.5),
  );
  let cloudInBounds = all(previousCloudUv >= vec2<f32>(0.0)) && all(previousCloudUv <= vec2<f32>(1.0));
  let cloudHistoryUv = clamp(previousCloudUv, vec2<f32>(0.0), vec2<f32>(1.0));
  let cloudHistoryDepthSample = textureSampleLevel(previousDepth, depthSampler, cloudHistoryUv, 0.0);
  let cloudHistoryWorld = cloudHistoryDepthSample.xyz * 1000.0;
  let previous = textureSampleLevel(previousRadiance, sceneSampler, cloudHistoryUv, 0.0);
  let previousTransport = textureSampleLevel(
    previousTransmittance,
    sceneSampler,
    cloudHistoryUv,
    0.0,
  );
  let worldTolerance = max(0.05, length(previousCloudWorld - view.cameraPos) * 0.02);
  let depthAccepted = cloudHistoryDepthSample.a > 0.5 &&
    distance(cloudHistoryWorld, previousCloudWorld) <= worldTolerance;
  let accepted =
    hasCloud && cloud.temporal.x > 0.5 && cloud.temporal.y < 0.5 && cloudInBounds &&
    depthAccepted && previousTransport.a > 0.0;
  let historyWeight = select(0.0, clamp(cloud.temporal.z, 0.0, 0.95), accepted);
  let cloudRadiance = mix(scattering, previous.rgb, historyWeight);
  // Preserve scene-linear HDR output for the downstream material lane. The
  // history owner receives cloudRadiance separately through the history pass.
  return vec4<f32>(scene.rgb * transmittance + cloudRadiance, transmittance);
}

// The light-space shadow producer already paid for a bounded column integral.
// Reuse that texel for camera samples instead of starting a full solar march
// for every occupied camera step. Outside the occupied interval the cached
// full-column transmittance is exact for the projected column. Inside the
// interval, the cache supplies the stable projection/bounds and a short
// residual march resolves the non-uniform density that a linear optical-depth
// interpolation would lose. Invalid/out-of-range projections retain the
// analytic path as an explicit fallback.
fn cloud_solar_cached_transmittance(position: vec3<f32>) -> f32 {
  let projection = cloud.shadowProjection;
  if (projection.y < 0.5 || projection.x <= 0.0) {
    return cloud_solar_transmittance(position);
  }
  let relative = position - cloud.shadowOrigin.xyz;
  let uv = vec2<f32>(
    dot(relative, cloud.shadowRight.xyz) / projection.x + 0.5,
    dot(relative, cloud.shadowUp.xyz) / projection.x + 0.5,
  );
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) {
    return cloud_solar_transmittance(position);
  }
  let cachedShadow = textureSampleLevel(previousRadiance, sceneSampler, uv, 0.0);
  let cachedOpticalDepth = max(cachedShadow.a, 0.0);
  let layerHeight = clamp(
    (position.y - cloud.layer.x) / max(0.0001, cloud.layer.y),
    0.0,
    1.0,
  );
  if (cachedOpticalDepth <= 0.0001) { return 1.0; }
  let firstHeight = clamp(cachedShadow.g, 0.0, 1.0);
  let lastHeight = clamp(cachedShadow.b, 0.0, 1.0);
  let occupiedMin = min(firstHeight, lastHeight);
  let occupiedMax = max(firstHeight, lastHeight);
  let sunDirection = normalize(-view.lightDir);
  // G/B are ordered along the light ray, not necessarily bottom-to-top. Only
  // use the cached full/empty fast paths when the light has enough vertical
  // component to make that ordering meaningful; grazing light stays on the
  // residual path so a low-sun column cannot invert the cache bounds.
  if (abs(sunDirection.y) > 0.2) {
    if (sunDirection.y > 0.0) {
      if (layerHeight <= occupiedMin) { return exp(-cachedOpticalDepth); }
      if (layerHeight >= occupiedMax) { return 1.0; }
    } else {
      if (layerHeight >= occupiedMax) { return exp(-cachedOpticalDepth); }
      if (layerHeight <= occupiedMin) { return 1.0; }
    }
  }

  // A short residual march is only paid for samples inside the projected
  // cloud span. Vertical light uses twelve taps, oblique light sixteen, and
  // grazing light up to thirty-two because the same layer projects across a
  // much longer solar segment. This removes the large error caused by
  // assuming optical depth is uniform between the first and last occupied
  // heights while keeping the normal camera path far below a second full
  // solar integration.
  let solarDistance = select(cloud.field.z, projection.x, projection.x > 0.0);
  let interval = cloud_layer_interval(position, sunDirection, solarDistance);
  if (interval.y <= interval.x) { return 1.0; }
  let absLightY = abs(sunDirection.y);
  let directionBudget = select(
    32u,
    select(16u, 12u, absLightY > 0.5),
    absLightY > 0.2,
  );
  let residualSteps = min(directionBudget, max(8u, cloud.integration.z * 3u));
  let stepLength = (interval.y - interval.x) / max(1.0, f32(residualSteps));
  var opticalDepth = 0.0;
  let solarJitter = cloud_solar_jitter(position);
  for (var index = 0u; index < 32u; index = index + 1u) {
    if (index >= residualSteps) { break; }
    let samplePosition = position + sunDirection *
      (interval.x + (f32(index) + solarJitter) * stepLength);
    opticalDepth = opticalDepth + cloud_density(samplePosition) *
      ${CLOUD_EXTINCTION_COEFFICIENT} * stepLength;
  }
  return exp(-max(opticalDepth, 0.0));
}

struct CloudTransportOutput {
  @location(0) radiance: vec4<f32>,
  @location(1) transmittance: vec4<f32>,
  @location(2) depth: vec4<f32>,
};

// One half-resolution transport pass writes all three reusable cloud fields.
// The full-resolution resolve below reconstructs colour and applies temporal
// history; no second full raymarch exists solely to obtain cloud depth.
@fragment
fn fs_transport(input: CloudViewOut) -> CloudTransportOutput {
  let depth = textureSampleLevel(sceneDepth, depthSampler, input.uv, 0u);
  let farWorld = reconstruct_world(input.uv, 0.5);
  let sceneWorld = reconstruct_world(input.uv, clamp(depth, 0.0, 1.0));
  let ray = normalize(farWorld - view.cameraPos);
  let rayJitter = cloud_ray_jitter(input.position.xy);
  // Geometry beyond the cloud domain must not extend that domain only on
  // its silhouette; sky and geometry rays share the same integration limit.
  let sceneDistance = min(cloud.field.z, select(cloud.field.z, length(sceneWorld - view.cameraPos), depth > 0.0));
  let interval = cloud_layer_interval(view.cameraPos, ray, sceneDistance);
  var output: CloudTransportOutput;
  output.radiance = vec4<f32>(0.0, 0.0, 0.0, 0.0);
  output.transmittance = vec4<f32>(1.0, 1.0, 1.0, 1.0);
  // Invalid samples remain finite even when the camera far plane exceeds half-float range.
  output.depth = vec4<f32>(0.0);
  if (interval.y <= interval.x) { return output; }

  let steps = min(cloud.integration.y, 64u);
  let stepLength = (interval.y - interval.x) / max(1.0, f32(steps));
  var transmittance = 1.0;
  var scattering = vec3<f32>(0.0);
  var weightedDistance = 0.0;
  var opticalWeight = 0.0;
  let sunDirection = normalize(-view.lightDir);
  for (var index = 0u; index < 64u; index = index + 1u) {
    if (index >= steps) { break; }
    let distance = interval.x + (f32(index) + rayJitter) * stepLength;
    let samplePosition = view.cameraPos + ray * distance;
    let localDensity = cloud_density(samplePosition);
    let extinction = localDensity * ${CLOUD_EXTINCTION_COEFFICIENT} * stepLength;
    let localTransmittance = exp(-max(extinction, 0.0));
    let depthWeight = transmittance * (1.0 - localTransmittance);
    weightedDistance = weightedDistance + distance * depthWeight;
    opticalWeight = opticalWeight + depthWeight;
    if (localDensity > 0.0001 && transmittance > 0.01) {
      let solarTransmittance = cloud_solar_cached_transmittance(samplePosition);
      let cloudHeight = clamp(
        (samplePosition.y - cloud.layer.x) / max(0.0001, cloud.layer.y), 0.0, 1.0,
      );
      scattering = scattering + cloud_incident_light(
        solarTransmittance, dot(ray, sunDirection), cloudHeight,
      ) * depthWeight;
    }
    transmittance = transmittance * localTransmittance;
    if (transmittance < 0.01) { break; }
  }
  let hasCloud = opticalWeight > 0.00001;
  let representativeDistance = select(sceneDistance, weightedDistance / max(opticalWeight, 0.00001), hasCloud);
  output.radiance = vec4<f32>(scattering, select(0.0, 1.0, hasCloud));
  output.transmittance = vec4<f32>(transmittance, transmittance, transmittance, 1.0);
  output.depth = vec4<f32>(select(vec3<f32>(0.0), (view.cameraPos + ray * representativeDistance) * 0.001, hasCloud), select(0.0, 1.0, hasCloud));
  return output;
}
`;

/** Shared cloud transport module; `fs_transport` is selected by the MRT PSO. */
export const CLOUD_TRANSPORT_FULLSCREEN_WGSL = CLOUD_VIEW_FULLSCREEN_WGSL;
/** Analytic fallback for adapters without a projected cloud-shadow target. */
export const CLOUD_TRANSPORT_ANALYTIC_FULLSCREEN_WGSL = CLOUD_VIEW_FULLSCREEN_WGSL.replace(
  'cloud_solar_cached_transmittance(samplePosition)',
  'cloud_solar_transmittance(samplePosition)',
);

/**
 * History writer. It is a separate MRT pass so the cloud composite remains a
 * normal scene-linear color producer while the renderer owns the ping-pong
 * radiance/transmittance/depth attachments and advances them only on submit.
 */
export const CLOUD_HISTORY_FULLSCREEN_WGSL = /* wgsl */ `
struct CloudCameraView {
  worldViewProj: mat4x4<f32>,
  lightDir: vec3<f32>,
  lightColor: vec3<f32>,
  cameraPos: vec3<f32>,
  lightViewProj_A: mat4x4<f32>,
  inverseViewProj: mat4x4<f32>,
  lightViewProj_B: mat4x4<f32>,
  lightViewProj_C: mat4x4<f32>,
  lightViewProj_D: mat4x4<f32>,
  splitPlanes: array<vec4<f32>, 4>,
  cascadeCount: f32,
  cascadeBlend: f32,
  depthBias: f32,
  normalBias: f32,
  directionalShadowFilter: vec4<f32>,
  spotLightViewProj: array<mat4x4<f32>, 4>,
  temporalCurrentViewProj: mat4x4<f32>,
  temporalPreviousViewProj: mat4x4<f32>,
  temporalProjection: vec4<f32>,
  temporalPreviousCameraPos: vec4<f32>,
  ssrParams: vec4<f32>,
};

struct CloudHistoryParams {
  temporal: vec4<f32>, // valid, reset, historyWeight, reserved
  windTime: vec4<f32>, // wind.xyz, elapsed seconds since previous submit
};

@group(0) @binding(0) var<uniform> view: CloudCameraView;
@group(1) @binding(0) var currentRadiance: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var<uniform> params: CloudHistoryParams;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var currentCloudDepth: texture_2d<f32>;
@group(1) @binding(6) var sceneBackground: texture_2d<f32>;

struct CloudHistoryInput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

struct CloudHistoryOutput {
  @location(0) radiance: vec4<f32>,
  @location(1) transmittance: vec4<f32>,
};

fn reconstruct_world(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = view.inverseViewProj * ndc;
  return world.xyz / max(abs(world.w), 1e-30);
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> CloudHistoryInput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output: CloudHistoryInput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  output.uv = vec2<f32>(
    positions[index].x * 0.5 + 0.5,
    1.0 - (positions[index].y * 0.5 + 0.5),
  );
  return output;
}

@fragment
fn fs_main(input: CloudHistoryInput) -> CloudHistoryOutput {
  let current = textureSampleLevel(currentRadiance, sceneSampler, input.uv, 0.0);
  let background = textureSampleLevel(sceneBackground, sceneSampler, input.uv, 0.0);
  let cloudDepth = textureSampleLevel(currentCloudDepth, depthSampler, input.uv, 0.0);
  let currentValid = cloudDepth.a > 0.5;
  // currentRadiance is the scene-linear cloud composite. Remove the
  // unchanged scene background before writing history so the persistent owner
  // stores raw cloud radiance only. The view pass is the sole temporal blend
  // owner; blending here as well would accumulate history twice per frame.
  let currentCloudRadiance = max(current.rgb - background.rgb * current.a, vec3<f32>(0.0));
  let currentTransmittance = vec4<f32>(current.a, current.a, current.a, 1.0);
  var output: CloudHistoryOutput;
  output.radiance = vec4<f32>(currentCloudRadiance, select(0.0, 1.0, currentValid));
  output.transmittance = currentTransmittance;
  return output;
}
`;

/** Full-resolution resolve for the half-resolution transport MRT. */
export const CLOUD_RESOLVE_FULLSCREEN_WGSL = /* wgsl */ `
struct CloudCameraView {
  worldViewProj: mat4x4<f32>,
  lightDir: vec3<f32>,
  lightColor: vec3<f32>,
  cameraPos: vec3<f32>,
  lightViewProj_A: mat4x4<f32>,
  inverseViewProj: mat4x4<f32>,
  lightViewProj_B: mat4x4<f32>,
  lightViewProj_C: mat4x4<f32>,
  lightViewProj_D: mat4x4<f32>,
  splitPlanes: array<vec4<f32>, 4>,
  cascadeCount: f32,
  cascadeBlend: f32,
  depthBias: f32,
  normalBias: f32,
  directionalShadowFilter: vec4<f32>,
  spotLightViewProj: array<mat4x4<f32>, 4>,
  temporalCurrentViewProj: mat4x4<f32>,
  temporalPreviousViewProj: mat4x4<f32>,
  temporalProjection: vec4<f32>,
  temporalPreviousCameraPos: vec4<f32>,
  ssrParams: vec4<f32>,
};

struct CloudResolveParams {
  layer: vec4<f32>,
  field: vec4<f32>,
  wind: vec4<f32>,
  sunDirection: vec4<f32>,
  sunRadiance: vec4<f32>,
  integration: vec4<u32>,
  shadowOrigin: vec4<f32>,
  shadowRight: vec4<f32>,
  shadowUp: vec4<f32>,
  shadowProjection: vec4<f32>,
  temporal: vec4<f32>,
};

@group(0) @binding(0) var<uniform> view: CloudCameraView;
@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@group(1) @binding(2) var<uniform> cloud: CloudResolveParams;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var currentRadiance: texture_2d<f32>;
@group(1) @binding(6) var currentTransmittance: texture_2d<f32>;
@group(1) @binding(7) var currentDepth: texture_2d<f32>;
@group(1) @binding(8) var previousRadiance: texture_2d<f32>;
@group(1) @binding(9) var previousTransmittance: texture_2d<f32>;
@group(1) @binding(10) var previousDepth: texture_2d<f32>;

struct CloudResolveInput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

fn reconstruct_world(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = view.inverseViewProj * ndc;
  return world.xyz / max(abs(world.w), 1e-30);
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> CloudResolveInput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var output: CloudResolveInput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  output.uv = vec2<f32>(
    positions[index].x * 0.5 + 0.5,
    1.0 - (positions[index].y * 0.5 + 0.5),
  );
  return output;
}

@fragment
fn fs_main(input: CloudResolveInput) -> @location(0) vec4<f32> {
  let scene = textureSampleLevel(sceneColor, sceneSampler, input.uv, 0.0);
  // The resolve owns the full-resolution foreground test. Reject the current
  // low-resolution transport before any history or radiance is composited;
  // gating history alone still lets a newly sampled cloud bleed over geometry.
  let sceneDepthValue = textureLoad(sceneDepth, vec2<i32>(input.position.xy), 0);
  let sceneWorld = reconstruct_world(input.uv, clamp(sceneDepthValue, 0.0, 1.0));
  let sceneDistance = length(sceneWorld - view.cameraPos);
  let transport = textureSampleLevel(currentRadiance, sceneSampler, input.uv, 0.0);
  let transportT = textureSampleLevel(currentTransmittance, sceneSampler, input.uv, 0.0);
  // The transport depth is an rgba16float color attachment, not the scene's
  // depth texture. Sample it with the filtering color sampler; binding the
  // non-filtering scene-depth sampler here makes the shader contract depend on
  // an incompatible sampler/texture pair on strict WebGPU implementations.
  // Transport positions are stored in km to retain finite half-float values
  // at landscape and atmospheric camera distances. Consumers use World meters.
  let encodedDepth = textureSampleLevel(currentDepth, sceneSampler, input.uv, 0.0);
  let cloudDepth = vec4<f32>(encodedDepth.xyz * 1000.0, encodedDepth.a);
  let currentValid = transport.a > 0.5 && cloudDepth.a > 0.5;
  let cloudDistance = length(cloudDepth.xyz - view.cameraPos);
  let foregroundAccepted = sceneDepthValue <= 0.0 ||
    cloudDistance <= sceneDistance + max(0.05, sceneDistance * 0.01);
  if (!currentValid || !foregroundAccepted) { return scene; }

  let previousCloudWorld = cloudDepth.xyz +
    cloud.wind.xyz * max(0.0, cloud.field.y - cloud.temporal.w);
  let previousClip = view.temporalPreviousViewProj * vec4<f32>(previousCloudWorld, 1.0);
  let previousNdc = previousClip.xyz / max(abs(previousClip.w), 0.00001);
  let previousUv = vec2<f32>(
    previousNdc.x * 0.5 + 0.5,
    1.0 - (previousNdc.y * 0.5 + 0.5),
  );
  let inBounds = all(previousUv >= vec2<f32>(0.0)) && all(previousUv <= vec2<f32>(1.0));
  let historyUv = clamp(previousUv, vec2<f32>(0.0), vec2<f32>(1.0));
  let encodedHistoryDepth = textureSampleLevel(previousDepth, sceneSampler, historyUv, 0.0);
  let historyDepth = vec4<f32>(encodedHistoryDepth.xyz * 1000.0, encodedHistoryDepth.a);
  let previous = textureSampleLevel(previousRadiance, sceneSampler, historyUv, 0.0);
  let previousTransport = textureSampleLevel(previousTransmittance, sceneSampler, historyUv, 0.0);
  let dims = vec2<f32>(textureDimensions(previousRadiance));
  let texel = 1.0 / max(dims, vec2<f32>(1.0));
  // Clamp reprojected history against the current low-resolution transport
  // neighborhood. Using only previous-frame neighbors (and including the
  // previous center in both extrema) is a no-op and lets stale bright cloud
  // pixels leak across a newly exposed edge.
  let c0 = transport.rgb;
  let c1 = textureSampleLevel(currentRadiance, sceneSampler, clamp(input.uv + vec2<f32>(-texel.x, 0.0), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let c2 = textureSampleLevel(currentRadiance, sceneSampler, clamp(input.uv + vec2<f32>(texel.x, 0.0), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let c3 = textureSampleLevel(currentRadiance, sceneSampler, clamp(input.uv + vec2<f32>(0.0, -texel.y), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let c4 = textureSampleLevel(currentRadiance, sceneSampler, clamp(input.uv + vec2<f32>(0.0, texel.y), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).rgb;
  let minRadiance = min(c0, min(min(c1, c2), min(c3, c4)));
  let maxRadiance = max(c0, max(max(c1, c2), max(c3, c4)));
  let t1 = textureSampleLevel(currentTransmittance, sceneSampler, clamp(input.uv + vec2<f32>(-texel.x, 0.0), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;
  let t2 = textureSampleLevel(currentTransmittance, sceneSampler, clamp(input.uv + vec2<f32>(texel.x, 0.0), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;
  let t3 = textureSampleLevel(currentTransmittance, sceneSampler, clamp(input.uv + vec2<f32>(0.0, -texel.y), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;
  let t4 = textureSampleLevel(currentTransmittance, sceneSampler, clamp(input.uv + vec2<f32>(0.0, texel.y), vec2<f32>(0.0), vec2<f32>(1.0)), 0.0).r;
  let minTransport = min(transportT.r, min(min(t1, t2), min(t3, t4)));
  let maxTransport = max(transportT.r, max(max(t1, t2), max(t3, t4)));
  // The sampled history belongs to the advected previous-frame point used
  // for the UV above. Comparing it with the current point rejects matching
  // windy history and can instead accept a different, unadvected cloud.
  let worldTolerance = max(0.05, distance(previousCloudWorld, view.cameraPos) * 0.02);
  let depthAccepted = historyDepth.a > 0.5 && distance(historyDepth.xyz, previousCloudWorld) <= worldTolerance;
  let accepted = cloud.temporal.x > 0.5 && cloud.temporal.y < 0.5 && inBounds && depthAccepted;
  let historyWeight = select(0.0, clamp(cloud.temporal.z, 0.0, 0.92), accepted);
  let stableHistory = clamp(previous.rgb, minRadiance, maxRadiance);
  let stableTransport = clamp(previousTransport.r, minTransport, maxTransport);
  let radiance = mix(transport.rgb, stableHistory, historyWeight);
  let transmittance = mix(transportT.r, stableTransport, historyWeight);
  // Cloud transmittance belongs to its history texture, not canvas coverage.
  return vec4<f32>(scene.rgb * transmittance + radiance, scene.a);
}
`;
