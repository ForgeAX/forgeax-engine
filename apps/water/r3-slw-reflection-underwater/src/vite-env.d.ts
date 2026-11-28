declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
    readonly build?: string;
  };
}

declare const __WATER_R3_SSR_IDENTITY__:
  | import('@forgeax/engine/render').SsrAdmissionIdentity
  | null;

declare module '*.wgsl' {
  const value: { readonly hash: string; readonly wgsl: string };
  export default value;
}
