import type { RhiWgpuSurface } from '@forgeax/engine-wgpu-wasm/pkg';

/** The canonical bindgen ABI has free(), not GPUCanvasContext.unconfigure(). */
export type WasmSurface = Pick<RhiWgpuSurface, 'configure' | 'getCurrentTexture' | 'free'> &
  Partial<Pick<RhiWgpuSurface, 'probeSurfacePresentation'>>;

export function ownWasmSurface(create: () => WasmSurface) {
  let surface: WasmSurface | undefined = create();
  return {
    configure(desc: GPUCanvasConfiguration): void {
      surface ??= create();
      surface.configure(desc);
    },
    unconfigure(): void {
      if (surface === undefined) return;
      surface.free();
      surface = undefined;
    },
    getCurrentTexture(): unknown {
      if (surface === undefined) throw new Error('getCurrentTexture: surface is not configured');
      return surface.getCurrentTexture();
    },
    probeSurfacePresentation() {
      return surface?.probeSurfacePresentation?.();
    },
  };
}
