// apps/bevy/cubic-splines -- ambient declarations.
//
// `virtual:forgeax/bundler` is provided by @forgeax/engine-vite-plugin-shader
// at build/dev time; createApp consumes its adapter for the shader manifest URL.

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}
