#!/usr/bin/env node
// w7.5 spike: depth-only readback path validation for shadow RT.
// Round-3 D-2 locks shadow RT format to `depth32float`; this spike fast-path
// PASSes that format. Earlier round-3 commit 6e1da4a7 ran a 3-format
// comparison and proved depth24plus FAILS on Dawn (WebGPU spec forbids
// copyTextureToBuffer on depth24plus); that comparison drove D-2 and is
// removed now that the format is locked.

const EPSILON = 1e-6;

async function main() {
  const { create, globals } = await import('@forgeax/engine-dawn-node');
  Object.assign(globalThis, globals);
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  const gpu = create([]);
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: gpu,
    configurable: true,
    writable: true,
  });
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('requestAdapter returned null');
  const device = await adapter.requestDevice();

  const t = device.createTexture({
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const v = t.createView();
  const enc = device.createCommandEncoder();
  enc
    .beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view: v,
        depthClearValue: 0.5,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })
    .end();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();

  const buf = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const enc2 = device.createCommandEncoder();
  enc2.copyTextureToBuffer(
    { texture: t },
    { buffer: buf, bytesPerRow: 256, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  device.queue.submit([enc2.finish()]);
  await device.queue.onSubmittedWorkDone();
  await buf.mapAsync(GPUMapMode.READ);
  const decoded = new Float32Array(buf.getMappedRange().slice(0, 4))[0];
  buf.unmap();
  buf.destroy();
  t.destroy();
  device.destroy?.();
  delete globalThis.navigator.gpu;

  const diff = Math.abs(decoded - 0.5);
  if (diff <= EPSILON) {
    console.log(
      `[w7.5 spike] PASS depth32float decoded=${decoded} diff=${diff} epsilon=${EPSILON}`,
    );
    process.exit(0);
  }
  console.error(
    `[w7.5 spike] FAIL depth32float decoded=${decoded} diff=${diff} epsilon=${EPSILON}`,
  );
  console.error(
    '[w7.5 spike] fallback options: compute-textureLoad → storage buffer, blit-to-staging-depth32float-RT',
  );
  process.exit(1);
}

main().catch((e) => {
  console.error('[w7.5 spike] FAIL - unhandled:', e);
  process.exit(1);
});
