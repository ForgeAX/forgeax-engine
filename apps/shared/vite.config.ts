import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// feat-20260608-create-app-param-surface-trim / M3: in vitest the
// `virtual:forgeax/bundler` virtual module is not resolved by the
// `@forgeax/engine-vite-plugin-shader` plugin (vitest does not run the
// build-time plugin chain). The unit tests under apps/shared/src/__tests__/
// only exercise pure math helpers but they import-side-effect the whole
// learn-render-first-person.ts module (which carries the virtual import at
// the top). We resolve it to a tiny stub so node ESM resolution does not
// trip; the stub returns the same shape the runtime adapter would.
export default defineConfig({
  test: {
    name: '@forgeax/apps-shared',
    alias: {
      'virtual:forgeax/pack-runtime': resolve(
        import.meta.dirname,
        './src/__test-stubs__/pack-runtime-stub.ts',
      ),
      'virtual:forgeax/bundler': resolve(
        import.meta.dirname,
        './src/__test-stubs__/virtual-bundler-stub.ts',
      ),
    },
  },
});
