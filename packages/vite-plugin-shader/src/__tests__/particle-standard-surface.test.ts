// @perf-budget-skip: intentional shader compiler composition integration gate.
import { readFile } from 'node:fs/promises';
import { STANDARD_PIPELINE_PARAM_SCHEMA } from '@forgeax/engine-shader';
import {
  compileShader,
  generateParameterModule,
  lowerStandardPhysicalBindings,
  prepareStandardSource,
} from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';

it('shares Standard surface evaluation without importing scene mesh or instance tables', async () => {
  const engine = await loadEngineShaderEntries();
  const compiled = await compileShader(
    `
#import forgeax_material::standard_surface::{VsOut, StandardSurfaceFactors, evaluateStandardSurface}
@vertex fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>(position, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  var input: VsOut;
  input.clip = position;
  input.worldNormal = vec3<f32>(0.0, 1.0, 0.0);
  input.worldTangent = vec4<f32>(1.0, 0.0, 0.0, 1.0);
  let factors = StandardSurfaceFactors(vec4<f32>(1.0), 0.0, 0.5, vec3<f32>(0.0), 1.0, 0.0, 0.1, true, true);
  return evaluateStandardSurface(input, factors).color;
}`,
    {
      id: 'particle-standard-surface',
      imports: engine.imports,
      defines: {
        STORAGE_BUFFER_AVAILABLE: true,
        PER_INSTANCE_REGION: false,
        CLUSTER_FORWARD_AVAILABLE: false,
        VERTEX_COLOR_AVAILABLE: false,
        PROBE_BLEND_AVAILABLE: false,
        EXTENDED_LIGHTING_AVAILABLE: false,
        TRANSMISSION_AVAILABLE: false,
        DIRECTIONAL_PCSS_AVAILABLE: false,
        PROJECTOR_AVAILABLE: false,
        REFLECTION_FALLBACK_AVAILABLE: false,
      },
    },
  );
  if (!compiled.ok) throw new Error(compiled.error.message);
  expect(compiled.value.wgsl).not.toMatch(/@group\(2\)|@group\(3\)/);
  expect(compiled.value.wgsl).toContain('evaluateStandardSurface');
  for (const name of ['mesh', 'mesh-inputs']) {
    const source = await readFile(
      new URL(`../../../vfx-render/src/shaders/${name}.wgsl`, import.meta.url),
      'utf8',
    );
    for (const clustered of [false, true]) {
      const adapter = await compileShader(source, {
        id: name,
        imports: engine.imports,
        defines: {
          STORAGE_BUFFER_AVAILABLE: true,
          PER_INSTANCE_REGION: false,
          CLUSTER_FORWARD_AVAILABLE: clustered,
          EXTENDED_LIGHTING_AVAILABLE: true,
          DIRECTIONAL_PCSS_AVAILABLE: true,
          PROJECTOR_AVAILABLE: true,
        },
      });
      if (!adapter.ok) throw new Error(adapter.error.message);
      expect(adapter.value.wgsl).not.toMatch(/@group\(3\)|@group\(2\) @binding\([012]\)/);
      expect(adapter.value.wgsl.includes('@group(2)')).toBe(clustered);
      expect(adapter.value.wgsl).toContain('evaluateStandardSurface');
    }
  }
  for (const clustered of [false, true]) {
    const prepared = prepareStandardSource({
      material: 'standard-shared-surface',
      pass: 'Forward',
      templateModule: 'forgeax_material::standard',
      templatePath: engine.defaultStandardPbr.id,
      templateSource: engine.defaultStandardPbr.source,
      surfaceModule: 'forgeax_material::default_standard_surface',
      sourceRecords: Object.entries(engine.imports).map(([path, source]) => ({ path, source })),
      generatedParameters: generateParameterModule(STANDARD_PIPELINE_PARAM_SCHEMA, {
        includeResources: false,
      }),
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const standard = await compileShader(
      lowerStandardPhysicalBindings(prepared.value.source, STANDARD_PIPELINE_PARAM_SCHEMA),
      {
        id: 'standard-shared-surface',
        imports: prepared.value.imports,
        defines: {
          STORAGE_BUFFER_AVAILABLE: true,
          PER_INSTANCE_REGION: false,
          CLUSTER_FORWARD_AVAILABLE: clustered,
          EXTENDED_LIGHTING_AVAILABLE: true,
          TRANSMISSION_AVAILABLE: true,
          PROBE_BLEND_AVAILABLE: true,
          PROJECTOR_AVAILABLE: true,
          DIRECTIONAL_PCSS_AVAILABLE: true,
          REFLECTION_FALLBACK_AVAILABLE: true,
        },
      },
    );
    if (!standard.ok) throw new Error(standard.error.message);
    expect(standard.value.wgsl).toContain('evaluateStandardSurface');
  }
}, 60_000);
