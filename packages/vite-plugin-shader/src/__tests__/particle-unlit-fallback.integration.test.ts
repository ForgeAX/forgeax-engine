import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileShader, materialVertexInputs } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';
import { loadEngineShaderEntries } from '../engine-inputs/load-engine-shader-entries';
import {
  engineMaterialParamSchema,
  filterImportsByDefines,
} from '../engine-inputs/prepare-engine-shader-source';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('unlit particle fallback shader', () => {
  it.each([
    'mesh',
    'mesh-inputs',
  ])('retains %s material/vertex inputs while removing active lighting resources', async (name) => {
    const { imports: engineImports } = await loadEngineShaderEntries();
    const imports = {
      ...engineImports,
      'forgeax_material::standard_surface': read('../../../shader/src/standard-surface.wgsl'),
    };
    const source = read(`../../../vfx-render/src/shaders/${name}-unlit.wgsl`);
    const lit = read(`../../../vfx-render/src/shaders/${name}.wgsl`);
    for (const atmosphere of [false, true]) {
      const defines = {
        STORAGE_BUFFER_AVAILABLE: true,
        ATMOSPHERE_AVAILABLE: atmosphere,
        CLUSTER_FORWARD_AVAILABLE: false,
        EXTENDED_LIGHTING_AVAILABLE: false,
        DIRECTIONAL_PCSS_AVAILABLE: false,
        PROJECTOR_AVAILABLE: false,
      };
      const options = (entry: string) => ({
        imports: filterImportsByDefines(imports, entry, defines, Object.keys(defines)),
        defines,
        renderEntries: {
          vertex: 'vs_main',
          fragment: 'fs_main',
          colorFormats: ['rgba16float' as const],
        },
      });
      const unlit = (await compileShader(source, options(source))).unwrap();
      const before = (await compileShader(lit, options(lit))).unwrap();
      const active = (compiled: typeof unlit, group: number) =>
        compiled.bindings[group]?.entries
          .filter((entry) => (entry.visibility & 2) !== 0)
          .map((entry) => entry.binding) ?? [];
      expect(active(unlit, 1)).toEqual([0, 1, 2, 9, 10]);
      expect(active(before, 1).length).toBeGreaterThan(active(unlit, 1).length);
      expect(materialVertexInputs(unlit.wgsl, 'vs_main', false)).toEqual(
        materialVertexInputs(before.wgsl, 'vs_main', false),
      );
      expect(engineMaterialParamSchema(`forgeax::vfx-render.particles.${name}-unlit`)).toEqual(
        engineMaterialParamSchema(`forgeax::vfx-render.particles.${name}`),
      );
    }
  });
});
