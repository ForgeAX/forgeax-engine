import { referenceAssets } from './scripts/reference-assets.mjs';
import { defineConfig } from 'vite';
import { forgeaxShader } from '@forgeax/engine/vite-plugin-shader';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const reference = resolve(root, process.env.ROBRUN_REFERENCE ?? '../../../robrun-reference/download');
export default defineConfig({
  root,
  plugins: [referenceAssets(reference), forgeaxShader(), {
    name: 'native-runtime-dependency-gate',
    generateBundle() {
      const modules = [...this.getModuleIds()];
      const rejected = modules.filter(id => /(?:^|\/)three(?:\/|-)|\/packages\/three\//i.test(id));
      if (rejected.length) this.error(`Non-native runtime dependencies: ${rejected.join(', ')}`);
      this.emitFile({ type: 'asset', fileName: 'native-runtime-modules.json', source: JSON.stringify({
        moduleCount: modules.length, forbiddenDependencyCount: rejected.length,
        modules: modules.map(id => id.replace(resolve(root, '../..'), '<engine>')),
      }) });
    },
  }],
  server: { host: '127.0.0.1', port: 8848, strictPort: true, fs: { allow: [resolve(root, '../..'), reference] } },
  preview: { host: '127.0.0.1', port: 8848, strictPort: true },
  build: { target: 'esnext', sourcemap: 'hidden' },
});
