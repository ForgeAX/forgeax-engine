/// <reference types="vite/client" />

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly importTransport?: NonNullable<import('@forgeax/engine/app').BundlerOptions['importTransport']>;
    readonly shaderManifestUrl?: string;
  };
}

declare const __FORGEAX_PRODUCT_HEAD__: string;
