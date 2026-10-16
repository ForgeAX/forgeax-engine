#define_import_path preview::water_surface_b
#import forgeax_material::parameters::{material}
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}

fn evaluate_surface(input : SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  var eventPhase = 0.0;
  var eventFoam = 0.0;
  let eventCount = min(input.eventRangeCount, 8u);
  for (var eventOffset = 0u; eventOffset < eventCount; eventOffset += 1u) {
    let event = read_waterEvents(input.eventRangeStart + eventOffset);
    let age = input.frameTime - event.time;
    let lifetime = select(0.0, 1.0 - age / 3.2, age >= 0.0 && age <= 3.2);
    let radial = clamp(1.0 - distance(input.positionWS, event.position) / 1.35, 0.0, 1.0);
    let influence = lifetime * radial;
    eventPhase += influence * (event.time * 1.7 + dot(event.position.xy, vec2<f32>(-0.09, 0.21)));
    eventFoam += influence;
  }
  eventFoam = clamp(eventFoam, 0.0, 1.0);
  let phase = input.frameTime * 1.35 + f32(input.instanceIndex) * 0.31 + eventPhase;
  let normal = normalize(
    input.geometricNormalWS + vec3<f32>(
      cos(phase * 0.61) * material.waveAmplitude.x,
      sin(phase) * material.waveAmplitude.y,
      0.0,
    ),
  );
  return SingleLayerMediumSurfaceData(
    normal,
    material.roughness,
    material.coverage,
    material.foamBase + eventFoam * material.foamScale,
    material.absorption,
    material.scattering,
    material.ior,
    material.phaseG,
    material.maxDistanceMeters,
  );
}
