import {
  createShaderProgramCompiler,
  materialVertexInputs,
  standardMaterialDefines,
} from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';
import {
  engineMaterialParamSchema,
  lowerEngineSurfaceEntry,
} from '../engine-inputs/prepare-engine-shader-source';

it.each([
  false,
  true,
])('builds fixed Terrain color and shadow programs from the engine source (storage=%s)', async (storage) => {
  const engine = await loadEngineShaderEntries();
  const compile = createShaderProgramCompiler();
  for (const file of engine.terrain) {
    const defines = {
      ...Object.fromEntries(
        [...file.source.matchAll(/^#pragma variant_axis (\w+)/gm)].map((match) => [
          match[1],
          false,
        ]),
      ),
      ...standardMaterialDefines(engineMaterialParamSchema(file.reservedIdentifier)),
      PER_INSTANCE_REGION: false,
      STORAGE_BUFFER_AVAILABLE: storage,
      ...file.defines,
    };
    const prepared = lowerEngineSurfaceEntry(file, engine.imports, engine.imports, defines);
    const compiled = await compile(prepared.source, {
      id: file.id,
      imports: prepared.imports,
      defines,
    });
    expect(
      compiled.ok,
      compiled.ok
        ? undefined
        : `${compiled.error.message} ${JSON.stringify(compiled.error.detail)}`,
    ).toBe(true);
    if (!compiled.ok) continue;
    expect(compiled.value.wgsl).toContain('terrainVertex');
    expect(compiled.value.wgsl.includes('pairWeights')).toBe(file.surfaceModule.includes('_id_'));
    const inputs = materialVertexInputs(compiled.value.wgsl, 'vs_main');
    expect(inputs.some((input) => input.semantic === 'position')).toBe(true);
    expect(inputs.some((input) => input.semantic === 'skinIndex')).toBe(false);
    expect(compiled.value.wgsl.includes('sceneMaterialRows')).toBe(false);
  }
}, 30_000);
