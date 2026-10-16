export {
  captureTransparencyForgeaxBrowser as captureForgeaxBrowser,
  captureTransparencyThreeBrowser as captureThreeBrowser,
  makeTransparencyWorld as makeWorld,
} from '../../src/adapters/transparency-post-adapter';

interface DawnSurface {
  readonly canvas: HTMLCanvasElement;
  readonly getTexture: () => GPUTexture;
}

export function createDawnSurface(width: number, height: number): DawnSurface {
  let texture: GPUTexture | undefined;
  const canvas = {
    width,
    height,
    getContext(kind: string): unknown {
      if (kind !== 'webgpu') return null;
      return {
        configure(desc: { device: GPUDevice; format?: GPUTextureFormat }) {
          texture = desc.device.createTexture({
            size: { width, height, depthOrArrayLayers: 1 },
            format: desc.format ?? 'rgba8unorm',
            usage: 0x10 | 0x01,
            viewFormats: ['rgba8unorm-srgb'],
          });
        },
        unconfigure() {},
        getCurrentTexture() {
          if (texture === undefined) throw new Error('transparent Dawn surface is not configured');
          return texture;
        },
      };
    },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    getTexture: () => {
      if (texture === undefined) throw new Error('transparent Dawn surface texture unavailable');
      return texture;
    },
  };
}
