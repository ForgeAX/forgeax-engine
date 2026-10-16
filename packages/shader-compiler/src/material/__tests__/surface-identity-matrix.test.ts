import { describe, expect, it } from 'vitest';
import { composeSurfaceSource } from '../compose.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';
import { createMaterialSpecializationKey } from '../specialization-key.js';

const template =
  '#define_import_path forgeax_material::standard\n#pragma material_slot surface\n#import forgeax_material::slot::surface::{evaluate_surface}';
const surface = (body: string) =>
  `#define_import_path game::surface\n#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}\nfn evaluate_surface(input: SurfaceInput) -> SurfaceData { ${body} }`;

function compose(
  source = surface(
    'return SurfaceData(vec3<f32>(1.0), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);',
  ),
) {
  const catalog = buildMaterialSourceCatalog({
    engine: [
      { path: 'standard.wgsl', source: template },
      {
        path: 'surface-v1.wgsl',
        source:
          '#define_import_path forgeax_material::surface_v1\nstruct SurfaceInput { positionOS: vec3<f32>, positionWS: vec3<f32>, geometricNormalWS: vec3<f32>, vertexNormalWS: vec3<f32>, tangentWS: vec4<f32>, viewDirectionWS: vec3<f32>, uv0: vec2<f32>, uv1: vec2<f32>, uv2: vec2<f32>, uv3: vec2<f32>, uv4: vec2<f32>, uv5: vec2<f32>, uv6: vec2<f32>, uv7: vec2<f32>, vertexColor: vec4<f32>, frontFacing: bool, uvFootprint0: vec4<f32>, uvFootprint1: vec4<f32>, frameTime: f32, }\nstruct SurfaceData { baseColor: vec3<f32>, normalWS: vec3<f32>, metallic: f32, roughness: f32, emissive: vec3<f32>, occlusion: f32, opacity: f32, alphaClipThreshold: f32, }',
      },
    ],
    project: [{ path: 'surface.wgsl', source }],
  });
  if (!catalog.ok) throw new Error(catalog.error.message);
  const result = composeSurfaceSource({
    material: 'material',
    pass: 'Forward',
    templateModule: 'forgeax_material::standard',
    surfaceModule: 'game::surface',
    sources: catalog.value,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function key(sourceClosureDigest: string, contractHash = 'contract-v1') {
  return createMaterialSpecializationKey({
    contractHash,
    passes: [
      {
        name: 'Forward',
        module: 'forgeax_material::standard',
        sourceClosure: { digest: sourceClosureDigest },
        moduleSlots: { surface: 'game::surface' },
      },
    ],
    vertexInputs: [],
    versions: { profile: 'webgpu/v1', adapter: 'generic', compiler: 'surface-v1' },
  }).digest;
}

describe('Surface identity mutation matrix', () => {
  it('invalidates program identity for source and contract changes', () => {
    const baseline = compose();
    const changedSource = compose(
      surface(
        'return SurfaceData(vec3<f32>(0.2), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);',
      ),
    );
    expect(key(changedSource.sourceClosureDigest)).not.toBe(key(baseline.sourceClosureDigest));
    expect(key(baseline.sourceClosureDigest, 'contract-v2')).not.toBe(
      key(baseline.sourceClosureDigest),
    );
  });

  it('keeps value-only mutations out of specialization identity', () => {
    const baseline = compose();
    expect(key(baseline.sourceClosureDigest)).toBe(key(baseline.sourceClosureDigest));
  });
});
