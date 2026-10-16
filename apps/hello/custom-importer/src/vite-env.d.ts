/// <reference types="vite/client" />

// Ambient declaration for the build-time virtual module emitted by
// `@forgeax/engine-vite-plugin-shader` (resolveId/load hooks). This declaration
// tells TypeScript the export shape; the plugin generates the implementation.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
