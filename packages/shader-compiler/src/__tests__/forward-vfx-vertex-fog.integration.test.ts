import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MaterialProgram } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { engineMaterialParamSchema, engineShaderDefines } from '../engine-program';
import { collectMaterialSources } from '../material/pack-cooker';
import { MATERIAL_WGSL_PROFILE } from '../material/profile';
import { prepareShaderProgramCompiler } from '../program-template';

const shaderRoot = fileURLToPath(new URL('../../../shader/src', import.meta.url));
const vfxRoot = fileURLToPath(new URL('../../../vfx-render/src/shaders', import.meta.url));
const files = (await collectMaterialSources([shaderRoot, vfxRoot], [shaderRoot, vfxRoot])).engine;
const imports = Object.fromEntries(files.map((file) => [file.moduleId, file.source]));
const declarations = JSON.parse(
  readFileSync(new URL('../../../vfx-render/package.json', import.meta.url), 'utf8'),
).forgeax.materialPrograms as Record<string, Omit<MaterialProgram, 'module'>>;
const compiler = (await prepareShaderProgramCompiler()).unwrap();
const colors = files.filter(
  (file) => file.path.startsWith(vfxRoot) && basename(file.path) !== 'mesh-shadow.wgsl',
);

it.each(colors)('compiles and certifies the actual VFX vertex fog writer $moduleId', (file) => {
  const program = { ...declarations[basename(file.path)], module: file.moduleId };
  expect(program.forwardFog).toBe('height-vertex/1');
  const paramSchema = engineMaterialParamSchema(file.moduleId);
  for (const storage of [false, true]) {
    const defines = engineShaderDefines(
      file.moduleId,
      {},
      {
        STORAGE_BUFFER_AVAILABLE: storage,
        ATMOSPHERE_AVAILABLE: false,
        CLUSTER_FORWARD_AVAILABLE: false,
        EXTENDED_LIGHTING_AVAILABLE: false,
        PROJECTOR_AVAILABLE: false,
        PROBE_BLEND_AVAILABLE: false,
        TRANSMISSION_AVAILABLE: false,
        REFLECTION_FALLBACK_AVAILABLE: false,
        ALPHA_MASK: false,
        CLIPPING_PLANES: false,
        LOD_DITHER: false,
      },
      false,
      paramSchema,
    );
    const result = compiler.compile(
      {
        schemaVersion: 'shader-program-template/1',
        compilerProfile: MATERIAL_WGSL_PROFILE,
        source: file.source,
        imports,
        axes: [],
        options: { renderEntries: { vertex: 'vs_main', fragment: 'fs_main' } },
        engine: { identifier: file.moduleId, paramSchema, program },
      },
      defines,
    );
    expect(
      result.ok,
      JSON.stringify(result.ok ? { source: file.moduleId, storage } : result.error),
    ).toBe(true);
    expect(result.unwrap().forwardFog).toBe('height-vertex/1');
    expect(
      result.unwrap().manifestEntry.entryPoints?.some((entry) => entry.name === 'vs_main'),
    ).toBe(true);
  }
});
