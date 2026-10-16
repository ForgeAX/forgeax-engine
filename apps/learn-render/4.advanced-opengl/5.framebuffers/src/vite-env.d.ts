/// <reference types="vite/client" />

// LearnOpenGL 4.5 framebuffers demo — ambient declarations.
//
// `@forgeax/engine-vite-plugin-shader` transforms `*.wgsl` modules into a
// `{ hash, wgsl }` JS module (vite-plugin-shader/src/index.ts ~line 875).
// The 6 post-process effects in ./shaders/*.wgsl are imported directly here
// (mirroring apps/hello/custom-shader/src/vite-env.d.ts) so the demo can
// feed `entry.wgsl` to the feature host as a fullscreen render feature.

declare module '*.wgsl' {
  const value: { readonly hash: string; readonly wgsl: string };
  export default value;
}

// feat-20260608-create-app-param-surface-trim / M3 — ambient module declaration
// for the build-time virtual module emitted by `@forgeax/engine-vite-plugin-shader`.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
