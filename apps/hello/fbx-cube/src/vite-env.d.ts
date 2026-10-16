/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}