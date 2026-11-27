import { assert, expect, it } from 'vitest';
import { ShaderRegistry } from '../ShaderRegistry.js';
import { type MaterialShaderManifestEntry, materialShaderAxes } from '../types.js';

function manifestRow() {
  const source = '@fragment fn material() -> @location(0) vec4<f32> { return vec4<f32>(1); }';
  return {
    identifier: 'fixture::material',
    sourcePath: 'material.wgsl',
    composedWgsl: source,
    paramSchema: '[]',
    variants: [
      { definesKey: 'RED=false', defines: { RED: false }, composedWgsl: source },
      {
        definesKey: 'GREEN=false+RED=true',
        defines: { RED: true, GREEN: false },
        composedWgsl: source,
      },
    ],
  } satisfies MaterialShaderManifestEntry;
}

it('reuses admitted axes in order without rescanning the selected manifest family', async () => {
  const registry = new ShaderRegistry({
    manifestUrl: 'memory:material-manifest-axes',
    readText: async () => JSON.stringify({ entries: [], materialShaders: [manifestRow()] }),
  });
  (await registry.loadManifest()).unwrap();
  const entry = registry.materialShaderManifestEntry('fixture::material');
  assert(entry);
  const axes = materialShaderAxes(entry);
  expect(axes).toEqual(['RED', 'GREEN']);
  expect(materialShaderAxes(entry)).toBe(axes);
  expect(Object.isFrozen(axes)).toBe(true);
  expect(Object.isFrozen(entry.variants[0]?.defines)).toBe(true);
});

it('reads the live axes of a caller-owned manifest family', () => {
  const row = manifestRow();
  expect(materialShaderAxes(row)).toEqual(['RED', 'GREEN']);
  row.variants.splice(1, 1);
  expect(materialShaderAxes(row)).toEqual(['RED']);
});
