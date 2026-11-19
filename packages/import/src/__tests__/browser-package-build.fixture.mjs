import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const entry = fileURLToPath(new URL('browser-package-consumer.js', import.meta.url));
const modules = [];
const exports = [];
const imports = [];
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
    // The assertions exercise browser entry resolution and bundle closure.
    // Skip minifying and reporting the size of code this fixture discards.
    minify: false,
    reportCompressedSize: false,
    write: false,
    lib: { entry, formats: ['es'], fileName: 'import-browser-consumer' },
  },
});
process.stdout.write(JSON.stringify({ modules, exports, imports }));
