declare module '*.gltf?url' {
  const url: string;
  export default url;
}

declare module '*.gltf?raw' {
  const source: string;
  export default source;
}

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
    readonly build?: string;
  };
}
