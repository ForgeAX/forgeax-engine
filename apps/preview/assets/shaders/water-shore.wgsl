#define_import_path preview::water_shore
#import forgeax_material::parameters::{material}
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}

fn evaluate_surface(input: SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  let p = input.positionWS.xz;
  let t = input.frameTime;
  var slope = vec2<f32>(
    cos(dot(p, vec2<f32>(1.7, 0.8)) - t * 1.1),
    sin(dot(p, vec2<f32>(-0.6, 2.1)) + t * 0.85),
  ) * material.waveAmplitude;
  slope += vec2<f32>(sin(p.y * 8.0 + t * 1.4), cos(p.x * 7.0 - t)) * 0.015;
  var foam = 0.0;
  for (var i = 0u; i < min(input.eventRangeCount, 8u); i += 1u) {
    let event = read_waterEvents(input.eventRangeStart + i);
    let age = t - event.time;
    if (age < 0.0 || age > 3.0) { continue; }
    let delta = p - event.position.xz;
    let radius = length(delta);
    let ring = radius - age * 1.5;
    let envelope = exp(-ring * ring * 5.0) * (1.0 - age / 3.0);
    slope += delta / max(radius, 0.01) * cos(ring * 13.0) * envelope * 0.22;
    foam += envelope * 0.22;
  }
  let normal = normalize(input.geometricNormalWS + vec3<f32>(slope.x, 0.0, slope.y));
  return SingleLayerMediumSurfaceData(normal, material.roughness, material.coverage,
    foam, material.absorption, material.scattering, material.ior, material.phaseG,
    material.maxDistanceMeters);
}
