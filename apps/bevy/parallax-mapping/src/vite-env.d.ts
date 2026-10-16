// apps/bevy/parallax-mapping -- ambient declarations.
// virtual:forgeax/bundler is injected by the shader plugin for browser builds.

declare module '*.wgsl' {
  const value: { readonly hash: string; readonly wgsl: string };
  export default value;
}

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
