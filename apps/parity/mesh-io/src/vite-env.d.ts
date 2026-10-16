/// <reference types="vite/client" />

declare module 'virtual:forgeax/bundler' {
  export function forgeaxBundlerAdapter(): {
    readonly shaderManifestUrl: string;
    readonly importTransport?: undefined;
  };
}

declare module "virtual:mesh-io-fixtures" { export const fixtures: { id: string; label: string; guids: string[]; sceneGuid?:string; animationGuid?:string; lightIntensity?:number }[]; }

declare module 'upng-js' { const UPNG: {encode(buffers:ArrayBuffer[],width:number,height:number,colors:number):ArrayBuffer}; export default UPNG; }
