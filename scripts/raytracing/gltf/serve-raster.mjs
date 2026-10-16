import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { gltfImporter } from '../../../packages/gltf/dist/index.mjs';
import { imageImporter } from '../../../packages/image/dist/image-importer.mjs';
import { createMaterialPackCooker } from '../../../packages/shader-compiler/dist/index.mjs';
import { createStandaloneRuntimeAssetBinding } from '../../../packages/types/dist/index.mjs';
import { pluginPack, reloadAssetHost } from '../../../packages/vite-plugin-pack/dist/index.mjs';
import { vitePluginRhiDebug } from '../../../packages/vite-plugin-rhi-debug/dist/index.mjs';
import { forgeaxShader } from '../../../packages/vite-plugin-shader/dist/index.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const rhiDebug = process.env.FORGEAX_RASTER_RHI_DEBUG !== '0';
const server = await createServer({
  configFile: false,
  root: resolve(root, 'scripts/raytracing/gltf'),
  ...(rhiDebug ? {} : { define: { 'import.meta.env.FORGEAX_ENGINE_RHI_DEBUG': '"0"' } }),
  plugins: [
    forgeaxShader(),
    ...(rhiDebug ? [vitePluginRhiDebug({ rootDir: root })] : []),
    pluginPack({
      runtimeBinding: createStandaloneRuntimeAssetBinding('ray-sponza-raster'),
      refresh: reloadAssetHost(),
      roots: [
        resolve(root, 'forgeax-engine-assets/khronos-gltf-samples/Sponza/Sponza.gltf.meta.json'),
        resolve(root, 'scripts/raytracing/gltf/room.gltf.meta.json'),
      ],
      importers: [imageImporter, gltfImporter],
      cookers: [createMaterialPackCooker()],
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.FORGEAX_RASTER_PORT ?? 5198),
    strictPort: true,
    hmr: false,
    fs: { allow: [root] },
  },
});
await server.listen();
server.printUrls();
