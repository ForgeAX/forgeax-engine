import { defineConfig } from 'vite';
import vitePluginRhiDebug from '@forgeax/engine-vite-plugin-rhi-debug';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';

export default defineConfig({ plugins: [forgeaxShader(), vitePluginRhiDebug()] });
