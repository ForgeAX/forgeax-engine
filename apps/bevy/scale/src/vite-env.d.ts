// apps/bevy/scale -- ambient declarations.
// `virtual:forgeax/bundler` is injected by the shader plugin for browser builds.

declare var __bevyScaleReady: boolean | undefined;

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
