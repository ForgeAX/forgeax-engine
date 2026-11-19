import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { compileShader } from '../compile';
import {
  engineMaterialParamSchema,
  engineShaderDefines,
  engineShaderSourceImports,
  prepareEngineShaderSource,
} from '../engine-program';
import { collectMaterialSources } from '../material/pack-cooker';

const root = fileURLToPath(new URL('../../../shader/src', import.meta.url));
const files = (await collectMaterialSources([root], [root])).engine;
const imports = Object.fromEntries(files.map((file) => [file.moduleId, file.source]));
const writers = [
  ['default-standard-pbr.wgsl', 'forgeax::default-standard-pbr', false, false],
  ['default-standard-pbr.wgsl', 'forgeax::default-standard-pbr', true, false],
  ['default-standard-pbr.wgsl', 'forgeax::default-standard-pbr', false, true],
  ['default-standard-pbr-skin.wgsl', 'forgeax::pbr-skin', true, false],
  ['unlit.wgsl', 'forgeax::default-unlit', false, false],
  ['sprite.wgsl', 'forgeax::sprite', false, false],
  ['sprite-lit.wgsl', 'forgeax::sprite-lit', false, false],
  ['msdf-text.wgsl', 'forgeax::msdf-text', false, false],
  ['points-lines.wgsl', 'forgeax::points-lines', false, false],
] as const;

it.each(
  writers,
)('vertex fog writer %s material=%s transmission=%s pointShadows=%s composes with admitted transports', async (name, identifier, transmission, pointShadows) => {
  // MSDF is an entry source without an import-path declaration. Read its
  // ordinary entry bytes; it is not a reusable module in the catalog.
  const path = join(root, name);
  const source = { path, source: readFileSync(path, 'utf8') };
  const paramSchema = engineMaterialParamSchema(identifier);
  for (const storage of pointShadows ? [true] : [false, true]) {
    const defines = engineShaderDefines(
      identifier,
      {},
      {
        STORAGE_BUFFER_AVAILABLE: storage,
        GPU_DRIVEN_SCENE_INDEX_AVAILABLE: false,
        CLUSTER_FORWARD_AVAILABLE: pointShadows,
        PROBE_BLEND_AVAILABLE: false,
        TRANSMISSION_AVAILABLE: transmission,
        ALPHA_MASK: false,
        CLIPPING_PLANES: false,
        LOD_DITHER: false,
        SKINNING_DISABLED: true,
      },
      pointShadows,
      paramSchema,
    );
    const file = {
      id: source.path,
      source: source.source,
      reservedIdentifier: identifier,
      paramSchema,
    };
    const prepared = prepareEngineShaderSource(
      file,
      engineShaderSourceImports(file, imports),
      imports,
      defines,
    ).unwrap();
    const result = await compileShader(prepared.source, {
      imports: prepared.imports,
      defines,
      renderEntries: { vertex: 'vs_main', fragment: 'fs_main' },
    });
    expect(
      result.ok,
      JSON.stringify(
        result.ok ? { name, storage } : { ...result.error, message: result.error.message },
      ),
    ).toBe(true);
    const compiled = result.unwrap();
    expect(compiled.reflection.entryPoints?.some((entry) => entry.name === 'vs_main')).toBe(true);
    expect(compiled.reflection.entryPoints?.some((entry) => entry.name === 'fs_main')).toBe(true);
  }
});
