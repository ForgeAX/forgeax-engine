/// <reference types="vite/client" />

declare module '*.gltf?url' {
  const url: string;
  export default url;
}

declare module '*.gltf.meta.json' {
  const value: { readonly subAssets: readonly { readonly guid: string; readonly kind: string }[] };
  export default value;
}

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: { readonly importAsset: (guid: string) => Promise<unknown> };
  };
}
