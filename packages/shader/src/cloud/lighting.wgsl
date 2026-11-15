#define_import_path forgeax_cloud::lighting
#import forgeax_view::common::{AtmosphereMedium}
#import forgeax_atmosphere::optics::{atmosphere_position, atmosphere_solar_transmittance}

fn cloud_solar_light(medium: AtmosphereMedium, worldPosition: vec3f, groundTransmittance: vec3f,
  directionToLight: vec3f, atmosphereAvailable: bool, perSample: bool,
  transmittance: texture_2d<f32>, filtering: sampler) -> vec3f {
  if !atmosphereAvailable { return vec3f(1.0); }
  if !perSample { return groundTransmittance; }
  return atmosphere_solar_transmittance(medium, atmosphere_position(medium, worldPosition),
    directionToLight, transmittance, filtering);
}

fn cloud_sky_light(ambient: vec4f, enabled: bool, outerSun: vec3f,
  distantSky: texture_2d<f32>) -> vec3f {
  if !enabled { return vec3f(0.0); }
  if ambient.w > 0.5 { return textureLoad(distantSky, vec2i(0), 0).rgb * outerSun; }
  return ambient.rgb;
}

const CLOUD_ISOTROPIC_PHASE: f32 = 0.07957747154594767;

// Cosine between camera-to-sample and sample-to-light.
fn cloud_henyey_greenstein(anisotropy: f32, cosine: f32) -> f32 {
  let g = clamp(anisotropy, -0.999, 0.999);
  let magnitude = abs(g);
  let signedCosine = select(1.0, -1.0, g < 0.0) * clamp(cosine, -1.0, 1.0);
  let oneMinusG = 1.0 - magnitude;
  let denominator = oneMinusG * oneMinusG + 2.0 * magnitude * (1.0 - signedCosine);
  return CLOUD_ISOTROPIC_PHASE * oneMinusG * (1.0 + magnitude) /
    (denominator * sqrt(denominator));
}

fn cloud_double_henyey_greenstein(g: f32, g2: f32, blend: f32, cosine: f32) -> f32 {
  return mix(
    cloud_henyey_greenstein(g, cosine),
    cloud_henyey_greenstein(g2, cosine),
    clamp(blend, 0.0, 1.0)
  );
}

struct CloudOpticalOctave {
  scatteringPerMeter: vec3f,
  extinctionPerMeter: f32,
  phase: f32,
}

fn cloud_optical_octaves(
  extinctionPerMeter: f32,
  albedo: vec3f,
  basePhase: f32,
  contributionInput: f32,
  occlusionInput: f32,
  eccentricityInput: f32,
  extraOctaves: u32,
  grayScale: bool,
  clampContribution: bool,
) -> array<CloudOpticalOctave, 3> {
  let scattering = extinctionPerMeter * select(albedo, vec3f(albedo.r), grayScale);
  var octaves: array<CloudOpticalOctave, 3>;
  octaves[0] = CloudOpticalOctave(scattering, extinctionPerMeter, basePhase);
  var contribution = select(max(0.0, contributionInput), clamp(contributionInput, 0.0, 1.0), clampContribution);
  var occlusion = clamp(occlusionInput, 0.0, 1.0);
  var eccentricity = clamp(eccentricityInput, 0.0, 1.0);
  for (var octave = 1u; octave <= min(2u, extraOctaves); octave += 1u) {
    let previous = octaves[octave - 1u];
    octaves[octave] = CloudOpticalOctave(
      previous.scatteringPerMeter * contribution,
      previous.extinctionPerMeter * occlusion,
      mix(CLOUD_ISOTROPIC_PHASE, basePhase, eccentricity)
    );
    contribution *= contribution;
    occlusion *= occlusion;
    eccentricity *= eccentricity;
  }
  return octaves;
}
