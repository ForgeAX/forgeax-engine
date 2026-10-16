/// <reference types="vite/client" />

// Ambient module declaration for the
// build-time virtual module emitted by `@forgeax/engine-vite-plugin-shader`.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
