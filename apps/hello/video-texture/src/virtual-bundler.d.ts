// Ambient type declaration for `virtual:forgeax/bundler` so TypeScript
// understands `import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler'`
// at typecheck time. The actual module is emitted by the vite-plugin-shader
// plugin at build/dev time.
declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}