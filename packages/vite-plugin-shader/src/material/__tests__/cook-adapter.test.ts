import { buildMaterialSourceCatalog, prepareStandardSource } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';

const template = `#define_import_path forgeax_material::test_standard
#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface}
#import forgeax_view::common::{View}
fn fs_main() -> vec4<f32> { return vec4<f32>(1.0); }`;

const surface = `#define_import_path forgeax_material::test_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(1.0), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`;

const surfaceV1 = `#define_import_path forgeax_material::surface_v1
struct SurfaceInput {
  positionOS: vec3<f32>, positionWS: vec3<f32>, geometricNormalWS: vec3<f32>, vertexNormalWS: vec3<f32>,
  tangentWS: vec4<f32>, viewDirectionWS: vec3<f32>, uv0: vec2<f32>, uv1: vec2<f32>,
  uv2: vec2<f32>, uv3: vec2<f32>, uv4: vec2<f32>, uv5: vec2<f32>, uv6: vec2<f32>, uv7: vec2<f32>,
  vertexColor: vec4<f32>, frontFacing: bool, uvFootprint0: vec4<f32>, uvFootprint1: vec4<f32>,
  frameTime: f32,
}
struct SurfaceData {
  baseColor: vec3<f32>, normalWS: vec3<f32>, metallic: f32, roughness: f32,
  emissive: vec3<f32>, occlusion: f32, opacity: f32, alphaClipThreshold: f32,
}`;

describe('Standard engine source adapter', () => {
  it('uses the engine catalog, generated parameters, and Surface closure', () => {
    const sourceCatalog = buildMaterialSourceCatalog({
      engine: [
        { path: 'template.wgsl', source: template },
        {
          path: 'forgeax_material::test_surface.wgsl',
          source: surface,
        },
        {
          path: 'forgeax_material::surface_v1.wgsl',
          source: surfaceV1,
        },
        {
          path: 'forgeax_material::slot::surface.wgsl',
          source: surface.replace(
            'forgeax_material::test_surface',
            'forgeax_material::slot::surface',
          ),
        },
        { path: 'forgeax_view::common.wgsl', source: '#define_import_path forgeax_view::common\n' },
      ],
      project: [],
    });
    expect(sourceCatalog.ok).toBe(true);
    if (!sourceCatalog.ok) return;
    const result = prepareStandardSource({
      material: 'forgeax::test-standard',
      templateModule: 'forgeax_material::test_standard',
      templatePath: 'template.wgsl',
      templateSource: template,
      surfaceModule: 'forgeax_material::test_surface',
      sourceRecords: sourceCatalog.value.entries(),
      generatedParameters:
        '#define_import_path forgeax_material::parameters\nstruct MaterialParameters { baseColor : vec4<f32>, }\n',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceClosure).toContain('forgeax_material::test_surface');
    expect(result.value.imports['forgeax_material::parameters']).toBeUndefined();
    expect(result.value.source).toContain('struct MaterialParameters');
    expect(result.value.sourceClosure).toEqual([
      'forgeax_material::parameters',
      'forgeax_material::surface_v1',
      'forgeax_material::test_standard',
      'forgeax_material::test_surface',
      'forgeax_view::common',
    ]);
    expect(result.value.sourceClosureDigest).toMatch(/^sha256:/);
  });

  it('rejects a missing Surface module before composition', () => {
    const sourceCatalog = buildMaterialSourceCatalog({
      engine: [
        { path: 'template.wgsl', source: template },
        {
          path: 'engine-parameters.wgsl',
          source: '#define_import_path forgeax_material::parameters\n',
        },
      ],
      project: [],
    });
    expect(sourceCatalog.ok).toBe(true);
    if (!sourceCatalog.ok) return;
    const result = prepareStandardSource({
      material: 'forgeax::test-standard',
      templateModule: 'forgeax_material::test_standard',
      templatePath: 'template.wgsl',
      templateSource: template,
      surfaceModule: 'forgeax_material::test_surface',
      sourceRecords: sourceCatalog.value.entries(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-surface-slot-missing');
  });
});
