import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../../index.js';
import { composeSurfaceSource } from '../compose.js';
import { cookMaterialAsset, generateParameterModule } from '../cook.js';
import { generateMaterialDynamicInputAccessor } from '../dynamic-input.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const template = `#define_import_path forgeax::single-layer-medium-test
#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface}
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}
@vertex
fn vs_main() -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}
@fragment
fn fs_main() -> @location(0) vec4<f32> {
  let input = SingleLayerMediumSurfaceInput(
    vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0), vec4<f32>(1.0),
    vec3<f32>(0.0, 0.0, 1.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0),
    vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0),
    vec4<f32>(1.0), true, 0.0, 0u, 0u, 0u);
  let surface = evaluate_surface(input);
  return vec4<f32>(surface.normalWS, surface.coverage);
}`;

const mediumAbi = `#define_import_path forgeax_material::single_layer_medium_surface_v1
struct SingleLayerMediumSurfaceInput {
  positionOS : vec3<f32>, positionWS : vec3<f32>, geometricNormalWS : vec3<f32>,
  tangentWS : vec4<f32>, viewDirectionWS : vec3<f32>, uv0 : vec2<f32>, uv1 : vec2<f32>,
  uv2 : vec2<f32>, uv3 : vec2<f32>, uv4 : vec2<f32>, uv5 : vec2<f32>, uv6 : vec2<f32>,
  uv7 : vec2<f32>, vertexColor : vec4<f32>, frontFacing : bool, frameTime : f32,
  instanceIndex : u32, eventRangeStart : u32, eventRangeCount : u32,
}
struct SingleLayerMediumSurfaceData {
  normalWS : vec3<f32>, roughness : f32, coverage : f32, foam : f32,
  absorption : vec3<f32>, scattering : vec3<f32>, ior : f32, phaseG : f32,
  maxDistanceMeters : f32,
}`;

const surface = `#define_import_path game::water_surface_a
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}
fn evaluate_surface(input : SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  let event = read_waterEvents(input.eventRangeStart);
  return SingleLayerMediumSurfaceData(normalize(input.geometricNormalWS), 0.25, 1.0, event.time, vec3<f32>(0.2), vec3<f32>(0.1), 1.333, 0.1, 900.0);
}`;

const dynamicInput = {
  name: 'waterEvents',
  fields: [
    { name: 'position', type: 'vec3<f32>' as const },
    { name: 'time', type: 'f32' as const },
    { name: 'eventId', type: 'u32' as const },
  ],
  maxRecords: 4,
  maxDomains: 2,
  maxPageBytes: 128,
  maxBindings: 1,
  maxEventsPerSample: 8,
};

const mediumParameters = [
  { name: 'coverage', type: 'f32' as const },
  { name: 'absorption', type: 'vec3' as const },
] as const;

describe('single-layer medium Surface composition', () => {
  it('validates the model ABI, inlines the generated accessor, and reflects WGSL', async () => {
    const catalogResult = buildMaterialSourceCatalog({
      engine: [
        { path: 'medium-template.wgsl', source: template },
        { path: 'medium-abi.wgsl', source: mediumAbi },
      ],
      project: [{ path: 'water-surface-a.wgsl', source: surface }],
    });
    expect(catalogResult.ok).toBe(true);
    if (!catalogResult.ok) return;
    const layout = (await import('@forgeax/engine-types')).deriveMaterialDynamicInputLayout(
      dynamicInput,
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    const composed = composeSurfaceSource({
      material: 'water-a',
      pass: 'color',
      templateModule: 'forgeax::single-layer-medium-test',
      surfaceModule: 'game::water_surface_a',
      surfaceModel: 'single-layer-medium',
      dynamicInput: layout.value,
      generatedParameters: generateParameterModule(mediumParameters),
      sources: catalogResult.value,
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.value.source).toContain(generateMaterialDynamicInputAccessor(layout.value));
    expect(composed.value.source).toContain(
      'fn evaluate_surface(input : SingleLayerMediumSurfaceInput)',
    );
    expect(composed.value.source).toContain('words : array<u32, 8>');
    expect(composed.value.source).toContain('bitcast<f32>(raw.words[0])');
    expect(composed.value.source).toContain('raw.words[4]');
    expect(composed.value.source).toContain('@group(3) @binding(3)');
    const compiled = await compileShader(composed.value.source, {
      id: 'water-a::color',
      renderEntries: { vertex: 'vs_main', fragment: 'fs_main' },
      imports: composed.value.imports,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(
      compiled.value.reflection.boundGlobals.some(
        (binding) => binding.group === 3 && binding.binding === 3,
      ),
    ).toBe(true);
  });

  it('cooks the Engine medium template with a custom Surface and scene-index receipt', async () => {
    const shaderRoot = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
    const engineSources = (
      await Promise.all(
        (
          await readdir(shaderRoot)
        )
          .filter((name) => name.endsWith('.wgsl'))
          .map(async (name) => ({
            path: name,
            source: await readFile(resolve(shaderRoot, name), 'utf8'),
          })),
      )
    ).filter(({ source }) => source.includes('#define_import_path'));
    const cookSurface = `#define_import_path game::water_surface_cook
#import forgeax_material::parameters::{material}
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}
fn evaluate_surface(input : SingleLayerMediumSurfaceInput) -> SingleLayerMediumSurfaceData {
  let event = read_waterEvents(input.eventRangeStart);
  return SingleLayerMediumSurfaceData(normalize(input.geometricNormalWS), 0.25, material.coverage, event.time, material.absorption, vec3<f32>(0.1), 1.333, 0.1, 900.0);
}`;
    const catalog = buildMaterialSourceCatalog({
      engine: engineSources,
      project: [{ path: 'water-surface-cook.wgsl', source: cookSurface }],
    });
    expect(catalog.ok, catalog.ok ? '' : catalog.error.message).toBe(true);
    if (!catalog.ok) return;
    const mediumLayout = (await import('@forgeax/engine-types')).deriveMaterialDynamicInputLayout(
      dynamicInput,
    );
    if (!mediumLayout.ok) return;
    const mediumComposed = composeSurfaceSource({
      material: 'water-cook',
      pass: 'Forward',
      templateModule: 'forgeax::single-layer-medium',
      surfaceModule: 'game::water_surface_cook',
      surfaceModel: 'single-layer-medium',
      dynamicInput: mediumLayout.value,
      generatedParameters: generateParameterModule(mediumParameters),
      sources: catalog.value,
    });
    if (!mediumComposed.ok) return;
    const compiled = await compileShader(mediumComposed.value.source, {
      id: 'single-layer-medium-cook',
      renderEntries: { vertex: 'vs_main', fragment: 'fs_main' },
      imports: mediumComposed.value.imports,
      defines: { STORAGE_BUFFER_AVAILABLE: true },
    });
    expect(compiled.ok, compiled.ok ? '' : compiled.error.message).toBe(true);
    for (const fragment of ['fs_nearest_layer', 'fs_color'] as const) {
      const laneCompiled = await compileShader(mediumComposed.value.source, {
        id: `single-layer-medium-cook-${fragment}`,
        renderEntries: { vertex: 'vs_main', fragment },
        imports: mediumComposed.value.imports,
        defines: { STORAGE_BUFFER_AVAILABLE: true },
      });
      expect(laneCompiled.ok, laneCompiled.ok ? '' : laneCompiled.error.message).toBe(true);
    }
    const sceneComposed = composeSurfaceSource({
      material: 'water-cook',
      pass: 'Forward',
      templateModule: 'forgeax::single-layer-medium',
      surfaceModule: 'game::water_surface_cook',
      surfaceModel: 'single-layer-medium',
      dynamicInput: mediumLayout.value,
      generatedParameters: generateParameterModule(mediumParameters, {
        sceneIndex: true,
        sceneIndexDeclarations: false,
        sceneMaterialPrivate: true,
      }),
      sources: catalog.value,
    }).unwrap();
    const sceneIndexCompiled = await compileShader(sceneComposed.source, {
      id: 'single-layer-medium-cook-scene-index',
      renderEntries: { vertex: 'vs_scene_index', fragment: 'fs_color' },
      imports: sceneComposed.imports,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
      },
    });
    expect(
      sceneIndexCompiled.ok,
      sceneIndexCompiled.ok ? '' : sceneIndexCompiled.error.message,
    ).toBe(true);
    const clusteredSceneIndexCompiled = await compileShader(sceneComposed.source, {
      id: 'single-layer-medium-cook-clustered-scene-index',
      renderEntries: { vertex: 'vs_scene_index', fragment: 'fs_color' },
      imports: sceneComposed.imports,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: true,
        CLUSTER_FORWARD_AVAILABLE: true,
      },
    });
    expect(
      clusteredSceneIndexCompiled.ok,
      clusteredSceneIndexCompiled.ok ? '' : clusteredSceneIndexCompiled.error.message,
    ).toBe(true);
    const probeCompiled = await compileShader(mediumComposed.value.source, {
      id: 'single-layer-medium-cook-probe',
      renderEntries: { vertex: 'vs_main', fragment: 'fs_color' },
      imports: mediumComposed.value.imports,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        PROBE_BLEND_AVAILABLE: true,
      },
    });
    expect(probeCompiled.ok, probeCompiled.ok ? '' : probeCompiled.error.message).toBe(true);
    const cooked = await cookMaterialAsset({
      material: 'water-cook',
      table: {
        'water-cook': {
          kind: 'material',
          parameters: mediumParameters,
          values: { coverage: 0.85, absorption: [0.22, 0.07, 0.025] },
          surface: {
            model: 'single-layer-medium',
            module: 'game::water_surface_cook',
            dynamicInput,
          },
          passes: [{ name: 'Forward', program: { module: 'forgeax::single-layer-medium' } }],
        },
      },
      sources: catalog.value,
    });
    expect(cooked.ok, cooked.ok ? '' : cooked.error.message).toBe(true);
    if (!cooked.ok) return;
    const pass = cooked.value.passes[0];
    expect(pass?.sceneCompile).toBeDefined();
    expect(pass?.compile.wgsl).toContain('probeBlendRecords');
    expect(pass?.compile.wgsl).toContain('sampleMediumDiffuse');
    expect(pass?.sceneCompile?.wgsl).toContain('probeBlendRecords');
    expect(pass?.sceneCompile?.wgsl).toContain('sampleMediumDiffuse');
    expect(pass?.sceneCompile?.wgsl).toContain('material.coverage =');
    expect(pass?.sceneCompile?.wgsl).toMatch(
      /sceneMaterials\[\(input(?:_\d+)?\.materialIndex \/ 2u\)\]\.payload\[0\]\.x/,
    );
    expect(pass?.sceneCompile?.wgsl).toContain('material.absorption =');
    expect(pass?.sceneCompile?.wgsl).toMatch(
      /sceneMaterials\[\(input(?:_\d+)?\.materialIndex \/ 2u\)\]\.payload\[1\]/,
    );
    expect(pass?.abi).toMatchObject({
      materialRow: { byteLength: 32, addressUnitBytes: 16 },
      sceneIndexEntry: 'vs_scene_index',
      surface: {
        model: 'single-layer-medium',
        passes: ['nearest-layer', 'color'],
        dynamicInput: { group: 3, binding: 3, readOnly: true },
      },
    });
    expect(
      pass?.sceneCompile?.reflection.boundGlobals.find(
        (global) => global.name === 'sceneMaterials',
      ),
    ).toMatchObject({
      elementStride: 32,
      span: 32,
    });
  });
});
