declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: {
      readonly importAsset: (guid: string) => Promise<unknown>;
    };
  };
}
