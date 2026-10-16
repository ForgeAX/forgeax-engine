/// <reference types="vite/client" />

// tweak-20260701-sprite-lit-flat-default-drop-ndotl-for-2d M2 / m2-1 --
// ambient module declaration for the build-time virtual module emitted by
// `@forgeax/engine-vite-plugin-shader` (loadEngineShaderEntries auto-includes
// the sprite-lit.wgsl entries when this app workspace lists the plugin in
// vite.config.ts; the shape mirrors apps/hello/sprite-lit/src/vite-env.d.ts).
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
