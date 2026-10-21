import { ShaderRegistry } from '@forgeax/engine-shader';
import { compileShader } from '@forgeax/engine-shader-compiler';
import { expect, it } from 'vitest';
import { publishShaderManifest } from '../manifest-publication';

it('preserves exact native entry reads through pooled primary and variant manifest admission', async () => {
  const source = (field: string) =>
    `struct P { depth: vec4<f32>, other: vec4<f32>, } @group(1) @binding(0) var<uniform> p: P; @vertex fn vs_main() -> @builtin(position) vec4<f32> { return p.${field}; }`;
  const [first, second] = await Promise.all(
    ['depth', 'other'].map(async (field) => (await compileShader(source(field))).unwrap()),
  );
  if (first === undefined || second === undefined) throw new Error('Missing compiled programs');
  const rows = [first, second];
  const manifest = publishShaderManifest(
    rows.map((row) => row.manifestEntry),
    [
      {
        identifier: 'game::entry-reads',
        sourcePath: 'entry.wgsl',
        paramSchema: '[]',
        composedWgsl: first.wgsl,
        entryPoints: first.manifestEntry.entryPoints,
        variants: rows.map((row, index) => ({
          definesKey: index === 1 ? '' : 'MODE=false',
          defines: { MODE: index === 1 },
          composedWgsl: row.wgsl,
          entryPoints: row.manifestEntry.entryPoints,
        })),
      },
    ],
  );
  const registry = new ShaderRegistry({
    manifestUrl: 'memory:entry-reads',
    readText: async () => JSON.stringify(manifest),
  });
  (await registry.loadManifest()).unwrap();
  const material = registry.materialShaderManifestEntry('game::entry-reads');
  expect(material?.entryPoints).toEqual(first.reflection.entryPoints);
  expect(material?.variants.map((variant) => variant.entryPoints)).toEqual(
    rows.map((row) => row.reflection.entryPoints),
  );
  expect(material?.variants[0]?.entryPoints?.[0]?.bindings[0]?.fields).toEqual(['depth']);
  expect(material?.variants[1]?.entryPoints?.[0]?.bindings[0]?.fields).toEqual(['other']);
});
