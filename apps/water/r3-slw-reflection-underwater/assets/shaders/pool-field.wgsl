#define_import_path water_pool::field
#import forgeax_material::parameters::{material}
#import forgeax_water::caustics::heightfield::{waterHeight, waterNormal}
#import water_pool::common::{AIR, WATER, FIELD_SCALE, boxInterval}
#import forgeax_water::caustics::concentration::{waterCausticsConcentration}
#import forgeax_optics::interface::{refractInterface, opticalMappedArea}

struct Projection { source: vec3<f32>, receiver: vec3<f32>, valid: bool };
struct Output { @builtin(position) position: vec4<f32>, @location(0) @interpolate(flat) energy: f32 };

fn project(xz: vec2<f32>, flat: vec3<f32>) -> Projection {
  let source = vec3<f32>(xz.x, waterHeight(xz), xz.y);
  let ray = refractInterface(-normalize(material.lightDirection), waterNormal(xz), AIR, WATER);
  let interval = boxInterval(source, ray.direction);
  let hit = source + ray.direction * interval.y;
  // The receiver is the actual box hit, unfolded along the reference ray.
  let projected = hit + flat * ((-1.0 - hit.y) / flat.y);
  return Projection(source, projected, ray.status == 0u && interval.y > 0.0);
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> Output {
  let GRID = material.sourceGrid;
  let step = 2.0 / f32(GRID);
  let cell = index / 6u;
  let corner = index % 6u;
  let base = vec2<f32>(f32(cell % GRID), f32(cell / GRID)) * step - 1.0;
  let offsets = array<vec2<f32>, 6>(vec2<f32>(0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0),
    vec2<f32>(0.0), vec2<f32>(1.0), vec2<f32>(0.0, 1.0));
  let start = corner / 3u * 3u;
  let incident = -normalize(material.lightDirection);
  let flat = refractInterface(incident, vec3<f32>(0.0, 1.0, 0.0), AIR, WATER).direction;
  let a = project(base + offsets[start] * step, flat);
  let b = project(base + offsets[start + 1u] * step, flat);
  let c = project(base + offsets[start + 2u] * step, flat);
  let area = opticalMappedArea(b.receiver - a.receiver, c.receiver - a.receiver,
    mat2x2<f32>(vec2<f32>(step * step, 0.0), vec2<f32>(0.0, step * step)));
  let incoming = abs(dot(cross(b.source - a.source, c.source - a.source), incident));
  let energy = waterCausticsConcentration(incoming, area.receiverAreaSqM, step * step * abs(incident.y), step * step, step * step / 12.0, 12.0);
  var selected = a;
  if (corner % 3u == 1u) { selected = b; }
  if (corner % 3u == 2u) { selected = c; }
  let xy = FIELD_SCALE * (selected.receiver.xz + flat.xz / flat.y);
  let valid = a.valid && b.valid && c.valid && energy.status == 0u && material.lightDirection.y > 0.0;
  return Output(vec4<f32>(xy.x, -xy.y, 0.0, 1.0), select(0.0, energy.value, valid));
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  return vec4<f32>(vec3<f32>(input.energy), 1.0);
}
