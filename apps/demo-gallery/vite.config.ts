import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveProjectPort } from '@forgeax/engine-devkit';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { defineConfig } from 'vite';
import { createDemoCatalog } from './demo-catalog.js';
import { getDemoShaderMaterialPackages } from './demo-context.js';
import { consumerResolverPlugin } from './vite-plugin-consumer-resolver.js';
import { demoGalleryBundlerPlugin } from './vite-plugin-demo-bundler.js';
import { createDemoPluginsPlugin } from './vite-plugin-demo-plugins.js';
import { demoGalleryHostPlugin } from './vite-plugin-demo-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const appsDir = resolve(here, '..');
const monorepoRoot = resolve(here, '..', '..');
const galleryPort = resolveProjectPort(undefined);
const catalog = createDemoCatalog(appsDir);
const demoPlugins = createDemoPluginsPlugin({
  appsDir,
  galleryDir: here,
  catalog,
});

export default defineConfig((env) => ({
  root: here,
  plugins: [
    ...demoPlugins.plugins.slice(0, 1),
    demoGalleryHostPlugin({ appsDir, galleryDir: here, catalog, prepareDemoRuntime: demoPlugins.prepareDemoRuntime }),
    consumerResolverPlugin({ appsDir, catalog }),
    ...demoPlugins.plugins.slice(1),
    demoGalleryBundlerPlugin(),
    forgeaxShader({
      materialPackagesProvider: () => getDemoShaderMaterialPackages(),
    }) as never,
  ],
  server: {
    ...galleryPort,
    fs: { allow: [monorepoRoot] },
    watch: {
      ignored: ['**/.forgeax/**'],
    },
  },
  preview: galleryPort,
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
      },
    },
  },
}));
