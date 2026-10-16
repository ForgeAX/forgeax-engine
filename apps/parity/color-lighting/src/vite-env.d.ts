/// <reference types="vite/client" />

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly importTransport?: unknown;
    readonly shaderManifestUrl?: string;
  };
}

declare const __FORGEAX_PRODUCT_HEAD__: string;
