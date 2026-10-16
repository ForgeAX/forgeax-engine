import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { gltfImporter } from '@forgeax/engine-gltf/node-importer';
import { objImporter, stlImporter, svgImporter } from '@forgeax/engine-mesh-io';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';
import { prepareFixtures } from './fixtures.js';
import { prepareScaleFixtures } from './scale-fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../');
const sources = resolve(root, 'artifacts/mesh-io/fixtures');
const fixtures = await prepareFixtures(sources);
const scaleSources = resolve(root, 'artifacts/mesh-io/scale');
const scaleFixtures = process.env.MESH_IO_SCALE_ASSETS === '1' ? await prepareScaleFixtures(scaleSources, resolve(sources, 'paint/checker.png')) : [];

export default defineConfig({
  // Capture hashes load after startup; optimize them before a live device exists.
  optimizeDeps: { include: ['@forgeax/engine-rhi-debug > @noble/hashes/blake3.js'] },
  plugins: [
    forgeaxShader() as never,
    pluginPack({ roots: [sources, ...(scaleFixtures.length === 0 ? [] : [scaleSources])], runtimeBinding: createStandaloneRuntimeAssetBinding('mesh-io-parity'), cookers: [createMaterialPackCooker()], importers: [imageImporter, objImporter, stlImporter, svgImporter, gltfImporter], refresh: reloadAssetHost() }),
    { name: 'mesh-io-fixtures', resolveId(id) { if (id === 'virtual:mesh-io-fixtures') return `\0${id}`; return undefined; }, load(id) { if (id === '\0virtual:mesh-io-fixtures') return `export const fixtures = ${JSON.stringify([...fixtures, ...scaleFixtures])}`; return undefined; } },
  ],
  server: { fs: { allow: [root] } },
  build: { target: 'esnext' },
});
