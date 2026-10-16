import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, it } from 'vitest';

it('bundles glTF and mesh field production through the published browser entry', async () => {
  const entry = fileURLToPath(new URL('browser-package-consumer.js', import.meta.url));
  const modules: string[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  await build({
    root: fileURLToPath(new URL('../../../../', import.meta.url)),
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'import-browser-consumer',
        resolveId: (id) => (id === entry ? `\0${entry}` : undefined),
        load: (id) =>
          id === `\0${entry}`
            ? `export { gltfImporter } from '@forgeax/engine-gltf';
               export { cookMeshDistanceFieldProduct, encodeMeshDistanceFieldProduct }
                 from '@forgeax/engine-import';`
            : undefined,
        generateBundle(_, bundle) {
          for (const output of Object.values(bundle)) {
            if (output.type !== 'chunk') continue;
            modules.push(...Object.keys(output.modules));
            exports.push(...output.exports);
            imports.push(...output.imports, ...output.dynamicImports);
          }
        },
      },
    ],
    build: {
      write: false,
      lib: { entry, formats: ['es'], fileName: 'import-browser-consumer' },
    },
  });
  expect(exports).toEqual(
    expect.arrayContaining([
      'gltfImporter',
      'cookMeshDistanceFieldProduct',
      'encodeMeshDistanceFieldProduct',
    ]),
  );
  expect(modules.some((id) => id.endsWith('/packages/import/dist/browser.mjs'))).toBe(true);
  expect(modules.some((id) => id.endsWith('/packages/import/dist/index.mjs'))).toBe(false);
  expect(modules.some((id) => id.includes('browser-external'))).toBe(false);
  expect(imports).toEqual([]);
});
