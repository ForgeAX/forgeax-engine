import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';

// hello-compressed-texture vite config (feat-20260707-texture-block-compression-web-transcode-ktx2-basis M6 / w39).
//
// pluginPack scans local assets/ for checker-rgba.png + checker-rgba-nobc.png.
// The .meta.json sidecars carry compressionMode:'etc1s' (-> .ktx2) and
// compressionMode:'none' (-> raw .bin). The imageImporter + encodeTextureToKtx2
// arm runs during import so the Basis encode happens at build-time, offloading
// the developer's machine. The runtime demo loads via configureRuntimeAssetCatalog +
// loadByGuid<TextureAsset>(guid) and the Basis transcode + block-aware upload
// path (M5 w34/w35/w36) runs transparently.
//
// forgeaxShader emits manifest.json with default-standard-pbr entries; the
// engine registers the PBR variant at boot so the quad mesh renders through
// the packed PBR pipeline.

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-compressed-texture');

export default defineConfig({
  plugins: [
    forgeaxShader() as never,
    pluginPack({
      refresh: reloadAssetHost(),
      roots: [resolve(here, 'assets')],
      importers: [imageImporter],
      runtimeBinding,
    }),
  ],
  server: {
    fs: {
      allow: [monorepoRoot],
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
});
