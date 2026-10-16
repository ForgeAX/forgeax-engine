// apps/hello/custom-shader -- ambient declarations.
//
// `@forgeax/engine-vite-plugin-shader` transforms `*.wgsl` modules into a
// `{ hash, wgsl }` JS module (vite-plugin-shader/src/index.ts line 875+),
// where `hash` is the content-addressed manifest entry id and `wgsl` is the
// post-composition source. The runtime consumes the manifest entry by its
// module identifier after the cooked pack has been loaded.

declare module '*.wgsl' {
  const value: { readonly hash: string; readonly wgsl: string };
  export default value;
}

// feat-20260608-create-app-param-surface-trim / M3 -- ambient module declaration for the
// build-time virtual module emitted by `@forgeax/engine-vite-plugin-shader`.
// The plugin's resolveId/load hooks (TASK-019) generate the runtime
// implementation; this declaration tells TypeScript the export shape.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
