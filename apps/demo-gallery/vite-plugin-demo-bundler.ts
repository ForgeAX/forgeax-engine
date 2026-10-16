import type { Plugin } from 'vite';

const VIRTUAL_BUNDLER_ID = 'virtual:forgeax/bundler';
const SHADER_MANIFEST_PATH = '/shaders/manifest.json';

/**
 * Standalone demos wire importTransport explicitly; gallery must inject it into
 * forgeaxBundlerAdapter so DDC misses can POST to the scoped pack import route.
 *
 * Shader manifest is always served at the gallery host root (`/shaders/manifest.json`);
 * demo context is resolved from the Referer. BASE_URL-prefixed paths would hit the
 * gallery shell HTML instead of forgeaxShader middleware.
 */
export function demoGalleryBundlerPlugin(): Plugin {
  return {
    name: 'forgeax:demo-gallery-bundler',
    enforce: 'pre',
    resolveId(source) {
      if (source === VIRTUAL_BUNDLER_ID) return VIRTUAL_BUNDLER_ID;
      return null;
    },
    load(id) {
      if (id !== VIRTUAL_BUNDLER_ID) return null;
      return [
        "import { createRuntimeAssetImportTransport, runtimeBinding } from 'virtual:forgeax/pack-runtime';",
        'export function forgeaxBundlerAdapter() {',
        '  return {',
        `    shaderManifestUrl: ${JSON.stringify(SHADER_MANIFEST_PATH)},`,
        '    importTransport:',
        '      runtimeBinding === undefined ? undefined : createRuntimeAssetImportTransport(runtimeBinding),',
        '  };',
        '}',
      ].join('\n');
    },
  };
}
