/// <reference types="vite/client" />

// feat-20260616-engine-state-and-state-scoped-entities -- ambient declaration
// for the build-time virtual module emitted by @forgeax/engine-vite-plugin-shader.
// The plugin's resolveId/load hooks generate the runtime implementation; this
// declaration tells TypeScript the export shape so createApp's bundler arg
// typechecks.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
