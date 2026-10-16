declare module 'three' {
  export class Color {
    constructor(r?: number, g?: number, b?: number);
    setRGB(r: number, g: number, b: number, colorSpace?: string): this;
  }
  export class BoxGeometry {
    constructor(width?: number, height?: number, depth?: number);
  }
  export class MeshStandardMaterial {
    constructor(parameters?: Record<string, unknown>);
  }
  export class Mesh {
    position: { set(x: number, y: number, z: number): void };
    scale: { setScalar(value: number): void };
    rotation: { y: number };
    constructor(geometry: unknown, material: unknown);
  }
  export class Scene {
    add(...objects: unknown[]): void;
  }
  export class PerspectiveCamera {
    position: { set(x: number, y: number, z: number): void };
    quaternion: { set(x: number, y: number, z: number, w: number): void };
    constructor(fov: number, aspect: number, near: number, far: number);
  }
  export class PointLight {
    position: { set(x: number, y: number, z: number): void };
    constructor(color?: unknown, intensity?: number, distance?: number, decay?: number);
  }
  export class DirectionalLight {
    position: { set(x: number, y: number, z: number): void };
    target: { position: { set(x: number, y: number, z: number): void } };
    castShadow: boolean;
    constructor(color?: unknown, intensity?: number);
  }
  export class SpotLight {
    position: { set(x: number, y: number, z: number): void };
    target: { position: { set(x: number, y: number, z: number): void } };
    constructor(
      color?: unknown,
      intensity?: number,
      distance?: number,
      angle?: number,
      penumbra?: number,
      decay?: number,
    );
  }
  export const ACESFilmicToneMapping: number;
  export const SRGBColorSpace: string;
}

declare module 'three/webgpu' {
  export class WebGPURenderer {
    info: unknown;
    outputColorSpace: string;
    toneMapping: number;
    toneMappingExposure: number;
    constructor(options?: Record<string, unknown>);
    init(): Promise<void>;
    setPixelRatio(value: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setClearColor(color: unknown, alpha?: number): void;
    render(scene: unknown, camera: unknown): void;
  }
}
