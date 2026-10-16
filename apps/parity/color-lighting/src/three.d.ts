declare module 'three' {
  export const ACESFilmicToneMapping: number;
  export const AmbientLight: new (...args: any[]) => any;
  export const BackSide: number;
  export const BoxGeometry: new (...args: any[]) => any;
  export const BufferAttribute: new (array: ArrayLike<number>, itemSize: number) => any;
  export const BufferGeometry: new () => any;
  export const PerspectiveCamera: new (fov: number, aspect: number, near: number, far: number) => any;
  export const Color: new (value?: number) => any;
  export const DataTexture: new (...args: any[]) => any;
  export const DoubleSide: number;
  export const HalfFloatType: number;
  export const DirectionalLight: new (...args: any[]) => any;
  export const LinearSRGBColorSpace: string;
  export const Mesh: new (...args: any[]) => any;
  export const MeshBasicMaterial: new (...args: any[]) => any;
  export const MeshStandardMaterial: new (...args: any[]) => any;
  export const NearestFilter: number;
  export const NoToneMapping: number;
  export const NoBlending: number;
  export const PlaneGeometry: new (...args: any[]) => any;
  export const PointLight: new (...args: any[]) => any;
  export const RGBAFormat: number;
  export const RectAreaLight: new (...args: any[]) => any;
  export const REVISION: string;
  export const RenderTarget: new (width: number, height: number, options?: object) => any;
  export const Scene: new () => any;
  export const SRGBColorSpace: string;
  export const SpotLight: new (...args: any[]) => any;
  export const SphereGeometry: new (...args: any[]) => any;
  export const UnsignedByteType: number;
  export const WebGLRenderer: new (options?: object) => any;
  export const SpotLight: new (...args: any[]) => any;
  export const LightProbe: new (...args: any[]) => any;
  export const LinearFilter: number;
}

declare module 'three/addons/lights/RectAreaLightUniformsLib.js' {
  export const RectAreaLightUniformsLib: { init(): void };
}

declare module 'three/addons/lights/RectAreaLightTexturesLib.js' {
  export const RectAreaLightTexturesLib: { init(): unknown };
}

declare module 'three/webgpu' {
  export const IESSpotLight: new (...args: any[]) => any;
  export const RectAreaLightNode: { setLTC(ltc: unknown): void };
  export const PMREMGenerator: new (...args: any[]) => {
    fromScene(scene: any, sigma?: number, near?: number, far?: number, options?: object): {
      texture: { dispose(): void };
      dispose(): void;
    };
    dispose(): void;
  };
  export const WebGPURenderer: new (options?: object) => any;
}
