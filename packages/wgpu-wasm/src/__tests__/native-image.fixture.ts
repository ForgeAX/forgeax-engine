import { commands } from 'vitest/browser';
import type * as CanonicalWgpu from '../../pkg/wgpu_wasm';
import type { NativeWgpuInitializer } from '../native-host';

declare module 'vitest/browser' {
  interface BrowserCommands {
    prepareNativeWgpuModule(): Promise<string>;
  }
}

export const TOP = [220, 30, 60, 255];
export const BOTTOM = [20, 200, 90, 255];

export async function nativeImageFixture(sourceKind: 'html' | 'offscreen') {
  const code = await commands.prepareNativeWgpuModule();
  const moduleUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  const native: typeof CanonicalWgpu & NativeWgpuInitializer = await import(
    /* @vite-ignore */ moduleUrl
  );
  URL.revokeObjectURL(moduleUrl);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const source =
    sourceKind === 'html' ? document.createElement('canvas') : new OffscreenCanvas(4, 4);
  source.width = source.height = 4;
  const source2d = source.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (source2d === null) throw new Error('Actual 2D canvas is required');
  source2d.fillStyle = `rgb(${TOP.slice(0, 3).join(',')})`;
  source2d.fillRect(0, 0, 4, 2);
  source2d.fillStyle = `rgb(${BOTTOM.slice(0, 3).join(',')})`;
  source2d.fillRect(0, 2, 4, 2);

  const bytes = new Uint8Array(
    await (await fetch(new URL('../../pkg/wgpu_wasm_bg.wasm', import.meta.url))).arrayBuffer(),
  );
  await native.initializeNativeWgpu({
    surfaces: [canvas],
    readWasm: async () => bytes,
    instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
  });
  const instance = await native.RhiWgpuInstance.create();
  const adapter = await instance.requestAdapterWithCanvas(canvas);
  if (!(adapter instanceof native.RhiWgpuAdapter)) throw new Error(String(adapter));
  const device = await adapter.requestDevice({});
  const queue = device.queue;
  const color = device.createTexture({
    size: { width: 4, height: 4, depthOrArrayLayers: 1 },
    format: 'rgba8unorm',
    usage: 0x01 | 0x02 | 0x04 | 0x10,
  });
  const readback = device.createBuffer({ size: 1024, usage: 0x01 | 0x08 });
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Actual WebGL2 is required');
  return {
    queue,
    gl,
    copy(flipY: boolean) {
      queue.copyExternalImageToTexture(
        source,
        0,
        0,
        flipY,
        color,
        0,
        0,
        0,
        0,
        0,
        false,
        false,
        4,
        4,
        1,
      );
    },
    async read() {
      const encoder = device.createCommandEncoder({});
      encoder.copyTextureToBuffer(color, 0, 0, 0, 0, 0, readback, 0n, 256, 4, 4, 4, 1);
      const command = encoder.finish();
      encoder.free();
      queue.submit([command]);
      await readback.mapAsync(1);
      try {
        const pixels = new Uint8Array(readback.getMappedRange());
        return {
          top: [...pixels.slice(0, 4)],
          bottom: [...pixels.slice(3 * 256, 3 * 256 + 4)],
        };
      } finally {
        readback.unmap();
      }
    },
    dispose() {
      readback.destroy();
      readback.free();
      color.destroy();
      color.free();
      queue.free();
      device.free();
      adapter.free();
      instance.free();
    },
  };
}
