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