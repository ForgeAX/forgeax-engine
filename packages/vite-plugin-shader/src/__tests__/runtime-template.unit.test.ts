import { type ShaderProgramTemplate, ShaderRegistry } from '@forgeax/engine-shader';
import {
  compileShader,
  engineMaterialArtifactReceipt,
  engineMaterialParamSchema,
  engineShaderDefines,
  MATERIAL_WGSL_PROFILE,
  prepareEngineShaderSource,
  prepareShaderProgramCompiler,
} from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries.js';

it('resolves actual Standard templates with the same source, reflection and ABI as build compilation', async () => {
  const engine = await loadEngineShaderEntries();
  const file = engine.defaultStandardPbr;
  const compiler = (await prepareShaderProgramCompiler()).unwrap();
  const registry = new ShaderRegistry({ manifestUrl: undefined, programCompiler: compiler });
  const axes = ['STORAGE_BUFFER_AVAILABLE', 'SKINNING_DISABLED', 'VERTEX_COLOR_AVAILABLE'];
  const template: ShaderProgramTemplate = {
    schemaVersion: 'shader-program-template/1',
    compilerProfile: MATERIAL_WGSL_PROFILE,
    source: file.source,
    imports: engine.imports,
    axes,
    engine: {
      identifier: file.reservedIdentifier ?? file.id,
      paramSchema: engineMaterialParamSchema(file.reservedIdentifier ?? file.id),
    },
  };
  registry.installProgramTemplate(file.id, template).unwrap();
  expect(registry.programTemplateInspection().selections).toBe(0);
  for (const storage of [true, false]) {
    for (const color of [true, false]) {
      const selection = {
        STORAGE_BUFFER_AVAILABLE: storage,
        SKINNING_DISABLED: true,
        VERTEX_COLOR_AVAILABLE: color,
      };
      const defines = engineShaderDefines(file.reservedIdentifier ?? '', {}, selection);
      const lowered = prepareEngineShaderSource(
        file,
        engine.imports,
        engine.imports,
        defines,
      ).unwrap();
      const built = (
        await compileShader(lowered.source, { imports: { ...lowered.imports }, defines })
      ).unwrap();
      const runtime = registry.resolveProgramTemplate(file.id, selection).unwrap();
      expect(runtime.manifestEntry.wgsl).toBe(built.wgsl);
      expect(runtime.manifestEntry.reflection).toEqual(built.manifestEntry.reflection);
      expect(runtime.manifestEntry.entryPoints).toEqual(built.manifestEntry.entryPoints);
      expect(runtime.uvSetCount).toBe(built.uvSetCount);
      expect(runtime.receipt).toEqual(engineMaterialArtifactReceipt(file, built, defines).unwrap());
      expect(registry.resolveProgramTemplate(file.id, selection).unwrap()).toBe(runtime);
    }
  }
  expect(registry.programTemplateInspection()).toMatchObject({
    templates: 1,
    selections: 4,
    requests: 8,
    cacheHits: 4,
  });
}, 60_000);

it('rejects a stock template schema that changes the fixed Engine ABI instead of borrowing a canonical receipt', async () => {
  const engine = await loadEngineShaderEntries();
  const file = engine.defaultStandardPbr;
  const compiler = (await prepareShaderProgramCompiler()).unwrap();
  const registry = new ShaderRegistry({ manifestUrl: undefined, programCompiler: compiler });
  registry
    .installProgramTemplate('invalid-stock-abi', {
      schemaVersion: 'shader-program-template/1',
      compilerProfile: compiler.profile,
      source: file.source,
      imports: engine.imports,
      axes: [],
      options: { defines: { STORAGE_BUFFER_AVAILABLE: true, SKINNING_DISABLED: true } },
      engine: {
        identifier: file.reservedIdentifier,
        paramSchema: [
          ...engineMaterialParamSchema(file.reservedIdentifier ?? ''),
          { name: 'extraRuntimeField', type: 'f32', default: 0 },
        ],
      },
    })
    .unwrap();
  const result = registry.resolveProgramTemplate('invalid-stock-abi', {});
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('shader-compile-failed');
  expect(registry.programTemplateInspection().selections).toBe(0);
}, 60_000);
