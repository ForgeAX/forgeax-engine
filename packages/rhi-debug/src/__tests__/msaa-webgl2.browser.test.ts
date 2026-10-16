import { ensureReady, rhi } from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';
import { wrap } from '../recorder';

// Promoting a WebGL2 MSAA attachment to COPY/TEXTURE_BINDING moved it off the
// multisampled renderbuffer path into glow's texStorage2DMultisample panic, and
// wgpu-wasm rejected every color attachment carrying a resolveTarget.
it('keeps WebGL2 multisampled attachments renderable under the recorder', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  try {
    await ensureReady();
    const recorder = wrap(rhi);
    const adapter = (await recorder.requestAdapter(undefined, canvas)).unwrap();
    // The renderer always requests this feature for its depth targets.
    const device = (
      await adapter.requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
    ).unwrap();
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    // Mirrors the MSAA attachments of render/targets/physical.ts.
    const descriptor = {
      size: { width: 4, height: 4, depthOrArrayLayers: 1 },
      mipLevelCount: 1,
      sampleCount: 4,
      dimension: '2d',
      usage: 0x10,
    } as const;
    const viewRange = { dimension: '2d', baseArrayLayer: 0, arrayLayerCount: 1 } as const;
    const color = device.createTexture({ ...descriptor, format: 'rgba8unorm' }).unwrap();
    const resolve = device
      .createTexture({ ...descriptor, sampleCount: 1, format: 'rgba8unorm' })
      .unwrap();
    const depth = device.createTexture({ ...descriptor, format: 'depth32float-stencil8' }).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: device.createTextureView(color, viewRange).unwrap(),
            resolveTarget: device.createTextureView(resolve, viewRange).unwrap(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          },
        ],
        depthStencilAttachment: {
          view: device.createTextureView(depth, viewRange).unwrap(),
          depthClearValue: 1,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'store',
        },
      })
      .end();
    const submitted = device.queue.submit([encoder.finish().unwrap()]);
    expect(submitted.ok).toBe(true);
    await device.queue.onSubmittedWorkDone();
    device.destroyTexture(depth).unwrap();
    device.destroyTexture(resolve).unwrap();
    device.destroyTexture(color).unwrap();
  } finally {
    canvas.remove();
  }
}, 60_000);
