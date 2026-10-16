import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { pluginPack, reloadAssetHost } from '@forgeax/engine-vite-plugin-pack';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { optionalAssetPack } from '../../shared/src/optional-asset-pack.js';

const here = dirname(fileURLToPath(import.meta.url));
const monorepoRoot = resolve(here, '..', '..', '..');
const assetRoots = [
  resolve(monorepoRoot, 'forgeax-engine-assets/learn-opengl/textures/newport_loft.hdr.meta.json'),
];
const runtimeBinding = createStandaloneRuntimeAssetBinding('hello-physical-material');
const exactHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: monorepoRoot, encoding: 'utf8' }).trim();
const materialPackages = [
  'standard-clearcoat.pack.json',
  'standard-clearcoat-factor-r.pack.json',
  'standard-clearcoat-roughness-g.pack.json',
  'standard-clearcoat-normal-rg.pack.json',
  'standard-full-physical.pack.json',
  'skin-clearcoat-factor-r.pack.json',
  'skin-clearcoat-roughness-g.pack.json',
  'skin-clearcoat-normal-rg.pack.json',
  'skin-full-physical.pack.json',
].map((name) => resolve(here, 'src', name));
const packRoots = [...assetRoots, ...materialPackages];

export default defineConfig({
  define: { __FORGEAX_PHYSICAL_MATERIAL_EXACT_HEAD__: JSON.stringify(exactHead) },
  plugins: [
    forgeaxShader({ materialPackages }) as never,
    ...optionalAssetPack(packRoots, () =>
      pluginPack({
        runtimeBinding,
        producerReadiness: 'on-demand',
        refresh: reloadAssetHost(),
        roots: packRoots,
        importers: [imageImporter],
        cookers: [createMaterialPackCooker([resolve(here, 'src')])],
      }),
    ),
  ],
  server: {
    fs: { allow: [monorepoRoot] },
    watch: { usePolling: true, interval: 250 },
  },
  build: { target: 'esnext', rollupOptions: { input: { main: resolve(here, 'index.html') } } },
});
