import type { MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { composeSurfaceSource } from '../compose.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';
import { validateSurfaceSource } from '../surface-contract.js';

const template = `#define_import_path forgeax_material::standard
#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface}
#import forgeax_material::parameters::{material}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let input = SurfaceInput(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 0.0, 1.0), vec4<f32>(1.0), vec3<f32>(0.0, 0.0, 1.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec4<f32>(1.0), true, vec4<f32>(0.0), vec4<f32>(0.0), mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0)), 0.0);
  let surface = evaluate_surface(input);
  return vec4<f32>(surface.baseColor, surface.opacity);
}`;

const defaultSurface = `#define_import_path forgeax_material::default_standard_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(1.0), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`;

const customSurface = `#define_import_path game::rusted_surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import game::noise::{fbm3}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  let rust = fbm3(input.positionWS);
  return SurfaceData(vec3<f32>(rust), input.vertexNormalWS, 0.2, 0.8, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`;

const noise = `#define_import_path game::noise
fn fbm3(value: vec3<f32>) -> f32 { return value.x + value.y + value.z; }`;

const material: MaterialAsset = {
  kind: 'material',
  passes: [
    {
      name: 'Forward',
      program: {
        module: 'forgeax_material::standard',
        moduleSlots: { surface: 'game::rusted_surface' },
      },
    },
  ],
  parameters: [],
};

function catalog() {
  const result = buildMaterialSourceCatalog({
    engine: [
      { path: 'standard.wgsl', source: template },
      {
        path: 'surface_v1.wgsl',
        source: `#define_import_path forgeax_material::surface_v1
struct SurfaceInput {
  positionOS: vec3<f32>, positionWS: vec3<f32>, geometricNormalWS: vec3<f32>, vertexNormalWS: vec3<f32>,
  tangentWS: vec4<f32>, viewDirectionWS: vec3<f32>, uv0: vec2<f32>, uv1: vec2<f32>,
  uv2: vec2<f32>, uv3: vec2<f32>, uv4: vec2<f32>, uv5: vec2<f32>, uv6: vec2<f32>, uv7: vec2<f32>,
  vertexColor: vec4<f32>, frontFacing: bool, uvFootprint0: vec4<f32>, uvFootprint1: vec4<f32>, frameTime: f32,
}
struct SurfaceData {
  baseColor: vec3<f32>, normalWS: vec3<f32>, metallic: f32, roughness: f32,
  emissive: vec3<f32>, occlusion: f32, opacity: f32, alphaClipThreshold: f32,
}`,
      },
      { path: 'default.wgsl', source: defaultSurface },
    ],
    project: [
      { path: 'rusted-surface.wgsl', source: customSurface },
      { path: 'noise.wgsl', source: noise },
    ],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('Surface composition and identity contract', () => {
  it('resolves one slot and includes transitive source closure for custom Surface', () => {
    const result = composeSurfaceSource({
      material: 'rusted-iron',
      pass: 'Forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources: catalog(),
      generatedParameters: '#define_import_path forgeax_material::parameters\n',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.surfaceModule).toBe('game::rusted_surface');
    expect(result.value.source).toContain('fbm3');
    expect(result.value.sourceClosure).toEqual([
      'forgeax_material::parameters',
      'forgeax_material::standard',
      'forgeax_material::surface_v1',
      'game::noise',
      'game::rusted_surface',
    ]);
    expect(result.value.stages).toEqual([
      'slot-resolution',
      'source-closure',
      'surface-validation',
      'parameter-generation',
    ]);
    expect(result.value.sourceClosureDigest).toMatch(/^sha256:/);
  });

  it('rejects a Surface that owns an entry point or resource binding', () => {
    const invalid = `${customSurface}\n@fragment fn invalid() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n@group(1) @binding(0) var bad: sampler;`;
    const result = validateSurfaceSource({
      material: 'rusted-iron',
      pass: 'Forward',
      source: invalid,
      sourcePath: 'rusted-surface.wgsl',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('material-surface-forbidden-interface');
  });

  it('keeps the Surface validator focused on the author export boundary', () => {
    const legacy = `${customSurface}\n// Physical layer fields belong to the root Standard contract, not SurfaceData.`;
    const result = validateSurfaceSource({
      material: 'rusted-iron',
      pass: 'Forward',
      source: legacy,
      sourcePath: 'rusted-surface.wgsl',
    });
    expect(result.ok).toBe(true);
  });

  it('keeps default and custom Surface on the same slot and closure path', () => {
    const sources = catalog();
    const defaultResult = composeSurfaceSource({
      material: 'standard',
      pass: 'Forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'forgeax_material::default_standard_surface',
      sources,
      generatedParameters: '#define_import_path forgeax_material::parameters\n',
    });
    const customResult = composeSurfaceSource({
      material: material.kind,
      pass: 'Forward',
      templateModule: 'forgeax_material::standard',
      surfaceModule: 'game::rusted_surface',
      sources,
      generatedParameters: '#define_import_path forgeax_material::parameters\n',
    });
    expect(defaultResult.ok).toBe(true);
    expect(customResult.ok).toBe(true);
    if (!defaultResult.ok || !customResult.ok) return;
    expect(defaultResult.value.surfaceModule).toBe('forgeax_material::default_standard_surface');
    expect(customResult.value.surfaceModule).toBe('game::rusted_surface');
    expect(defaultResult.value.source.match(/forgeax_material::slot::surface/g)).toBeNull();
    expect(customResult.value.source.match(/forgeax_material::slot::surface/g)).toBeNull();
  });
});
