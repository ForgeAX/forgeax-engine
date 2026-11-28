#define_import_path forgeax_water::caustics::gerstner_field
#import forgeax_material::water_waves::{sampleWaterGerstnerSurface, waterBodyPhaseAtWorldPosition, waterMaterialDrawData}
#import forgeax_water::caustics::concentration::{waterCausticsConcentration}
#import forgeax_optics::interface::{refractInterface, intersectOpticalPlane, opticalMappedArea}

// Stock finite-plane producer. The scene supplies the sun and reference plane.
struct Projection { source: vec3<f32>, receiver: vec3<f32>, valid: bool };
struct Output { @builtin(position) position: vec4<f32>, @location(0) concentration: f32 };
fn project(parameter: vec2<f32>) -> Projection {
  let body = waterMaterialDrawData.bodyIndex;
  let surface = sampleWaterGerstnerSurface(body, parameter,
    waterBodyPhaseAtWorldPosition(body, parameter), material.causticsNormalStencilM);
  let ray = refractInterface(normalize(material.causticsIncident), surface.geometricNormal, 1.0, 1.333);
  let hit = intersectOpticalPlane(surface.positionM, ray.direction, vec3<f32>(0.0, material.causticsPlaneY, 0.0),
    vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec2<f32>(material.causticsReceiverHalfExtentM), 0.00001);
  return Projection(surface.positionM, vec3<f32>(hit.coordinatesM.x, material.causticsPlaneY, hit.coordinatesM.y),
    surface.valid && ray.status == 0u && hit.status == 0u);
}
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Output {
  if (material.causticsMode < 1.5) {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return Output(vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0), 0.0);
  }
  let GRID = material.causticsGrid;
  let SPAN = material.causticsSourceSpanM;
  let STEP = SPAN / f32(GRID);
  let cell = index / 6u;
  let corner = index % 6u;
  let base = (vec2<f32>(f32(cell % GRID), f32(cell / GRID)) / f32(GRID) - 0.5) * SPAN;
  let offsets = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0),
    vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
  let triangle = (corner / 3u) * 3u;
  let a = project(base + offsets[triangle] * STEP);
  let b = project(base + offsets[triangle + 1u] * STEP);
  let c = project(base + offsets[triangle + 2u] * STEP);
  let metric = mat2x2<f32>(vec2<f32>(STEP * STEP, 0.0), vec2<f32>(0.0, STEP * STEP));
  let area = opticalMappedArea(b.receiver - a.receiver, c.receiver - a.receiver, metric);
  // A finite footprint regularizes folds; source triangles add into the same
  // receiver, preserving multiple branches rather than pretending to invert q.
  let incident = normalize(material.causticsIncident);
  let sourceProjectedArea = abs(dot(cross(b.source - a.source, c.source - a.source), incident));
  let concentration = waterCausticsConcentration(sourceProjectedArea,
    area.receiverAreaSqM, STEP * STEP * abs(incident.y), STEP * STEP, STEP * STEP / material.causticsMaximumConcentration, material.causticsMaximumConcentration);
  var selected = a;
  if (corner % 3u == 1u) { selected = b; }
  if (corner % 3u == 2u) { selected = c; }
  let valid = a.valid && b.valid && c.valid && area.status == 0u && concentration.status == 0u;
  let xy = selected.receiver.xz / material.causticsReceiverHalfExtentM;
  return Output(vec4<f32>(xy.x, -xy.y, 0.0, 1.0), select(0.0, concentration.value, valid));
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  if (material.causticsMode < 1.5) {
    return textureSample(causticsPattern, causticsPattern_sampler, input.position.xy / material.causticsFieldResolution);
  }
  return vec4<f32>(vec3<f32>(input.concentration * material.causticsLight), 1.0);
}
