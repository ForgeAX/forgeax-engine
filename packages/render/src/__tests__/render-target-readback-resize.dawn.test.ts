import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RhiCommandEncoder, RhiDevice } from '@forgeax/engine-rhi';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as backend from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { createRenderTargetHost } from '../assembly/render-target-host';
import type { RenderTargetDescriptor } from '../targets/contracts';
import type { RenderTargetPhysical } from '../targets/physical';

function value<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown },
): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function clear(
  encoder: RhiCommandEncoder,
  physical: RenderTargetPhysical,
  color: [number, number, number, number],
) {
  const view = physical.layerViews[0];
  if (view === undefined) throw new Error('Missing cube face');
  const pass = encoder.beginRenderPass({
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: color }],
  });
  pass.end();
}

async function submitted(
  device: RhiDevice,
  host: ReturnType<typeof createRenderTargetHost>,
  target: Parameters<typeof host.markTargetSubmitted>[0],
  physical: RenderTargetPhysical,
  encoder: RhiCommandEncoder,
  frameId: number,
) {
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  host.markTargetSubmitted(target, physical);
  const completed = device.queue
    .onSubmittedWorkDone()
    .then(() => ({ ok: true as const, value: undefined }));
  host.onFrameSubmitted(completed, { frameId, deviceGeneration: 0 });
  await completed;
}

it('keeps the accepted 64px pixels for their ticket while a 32px candidate is submitted', async () => {
  const recorder = attachRecorder(backend).unwrap();
  const device = (
    await (
      await recorder.backend.rhi.requestAdapter()
    )
      .unwrap()
      .requestDevice({ requiredFeatures: ['depth32float-stencil8'] })
  ).unwrap();
  const host = createRenderTargetHost({ getDevice: () => device });
  const descriptor: RenderTargetDescriptor = {
    shape: 'cube' as const,
    width: 64,
    height: 64,
    format: 'rgba8unorm' as const,
    mipLevels: 1,
    sampleCount: 1 as const,
    sampled: true,
    readback: true,
  };
  const target = value(host.createRenderTarget(descriptor));
  host.beginFrame();
  const accepted = host.getPhysicalTarget(target);
  if (accepted === undefined) throw new Error('Missing accepted target');
  const first = device.createCommandEncoder({ label: 'accepted-red-64' }).unwrap();
  clear(first, accepted, [1, 0, 0, 1]);
  await submitted(device, host, target, accepted, first, 1);
  const ticket = value(host.requestTargetReadback(target, { mipLevel: 0, layer: 0 }));
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  try {
    value(host.resizeRenderTarget(target, { ...descriptor, width: 32, height: 32 }));
    const candidate = host.getPhysicalTarget(target);
    if (candidate === undefined) throw new Error('Missing resized candidate');
    const second = device
      .createCommandEncoder({ label: 'candidate-blue-32-with-accepted-readback' })
      .unwrap();
    clear(second, candidate, [0, 0, 1, 1]);
    host.encodePendingReadbacks(second, [{ target, layer: 0 }]);
    await submitted(device, host, target, candidate, second, 2);
    const old = value(
      await host.observeTargetReadbacks({ frameId: 2, deviceGeneration: 0 }, [ticket]),
    );
    expect(Array.from(old[0]?.bytes.subarray(0, 4) ?? [])).toEqual([255, 0, 0, 255]);
    const fresh = value(host.requestTargetReadback(target, { mipLevel: 0, layer: 0 }));
    const third = device.createCommandEncoder({ label: 'accepted-blue-32-readback' }).unwrap();
    host.encodePendingReadbacks(third, [{ target, layer: 0 }]);
    await submitted(device, host, target, candidate, third, 3);
    const current = value(
      await host.observeTargetReadbacks({ frameId: 3, deviceGeneration: 0 }, [fresh]),
    );
    expect(Array.from(current[0]?.bytes.subarray(0, 4) ?? [])).toEqual([0, 0, 255, 255]);
  } finally {
    const directory =
      process.env.FORGEAX_PARITY_EVIDENCE_DIR ??
      'artifacts/rendering-parity/render-target-readback-resize';
    mkdirSync(directory, { recursive: true });
    const boundary = await recorder.frameBoundary();
    const artifact = await capture;
    if (artifact.ok) {
      writeFileSync(resolve(directory, 'frame.rhitape'), artifact.value.bytes);
      writeFileSync(
        resolve(directory, 'capture.json'),
        JSON.stringify(
          { digest: artifact.value.digest, byteLength: artifact.value.byteLength, boundary },
          null,
          2,
        ),
      );
    } else
      writeFileSync(
        resolve(directory, 'capture-error.json'),
        JSON.stringify({ artifact, boundary }, null, 2),
      );
    host.dispose();
    await recorder.dispose();
  }
});
