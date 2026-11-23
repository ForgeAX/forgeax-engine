import {
  createShaderProgramCompiler,
  materialVertexInputs,
  prepareEngineShaderSource,
  standardMaterialDefines,
  terrainProgramSource,
} from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';
import { engineMaterialParamSchema } from '../engine-inputs/prepare-engine-shader-source';
import { publishedVariantDefines } from '../index';

it('publishes fixed Terrain programs without Water variants from the shared Pack composition', async () => {
  const engine = await loadEngineShaderEntries();
  expect(engine.terrain).toHaveLength(6);
  for (const file of engine.terrain) {
    const composition = terrainProgramSource(file.reservedIdentifier ?? '');
    expect(composition).toBeDefined();
    expect(composition?.defines).toMatchObject({
      WATER_WAVES_AVAILABLE: false,
      WATER_INFO_RGBA16: false,
    });
    expect(file.defines).toMatchObject(composition?.defines ?? {});
    expect(file.source).not.toMatch(
      /^#pragma variant_axis WATER_(WAVES_AVAILABLE|INFO_RGBA16)\s*$/m,
    );
    for (const row of publishedVariantDefines(file.source)) {
      expect(Object.hasOwn(row, 'WATER_WAVES_AVAILABLE')).toBe(false);
      expect(Object.hasOwn(row, 'WATER_INFO_RGBA16')).toBe(false);
    }
  }
});

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
    const templateImports: Record<string, string> = { ...engine.imports };
    if (file.surfaceModule.includes('_detail_')) {
      // The template has no lexical import for the selected slot or its weight evaluator.
      delete templateImports[file.surfaceModule];
      delete templateImports['forgeax_material::terrain_surface'];
    }
    const prepared = prepareEngineShaderSource(file, templateImports, engine.imports, defines);
    expect(prepared.ok, prepared.ok ? undefined : JSON.stringify(prepared.error.detail)).toBe(true);
    if (!prepared.ok) continue;
    const compiled = await compile(prepared.value.source, {
      id: file.id,
      imports: prepared.value.imports,
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
    if (!file.id.endsWith('-shadow')) {
      expect(compiled.value.wgsl.includes('terrainWeightDetail_sampler')).toBe(
        file.surfaceModule.includes('_detail_'),
      );
    }
    const inputs = materialVertexInputs(compiled.value.wgsl, 'vs_main');
    expect(inputs.some((input) => input.semantic === 'position')).toBe(true);
    expect(inputs.some((input) => input.semantic === 'skinIndex')).toBe(false);
    expect(compiled.value.wgsl.includes('sceneMaterialRows')).toBe(false);
  }
}, 30_000);

it('keeps the unconditional Terrain discards instead of the Standard discard-source axes', async () => {
  const engine = await loadEngineShaderEntries();
  const color = engine.terrain.filter((file) => !file.id.endsWith('-shadow'));
  expect(color).toHaveLength(3);
  for (const file of color) {
    expect(file.source).not.toMatch(/^#pragma variant_axis (LOD_DITHER|CLIPPING_PLANES)\s*$/m);
    expect(file.defines).toMatchObject({ LOD_DITHER: true, CLIPPING_PLANES: true });
  }
});
