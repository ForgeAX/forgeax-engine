declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl?: string;
    readonly assetPackUrl?: string;
  };
}

declare module '*.wgsl' {
  const shader: { readonly wgsl: string };
  export default shader;
}
