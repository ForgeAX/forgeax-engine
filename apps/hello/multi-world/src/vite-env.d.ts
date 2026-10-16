/// <reference types="vite/client" />

// Ambient module declaration for the build-time virtual module emitted by
// `@forgeax/engine-vite-plugin-shader` (mirror of hello-cube's vite-env.d.ts).
// The plugin's resolveId/load hooks generate the runtime implementation; this
// declaration tells TypeScript the export shape.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
