// apps/hello/triangle - ambient declarations (T-19).
//
// Vite supports `?raw` suffix imports returning the file contents as a
// string. TypeScript needs an ambient declaration to accept them without
// `@ts-expect-error`. Scoped narrowly to *.wgsl?raw (the only raw imports
// currently in use).

declare module '*.wgsl?raw' {
  const source: string;
  export default source;
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
