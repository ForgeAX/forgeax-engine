import assert from 'node:assert/strict';
import { create, globals } from '@forgeax/engine-dawn-node';
import { World } from '@forgeax/engine-ecs';
import { registerPropagateTransforms } from '@forgeax/engine-scene';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { completeReadyFrame } from '../../../../scripts/test/ready-render-frame.mjs';
import { emitSmokeReceipt } from '../../../shared/scripts/smoke-receipt.mjs';

/** Shared native GPU host; capability or frame failures fail the smoke. */
export async function createTilemapSmoke(shaderManifestUrl, width = 256, height = 256) {
  Object.assign(globalThis, globals);
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: create([]) }, configurable: true });
  let device, target, format = 'rgba8unorm';
  const errors = [];
  const context = {
    configure(desc) {
      device = desc.device;
      format = desc.format;
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      target = device.createTexture({ size: [width, height], format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        viewFormats: desc.viewFormats ?? [] });
    },
    getCurrentTexture() { return target; },
    unconfigure() {},
  };
  const initialized = await constructRuntimeRendererHost(
    { width, height, getContext: kind => kind === 'webgpu' ? context : null }, {}, { shaderManifestUrl });
  if (!initialized.ok) throw initialized.error;
  const { renderer, assets } = initialized.value;
  renderer.subscribe(event => { if (event.kind === 'error') errors.push(event.error); });
  const world = new World({ assets });
  registerPropagateTransforms(world);
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  let frames = 0;
  return {
    world, assets, renderer,
    async draw(count) {
      for (let i = 0; i < count; i++) {
        world.update(1 / 60).unwrap();
        await completeReadyFrame(() => {
          const receipt = renderer.draw({ leases: [lease], camera: { lease }, environment: { lease } });
          if (!receipt.ok) throw receipt.error;
          return receipt.value;
        });
        frames++;
      }
    },
    async sample(points) {
      assert(device && target);
      const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
      const buffer = device.createBuffer({ size: height * bytesPerRow, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow }, [width, height]);
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(buffer.getMappedRange());
      const result = points.map(([x, y]) => {
        const p = Math.floor(y) * bytesPerRow + Math.floor(x) * 4;
        return [pixels[p + (format.startsWith('bgra') ? 2 : 0)], pixels[p + 1], pixels[p + (format.startsWith('bgra') ? 0 : 2)]];
      });
      buffer.unmap(); buffer.destroy();
      return result;
    },
    color(actual, expected) {
      for (let i = 0; i < 3; i++) assert(Math.abs(actual[i] / 255 - expected[i]) <= 0.05, `pixel ${actual} expected ${expected}`);
    },
    async finish(scope) {
      assert(frames >= 60);
      assert.deepEqual(errors, []);
      const disposed = await renderer.dispose();
      if (!disposed.ok) throw disposed.error;
      target?.destroy();
      console.log(JSON.stringify({ scope, status: 'passed', frames, errors: 0 }));
      emitSmokeReceipt(scope, frames);
    },
  };
}
