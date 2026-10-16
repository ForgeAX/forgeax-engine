/// <reference types="vite/client" />

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
