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
// The adapter's return type is the existing App host facade. The Vite plugin
// has no runtime dependency on App; this type-only link keeps generated host
// code assignable without duplicating App's capability contract here.
//
// Discovery path (charter F1):
//   import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
//   const opts = forgeaxBundlerAdapter();   // shape autocompleted
//   await createApp(canvas, {}, opts);

declare module 'virtual:forgeax/bundler' {
  import type { AppHostAdapter } from '@forgeax/engine-app';
  /**
   * Build-time adapter that returns an App host adapter.
   * Plugin emits the real implementation through `resolveId` + `load` hooks
   * (`packages/vite-plugin-shader/src/index.ts`).
   *
   * @returns Renderer build inputs and optional explicit App capabilities for
   *   recorder capture, remote service startup, and browser relay lifecycle.
   */
  export function forgeaxBundlerAdapter(): AppHostAdapter;
}
