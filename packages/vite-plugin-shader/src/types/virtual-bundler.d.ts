// virtual-bundler.d.ts -- TypeScript ambient declaration for the
// virtual:forgeax/bundler module emitted by `forgeaxShader` (TASK-020 /
// plan-strategy §3.3 IDE autocomplete service).
//
// Why this file exists (charter F1 progressive disclosure / P1):
// - When an app writes `import { forgeaxBundlerAdapter } from
//   'virtual:forgeax/bundler'`, vite resolves the id at runtime via the
//   plugin's resolveId/load hooks, but TypeScript needs an ambient
//   declaration to know the export shape -- otherwise the import errors with
//   "Cannot find module 'virtual:forgeax/bundler' or its corresponding type
//   declarations" at typecheck time.
//
// Why a *minimal local* shape (D-4 q7-A reverse-coupling guard):
// - The declared return type is a structural local interface, NOT
//   `BundlerOptions` from `@forgeax/engine-app`. The plugin must not import
//   engine-app (would create vite-plugin-shader -> engine-app cycle), and the
//   adapter relies on TypeScript structural typing to remain BundlerOptions-
//   compatible at every callsite (TASK-018 test-d locks this).
// - The minimal shape lists only the two fields the adapter currently
//   surfaces: `shaderManifestUrl` (string, M2 SSOT) + `importTransport`
//   (optional, unknown -- consumers cast where they need a typed transport).
//
// Discovery path (charter F1):
//   import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
//   const opts = forgeaxBundlerAdapter();   // shape autocompleted
//   await createApp(canvas, {}, opts);

declare module 'virtual:forgeax/bundler' {
  /**
   * Build-time adapter that returns a `BundlerOptions`-compatible object.
   * Plugin emits the real implementation through `resolveId` + `load` hooks
   * (`packages/vite-plugin-shader/src/index.ts`).
   *
   * @returns Object with `shaderManifestUrl` (string SSOT plumbed by the
   *   plugin emit path; `/shaders/manifest.json`) and an optional
   *   `importTransport` that the consumer attaches when needed (asset
   *   loader integration). Structurally compatible with
   *   `@forgeax/engine-app` `BundlerOptions`.
   */
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
    readonly build?: string;
  };
}
