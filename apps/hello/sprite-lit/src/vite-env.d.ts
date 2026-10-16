/// <reference types="vite/client" />

// feat-20260624-sprite-lit-shading-model-pure-2d-lighting / M1' / w6 --
// ambient module declaration for the build-time virtual module emitted by
// `@forgeax/engine-vite-plugin-shader` (loadEngineShaderEntries auto-includes
// the sprite-lit.wgsl entries when this app workspace lists the plugin in
// vite.config.ts; the shape mirrors apps/hello/sprite/src/vite-env.d.ts).
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
