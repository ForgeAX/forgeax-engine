import { expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook.js';
import { collectMaterialSources, materialShaderSourceRoots } from '../pack-cooker.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

it('cooks public optical imports with the certified shared Water frame instead of private bindings', async () => {
  const roots = materialShaderSourceRoots();
  const records = await collectMaterialSources(roots, roots);
  const sources = buildMaterialSourceCatalog({
    roots,
    engine: records.engine,
    project: [
      {
        path: 'probe/surface-field.wgsl',
        source: `#define_import_path probe::surface_field
#import forgeax_material::water_waves::{sampleWaterGerstnerSurface, waterBodyPhaseAtWorldPosition, waterMaterialDrawData}
#import forgeax_optics::interface::{refractInterface, intersectOpticalPlane, opticalMappedArea, opticalRelativeConcentration}
struct Output { @builtin(position) position: vec4<f32>, @location(0) value: f32 };
@vertex fn vs_main(@builtin(vertex_index) vertex: u32) -> Output {
  let uv = vec2<f32>(f32(vertex % 2u), f32(vertex / 2u));
  let body = waterMaterialDrawData.bodyIndex;
  let sample = sampleWaterGerstnerSurface(body, uv, waterBodyPhaseAtWorldPosition(body, uv), 0.01);
  let ray = refractInterface(vec3<f32>(0.0, -1.0, 0.0), sample.geometricNormal, 1.0, 1.333);
  let hit = intersectOpticalPlane(sample.positionM, ray.direction, vec3<f32>(0.0, -5.0, 0.0),
    vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec2<f32>(10.0), 0.00001);
  let metric = mat2x2<f32>(vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0));
  let area = opticalMappedArea(sample.tangentU, sample.tangentV, metric);
  let concentration = opticalRelativeConcentration(1.0, area.receiverAreaSqM, 1.0, 1.0);
  return Output(vec4<f32>(hit.coordinatesM * 0.1, 0.0, 1.0), concentration.value);
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
  return vec4<f32>(input.value, 0.0, 0.0, 1.0);
}`,
      },
    ],
  }).unwrap();
  const result = await cookMaterialAsset({
    material: 'field',
    sources,
    table: {
      field: {
        kind: 'material',
        parameters: [],
        passes: [
          {
            name: 'Forward',
            program: { module: 'probe::surface_field', bindings: 'render-material' },
          },
        ],
      },
    },
  });
  expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
  if (!result.ok) throw result.error;
  const forward = result.value.passes[0];
  expect(forward?.abi.systemInputs).toEqual({ water: 'water-frame/3' });
  const reads = forward?.compile.reflection.entryPoints?.find(
    (point) => point.stage === 'vertex',
  )?.bindings;
  expect(reads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ group: 2, binding: 16 }),
      expect.objectContaining({ group: 2, binding: 17 }),
      expect.objectContaining({ group: 2, binding: 21 }),
    ]),
  );
});
