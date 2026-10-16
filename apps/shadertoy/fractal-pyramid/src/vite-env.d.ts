// apps/shadertoy/fractal-pyramid -- ambient declarations.
//
// `@forgeax/engine-vite-plugin-shader` transforms `*.wgsl` modules into a
// `{ hash, wgsl }` JS module, where `hash` is the content-addressed manifest
// entry id and `wgsl` is the post-naga_oil composed source.

declare module '*.wgsl' {
  const value: { readonly hash: string; readonly wgsl: string };
  export default value;
}

// The build-time virtual module emitted by `@forgeax/engine-vite-plugin-shader`
// (resolveId/load hooks generate the runtime implementation).
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
