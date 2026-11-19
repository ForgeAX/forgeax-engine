/** Offscreen canvas whose swap texture is readable; `configure` hands over the device. */
export function offscreenTarget(width: number, height: number) {
  let device: GPUDevice | undefined;
  let texture: GPUTexture | undefined;
  const errors: string[] = [];
  const onGpuError = (event: Event) => {
    if (errors.length < 8)
      errors.push((event as GPUUncapturedErrorEvent).error.message.split('\n')[0] ?? '');
  };
  function unconfigure() {
    device?.removeEventListener('uncapturederror', onGpuError);
    texture?.destroy();
    texture = undefined;
  }
  return {
    errors,
    canvas: {
      width,
      height,
      getContext: () => ({
        configure(options: GPUCanvasConfiguration) {
          unconfigure();
          options.device.addEventListener('uncapturederror', onGpuError);
          device = options.device;
          texture = options.device.createTexture({
            size: [width, height],
            format: options.format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
            viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
          });
        },
        unconfigure,
        getCurrentTexture: () => texture,
      }),
      addEventListener() {},
      removeEventListener() {},
    },
    async read(): Promise<Uint8Array> {
      const source = texture;
      if (device === undefined || source === undefined)
        throw new Error('render target was never configured');
      const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
      const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer(
        { texture: source },
        { buffer, bytesPerRow, rowsPerImage: height },
        [width, height, 1],
      );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const padded = new Uint8Array(buffer.getMappedRange().slice(0));
      buffer.unmap();
      buffer.destroy();
      const bgra = source.format.startsWith('bgra');
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const s = y * bytesPerRow + x * 4;
          const o = (y * width + x) * 4;
          rgba[o] = padded[s + (bgra ? 2 : 0)] as number;
          rgba[o + 1] = padded[s + 1] as number;
          rgba[o + 2] = padded[s + (bgra ? 0 : 2)] as number;
          rgba[o + 3] = 255;
        }
      return rgba;
    },
    /** Retire the target and its device; Dawn keeps the process alive while a device lives. */
    async destroy() {
      const previous = device;
      unconfigure();
      device = undefined;
      if (previous === undefined) return;
      previous.destroy();
      await previous.queue.onSubmittedWorkDone().catch(() => undefined);
    },
  };
}
