/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly FORGEAX_BROWSER_CI_LIGHTWEIGHT?: string;
}

// feat-20260608-create-app-param-surface-trim / M3 -- ambient module declaration
// for the build-time virtual module emitted by `@forgeax/engine-vite-plugin-shader`.
// See per-app vite-env.d.ts files for context. apps/shared is included by some
// consumers' tsconfig (cube/app/picking/culling/custom-shader/inspector-demo/
// 6.pbr.* learn-render demos) and by relative-path import from others; placing
// the declaration here lets consumers that include shared pick up the type.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
