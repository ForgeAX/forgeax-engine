import { expect, it } from 'vitest';
import type { compileShader } from '../../compile.js';
import { createShaderProgramCompiler } from '../../program-compiler.js';
import { cookMaterialAsset, type MaterialCookRequest } from '../cook.js';
import { createMaterialPackVariantCompiler } from '../pack-variant-reuse.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const source = `#define_import_path test::selected_pass
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(material.roughness); }
`;
const request: MaterialCookRequest = {
  material: 'selected',
  table: {
    selected: {
      kind: 'material',
      parameters: [{ name: 'roughness', type: 'f32', default: 0.6 }],
      passes: [
        { name: 'forward', program: { module: 'test::selected_pass' } },
        { name: 'later', program: { module: 'test::selected_pass' } },
      ],
    },
  },
  sources: buildMaterialSourceCatalog({
    engine: [],
    project: [{ path: '/selected.wgsl', source }],
  }).unwrap(),
};

it('compiles only selected derivatives while retaining the complete material contract', async () => {
  const native = createShaderProgramCompiler();
  let calls = 0;
  const compile: typeof compileShader = (...args) => {
    calls++;
    return native(...args);
  };
  const full = (await cookMaterialAsset(request, compile)).unwrap();
  expect(calls).toBe(2);
  calls = 0;
  const selected = (await cookMaterialAsset(request, compile, ['forward'])).unwrap();
  expect(calls).toBe(1);
  expect(selected.passes).toEqual([full.passes[0]]);
  expect(selected.resolved).toEqual(full.resolved);
  expect(selected.layerPlan).toEqual(full.layerPlan);
  expect((await cookMaterialAsset(request, compile, ['missing'])).ok).toBe(false);
});

it('separates full and selected cache entries and canonicalizes selection membership', async () => {
  const native = createShaderProgramCompiler();
  let calls = 0;
  const cached = createMaterialPackVariantCompiler((...args) => {
    calls++;
    return native(...args);
  }).raster;
  expect((await cached(request, 'namespace', ['forward'])).unwrap().passes).toHaveLength(1);
  expect(calls).toBe(1);
  expect((await cached(request, 'namespace')).unwrap().passes).toHaveLength(2);
  expect(calls).toBe(3);
  expect((await cached(request, 'namespace', ['forward'])).unwrap().passes).toHaveLength(1);
  expect(calls).toBe(3);
  expect(
    (await cached(request, 'namespace', ['later', 'forward', 'forward'])).unwrap().passes,
  ).toHaveLength(2);
  expect(calls).toBe(5);
  expect((await cached(request, 'namespace', ['forward', 'later'])).unwrap().passes).toHaveLength(
    2,
  );
  expect(calls).toBe(5);
});
