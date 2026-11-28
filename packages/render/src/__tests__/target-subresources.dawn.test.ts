import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import { renderTargetMipPhysical } from '../targets/physical';

it.each([
  1, 4,
] as const)('writes and reads HDR cube face/mip subresources with %i samples for 60 completed submissions', async (sampleCount) => {
  const recorder = attachRecorder(backend).unwrap();
  const device = (
    await (
      await recorder.backend.rhi.requestAdapter()
    )
      .unwrap()
      .requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const host = createRenderTargetHost({ getDevice: () => device });
  const target = host.createRenderTarget({
    shape: 'cube',
    width: 16,
    height: 16,
    format: 'rgba16float',
    mipLevels: 'full',
    sampleCount,
    sampled: true,
    readback: true,
  });
  if (!target.ok) throw target.error;
  const record = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  try {
    for (let frame = 1; frame <= 60; frame++) {
      host.beginFrame();
      const physical = host.getPhysicalTarget(target.value);
      if (physical === undefined) throw new Error('missing target physical');
      const mip = frame % 2 === 0 ? 2 : 0,
        layer = frame % 2 === 0 ? 5 : 0;
      const selected = renderTargetMipPhysical(physical, mip);
      if (!selected.ok) throw selected.error;
      const ticket = host.requestTargetReadback(target.value, { mipLevel: mip, layer });
      if (!ticket.ok) throw ticket.error;
      const attachment = selected.value;
      const color = attachment.layerViews[layer],
        resolved = attachment.resolveLayerViews[layer];
      if (color === undefined || resolved === undefined)
        throw new Error('missing mip face attachments');
      const encoder = device.createCommandEncoder({ label: `face-mip-${frame}` }).unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: color,
            ...(sampleCount === 4 ? { resolveTarget: resolved } : {}),
            clearValue: { r: 2, g: 0.5, b: 0.25, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
      host.stageRenderTargetWrite({ target: target.value, physical, layer, mipLevel: mip });
      host.encodePendingReadbacks(encoder);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      host.markTargetSubmitted(target.value, physical);
      const completed = device.queue
        .onSubmittedWorkDone()
        .then(() => ({ ok: true as const, value: undefined }));
      const receipt = { frameId: frame, deviceGeneration: 0 };
      host.onFrameSubmitted(completed, receipt);
      await completed;
      const observed = await host.observeTargetReadbacks(receipt, [ticket.value]);
      if (!observed.ok) throw observed.error;
      const bytes = observed.value[0]?.bytes;
      if (bytes === undefined) throw new Error('missing target pixels');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect([0, 2, 4, 6].map((offset) => view.getUint16(offset, true))).toEqual([
        0x4000, 0x3800, 0x3400, 0x3c00,
      ]);
    }
  } finally {
    const directory = resolve(
      process.env.FORGEAX_PARITY_EVIDENCE_DIR ?? 'artifacts/three-target-subresources',
    );
    mkdirSync(directory, { recursive: true });
    (await recorder.frameBoundary()).unwrap();
    const tape = await record;
    if (tape.ok) writeFileSync(resolve(directory, `msaa-${sampleCount}.rhitape`), tape.value.bytes);
    host.dispose();
    await recorder.dispose();
  }
});
