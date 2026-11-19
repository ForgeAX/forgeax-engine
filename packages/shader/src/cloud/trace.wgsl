#define_import_path forgeax_cloud::trace
#import forgeax_cloud::geometry::{CLOUD_UNTRACED_DEPTH_METERS, cloud_shell_interval}
#import forgeax_cloud::coordinates::{cloud_height_fraction}
#import forgeax_cloud::medium::{CloudDensityPoint, CloudDensityControls, MediumSample, evaluate_uniform_medium, evaluate_reference_conservative, evaluate_reference_medium}
#import forgeax_cloud::lighting::{cloud_double_henyey_greenstein, cloud_optical_octaves, cloud_solar_light, cloud_sky_light}
#import forgeax_view::common::{AtmosphereMedium}
#import forgeax_cloud::shadow::{cloud_shadow_segment, cloud_shadow_ray_octave_tau, cloud_shadow_map_octave_tau, cloud_shadow_map_load, cloud_shadow_optical_depth}

struct CloudTraceLighting {
  directionToLight: vec3f,
  illuminance: vec3f,
  phase: vec4f,
  multipleScattering: vec4f,
  shadow: vec4f,
  enabled: bool,
  mapOrigin: vec4f,
  mapRight: vec4f,
  mapUp: vec4f,
  mapDirection: vec4f,
  mapSettings: vec4f,
  atmosphere: AtmosphereMedium,
  skyAmbient: vec4f,
  environment: vec4f,
  groundSolar: vec4f,
}

fn cloud_secondary_optical_depth(positionMeters: vec3f, planetPositionMeters: vec3f,
  cameraMeters: vec3f, directionToLight: vec3f, windMeters: vec3f,
  density: CloudDensityControls, pattern: texture_2d<f32>, mask: texture_2d<f32>,
  profile: texture_2d<f32>, body: texture_3d<f32>, wrapSampler: sampler,
  settings: CloudSampledTraceSettings, lighting: CloudTraceLighting) -> f32 {
  if lighting.shadow.x < 0.5 || lighting.shadow.z <= 0.0 { return 0.0; }
  let interval = cloud_shell_interval(planetPositionMeters, directionToLight,
    settings.planetRadiusMeters, settings.layer.x, settings.layer.y,
    settings.layer.z, lighting.shadow.z, true, 0.0, CLOUD_UNTRACED_DEPTH_METERS);
  if interval.x < 0.0 { return 0.0; }
  let count = u32(clamp(lighting.shadow.y, 1.0, 64.0));
  var tau = 0.0;
  for (var index = 0u; index < count; index += 1u) {
    let segment = cloud_shadow_segment(index, count, interval.y - interval.x);
    let offset = directionToLight * (interval.x + segment.x);
    let pointPosition = positionMeters + offset;
    let eyeRadial = length(planetPositionMeters);
    let radial = length(planetPositionMeters + offset);
    let distanceMeters = interval.x + segment.x;
    let altitude = eyeRadial - settings.planetRadiusMeters + distanceMeters *
      (distanceMeters + 2.0 * dot(planetPositionMeters, directionToLight)) / (radial + eyeRadial);
    let point = CloudDensityPoint(pointPosition, pointPosition - cameraMeters,
      cloud_height_fraction(altitude, settings.layer.x, settings.layer.y), windMeters);
    let c4 = evaluate_reference_conservative(point, density, pattern, mask, profile,
      body, wrapSampler, settings.useDetail);
    if c4.x > 0.0 {
      tau += evaluate_reference_medium(point, density, c4).extinctionPerMeter * segment.y;
    }
  }
  return tau;
}

struct CloudTraceResult {
  radiance: vec3f,
  transmittance: f32,
  entryMeters: f32,
  exitMeters: f32,
  sceneDepthMeters: f32,
  representativeDepthMeters: f32,
}

struct CloudSegmentTransfer {
  radiance: vec3f,
  transmittance: f32,
}

// Taylor expansion avoids losing low optical depths in 1 - exp(-x).
fn cloud_one_minus_beer(opticalDepth: f32, transmittance: f32) -> f32 {
  if opticalDepth < 0.125 {
    let x = opticalDepth;
    return x * (1.0 + x * (-0.5 + x * (1.0 / 6.0 + x * (-1.0 / 24.0 + x / 120.0))));
  }
  return 1.0 - transmittance;
}

// Incident scatterRadiance already includes the phase and light intensity.
fn cloud_segment_transfer(
  sample: MediumSample,
  scatterRadiance: vec3f,
  distanceMeters: f32,
) -> CloudSegmentTransfer {
  let opticalDepth = sample.extinctionPerMeter * distanceMeters;
  let transmittance = exp(-opticalDepth);
  let removed = cloud_one_minus_beer(opticalDepth, transmittance);
  var emissionLength = distanceMeters;
  if opticalDepth > 0.0 {
    emissionLength *= removed / opticalDepth;
  }
  return CloudSegmentTransfer(
    sample.albedo * scatterRadiance * removed + sample.emissivePerMeter * emissionLength,
    transmittance
  );
}

fn cloud_representative_depth(
  interval: vec2f,
  extinctionPerMeter: f32,
  transmittance: f32,
) -> f32 {
  if transmittance > 0.99 {
    return interval.y;
  }
  let lengthMeters = interval.y - interval.x;
  let x = extinctionPerMeter * lengthMeters;
  // Mean distance under exponentially attenuated uniform scattering weights.
  var fraction = 0.5 + x * (-1.0 / 12.0 + x * x / 720.0);
  if x >= 0.125 {
    fraction = 1.0 / x - transmittance / (1.0 - transmittance);
  }
  return interval.x + lengthMeters * fraction;
}

fn cloud_untraced(sceneDepthMeters: f32) -> CloudTraceResult {
  return CloudTraceResult(vec3f(0.0), 1.0, CLOUD_UNTRACED_DEPTH_METERS,
    CLOUD_UNTRACED_DEPTH_METERS, sceneDepthMeters, CLOUD_UNTRACED_DEPTH_METERS);
}

fn trace_uniform_cloud(
  cameraRelativeToPlanetMeters: vec3f,
  direction: vec3f,
  planetRadiusMeters: f32,
  bottomMeters: f32,
  thicknessMeters: f32,
  entryLimitMeters: f32,
  traceLimitMeters: f32,
  limitFromEntry: bool,
  sceneDistanceMeters: f32,
  sample: MediumSample,
  scatterRadiance: vec3f,
) -> CloudTraceResult {
  let interval = cloud_shell_interval(cameraRelativeToPlanetMeters, direction, planetRadiusMeters,
    bottomMeters, thicknessMeters, entryLimitMeters, traceLimitMeters, limitFromEntry, 0.0,
    sceneDistanceMeters);
  if interval.x < 0.0 {
    return cloud_untraced(sceneDistanceMeters);
  }
  let medium = evaluate_uniform_medium(sample, 0.5);
  let transfer = cloud_segment_transfer(medium, scatterRadiance, interval.y - interval.x);
  return CloudTraceResult(transfer.radiance, transfer.transmittance, interval.x, interval.y,
    sceneDistanceMeters, cloud_representative_depth(interval, medium.extinctionPerMeter,
    transfer.transmittance));
}

const CLOUD_SAMPLED_MAX_STEPS: u32 = 768u;

struct CloudSampledTraceSettings {
  layer: vec4f, // bottom, thickness, entry limit, trace limit (meters)
  planetRadiusMeters: f32,
  sceneDistanceMeters: f32,
  distanceToMaxSamplesMeters: f32,
  minSamples: u32,
  maxSamples: u32,
  loopCap: u32,
  limitFromEntry: bool,
  skipEmpty: bool,
  useDetail: bool,
  stopTransmittance: f32,
  samplePhase: f32,
}

struct CloudSampledTraceResult {
  trace: CloudTraceResult,
  near: CloudSegmentTransfer,
  nearRepresentativeDepthMeters: f32,
  conservative: vec4f,
  extinctionPerMeter: f32,
  witnessDistanceMeters: f32,
  counts: vec4u, // evaluated budget, traversed, full calls, occupied
  opticalDepth: f32,
}

fn trace_sampled_cloud_lit(
  cameraPositionMeters: vec3f,
  cameraRelativeToPlanetMeters: vec3f,
  direction: vec3f,
  windOffsetMeters: vec3f,
  density: CloudDensityControls,
  pattern: texture_2d<f32>,
  mask: texture_2d<f32>,
  profile: texture_2d<f32>,
  body: texture_3d<f32>,
  wrapSampler: sampler,
  scatterRadiance: vec3f,
  settings: CloudSampledTraceSettings,
  nearSceneDistanceMeters: f32,
  lighting: CloudTraceLighting,
  shadowMap: texture_2d<f32>,
  solarTransmittance: texture_2d<f32>,
  distantSky: texture_2d<f32>,
) -> CloudSampledTraceResult {
  let interval = cloud_shell_interval(cameraRelativeToPlanetMeters, direction, settings.planetRadiusMeters,
    settings.layer.x, settings.layer.y, settings.layer.z, settings.layer.w, settings.limitFromEntry,
    0.0, settings.sceneDistanceMeters);
  if interval.x < 0.0 {
    return CloudSampledTraceResult(cloud_untraced(settings.sceneDistanceMeters),
      CloudSegmentTransfer(vec3f(0.0), 1.0), CLOUD_UNTRACED_DEPTH_METERS,
      vec4f(0.0), 0.0, CLOUD_UNTRACED_DEPTH_METERS, vec4u(0u), 0.0);
  }

  let lengthMeters = interval.y - interval.x;
  var evaluated = 0u;
  if settings.minSamples > 0u && settings.maxSamples >= settings.minSamples &&
    settings.distanceToMaxSamplesMeters > 0.0 {
    let distanceFactor = clamp(lengthMeters / settings.distanceToMaxSamplesMeters, 0.0, 1.0);
    evaluated = u32(max(f32(settings.minSamples), f32(settings.maxSamples) * distanceFactor));
  }
  let count = min(evaluated, min(settings.loopCap, CLOUD_SAMPLED_MAX_STEPS));
  // Evaluate the step before the loop clamp, as in the shared view budget.
  let stepMeters = lengthMeters / f32(max(1u, evaluated));
  let eyeRadial = length(cameraRelativeToPlanetMeters);
  let eyeAltitude = eyeRadial - settings.planetRadiusMeters;
  let radialDirection = dot(cameraRelativeToPlanetMeters, direction);
  var conservative = vec4f(0.0);
  var extinctionPerMeter = 0.0;
  var witnessDistanceMeters = CLOUD_UNTRACED_DEPTH_METERS;
  var radiance = vec3f(0.0);
  var nearRadiance = vec3f(0.0);
  var nearTransmittance = 1.0;
  var transmittance = 1.0;
  var opticalDepth = 0.0;
  var weightSum = 0.0;
  var weightedDepth = 0.0;
  var nearWeightSum = 0.0;
  var nearWeightedDepth = 0.0;
  var fullCalls = 0u;
  var traversed = 0u;
  var occupied = 0u;
  let useBeerMap = lighting.mapSettings.x > 0.5;
  let basePhase = cloud_double_henyey_greenstein(lighting.phase.x, lighting.phase.y,
    lighting.phase.z, dot(direction, lighting.directionToLight));
  let skyLight = cloud_sky_light(lighting.skyAmbient, lighting.environment.y > 0.5,
    lighting.illuminance, distantSky);

  for (var index = 0u; index < count; index += 1u) {
    traversed += 1u;
    let t = interval.x + (f32(index) + settings.samplePhase) * stepMeters;
    let offsetMeters = direction * t;
    let radial = length(cameraRelativeToPlanetMeters + offsetMeters);
    // (r^2 - eye^2) / (r + eye) preserves submeter variation near planet scale.
    let altitude = eyeAltitude + t * (t + 2.0 * radialDirection) / (radial + eyeRadial);
    let point = CloudDensityPoint(cameraPositionMeters + offsetMeters, offsetMeters,
      cloud_height_fraction(altitude, settings.layer.x, settings.layer.y), windOffsetMeters);
    let sampleConservative = evaluate_reference_conservative(point, density, pattern, mask, profile,
      body, wrapSampler, settings.useDetail);
    let positive = sampleConservative.x > 0.0;
    // Prefer the first occupied midpoint; if there is none, keep the first midpoint.
    // This diagnostic point is identical regardless of whether skip is enabled.
    let chosen = index == 0u || (positive && occupied == 0u);
    if chosen {
      conservative = sampleConservative;
      witnessDistanceMeters = t;
    }
    if positive {
      occupied += 1u;
    }
    if settings.skipEmpty && !positive {
      continue;
    }
    fullCalls += 1u;
    let medium = evaluate_reference_medium(point, density, sampleConservative);
    if chosen {
      extinctionPerMeter = medium.extinctionPerMeter;
    }
    if medium.extinctionPerMeter > 0.0 {
      weightSum += transmittance;
      weightedDepth += t * transmittance;
      if t <= nearSceneDistanceMeters {
        nearWeightSum += transmittance;
        nearWeightedDepth += t * transmittance;
      }
    }
    var segment = cloud_segment_transfer(medium, scatterRadiance, stepMeters);
    // UE evaluates incident lighting only for a scattering medium. The initial
    // transfer above still integrates absorption and emission independently.
    if lighting.enabled && medium.extinctionPerMeter > 0.0 && any(medium.albedo > vec3f(0.0)) {
      var lightTau = 0.0;
      if lighting.shadow.x > 0.5 {
        if useBeerMap {
          let relative = cameraPositionMeters + offsetMeters - lighting.mapOrigin.xyz;
          let uv = vec2f(dot(relative, lighting.mapRight.xyz), dot(relative, lighting.mapUp.xyz)) /
            lighting.mapOrigin.w + 0.5;
          // UE's bilinear clamp extends the edge texels for cloud self-shadowing.
          // External receivers keep their own finite-coverage policy.
          lightTau = cloud_shadow_optical_depth(cloud_shadow_map_load(shadowMap, clamp(uv, vec2f(0.0), vec2f(1.0))),
            clamp(dot(relative, -lighting.mapDirection.xyz), 0.0, lighting.mapRight.w));
        } else {
          lightTau = cloud_secondary_optical_depth(cameraPositionMeters + offsetMeters,
            cameraRelativeToPlanetMeters + offsetMeters, cameraPositionMeters,
            lighting.directionToLight, windOffsetMeters, density, pattern, mask, profile,
            body, wrapSampler, settings, lighting);
        }
      }
      let octaves = cloud_optical_octaves(medium.extinctionPerMeter, medium.albedo,
        basePhase, lighting.multipleScattering.x, lighting.multipleScattering.y,
        lighting.multipleScattering.z, u32(lighting.multipleScattering.w), false, true);
      var source = vec3f(0.0);
      let solar = cloud_solar_light(lighting.atmosphere, cameraPositionMeters + offsetMeters,
        lighting.groundSolar.rgb, lighting.directionToLight, lighting.skyAmbient.w > 0.5,
        lighting.environment.x > 0.5, solarTransmittance, wrapSampler);
      let sky = skyLight * medium.materialAO;
      for (var octave = i32(lighting.multipleScattering.w); octave >= 0; octave -= 1) {
        let optical = octaves[u32(octave)];
        let tau = optical.extinctionPerMeter * stepMeters;
        let removed = cloud_one_minus_beer(tau, exp(-tau));
        var integral = stepMeters;
        if tau > 0.0 { integral *= removed / tau; }
        var octaveTau = cloud_shadow_ray_octave_tau(lightTau,
          lighting.multipleScattering.y, u32(octave));
        if useBeerMap {
          octaveTau = cloud_shadow_map_octave_tau(lightTau, lighting.multipleScattering.y, u32(octave));
        }
        let sunT = exp(-octaveTau);
        source += optical.scatteringPerMeter * lighting.illuminance * solar *
          (sunT * optical.phase * integral);
        if octave == 0 { source += (medium.emissivePerMeter + optical.scatteringPerMeter * sky) * integral; }
      }
      segment.radiance = source;
    }
    if t <= nearSceneDistanceMeters {
      nearRadiance += transmittance * segment.radiance;
    }
    if t < nearSceneDistanceMeters {
      nearTransmittance *= segment.transmittance;
    }
    radiance += transmittance * segment.radiance;
    transmittance *= segment.transmittance;
    opticalDepth += medium.extinctionPerMeter * stepMeters;
    if settings.stopTransmittance > 0.0 && transmittance < settings.stopTransmittance {
      break;
    }
  }
  var representative = interval.y;
  if transmittance <= 0.99 && weightSum > 0.0 {
    representative = weightedDepth / weightSum;
  }
  let publishedTransmittance = select(transmittance, 0.0,
    settings.stopTransmittance > 0.0 && transmittance < settings.stopTransmittance);
  let trace = CloudTraceResult(radiance, publishedTransmittance, interval.x, interval.y,
    settings.sceneDistanceMeters, representative);
  let nearRepresentative = select(min(interval.y, nearSceneDistanceMeters),
    nearWeightedDepth / max(nearWeightSum, 1e-20), nearWeightSum > 0.0);
  return CloudSampledTraceResult(trace, CloudSegmentTransfer(nearRadiance, nearTransmittance), nearRepresentative,
    conservative, extinctionPerMeter, witnessDistanceMeters,
    vec4u(evaluated, traversed, fullCalls, occupied), opticalDepth);
}

fn trace_sampled_cloud_near(
  cameraPositionMeters: vec3f,
  cameraRelativeToPlanetMeters: vec3f,
  direction: vec3f,
  windOffsetMeters: vec3f,
  density: CloudDensityControls,
  pattern: texture_2d<f32>,
  mask: texture_2d<f32>,
  profile: texture_2d<f32>,
  body: texture_3d<f32>,
  wrapSampler: sampler,
  scatterRadiance: vec3f,
  settings: CloudSampledTraceSettings,
  nearSceneDistanceMeters: f32,
) -> CloudSampledTraceResult {
  var atmosphere: AtmosphereMedium;
  let unlit = CloudTraceLighting(vec3f(0.0, 1.0, 0.0), vec3f(0.0), vec4f(0.0),
    vec4f(0.0), vec4f(0.0), false, vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0), atmosphere, vec4f(0.0), vec4f(0.0), vec4f(1.0));
  return trace_sampled_cloud_lit(cameraPositionMeters, cameraRelativeToPlanetMeters, direction,
    windOffsetMeters, density, pattern, mask, profile, body, wrapSampler, scatterRadiance,
    settings, nearSceneDistanceMeters, unlit, pattern, pattern, pattern);
}

fn trace_sampled_cloud(
  cameraPositionMeters: vec3f, cameraRelativeToPlanetMeters: vec3f, direction: vec3f,
  windOffsetMeters: vec3f, density: CloudDensityControls, pattern: texture_2d<f32>,
  mask: texture_2d<f32>, profile: texture_2d<f32>, body: texture_3d<f32>,
  wrapSampler: sampler, scatterRadiance: vec3f, settings: CloudSampledTraceSettings,
) -> CloudSampledTraceResult {
  return trace_sampled_cloud_near(cameraPositionMeters, cameraRelativeToPlanetMeters, direction,
    windOffsetMeters, density, pattern, mask, profile, body, wrapSampler, scatterRadiance,
    settings, settings.sceneDistanceMeters);
}
