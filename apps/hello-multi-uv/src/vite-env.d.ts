// apps/hello-multi-uv -- ambient declarations.
//
/// <reference types="vite/client" />

// `@forgeax/engine-vite-plugin-shader` transforms `*.wgsl` modules into a
// `{ hash, wgsl }` JS module where `wgsl` is the post-naga_oil composed
// source. main.ts imports multi-uv-demo.wgsl as an AC-10 visual carrier.

declare module '*.wgsl' {
  const value: { readonly hash: string; readonly wgsl: string };
  export default value;
}

// Build-time virtual module emitted by `@forgeax/engine-vite-plugin-shader`;
// the plugin's resolveId/load hooks generate the runtime implementation.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
