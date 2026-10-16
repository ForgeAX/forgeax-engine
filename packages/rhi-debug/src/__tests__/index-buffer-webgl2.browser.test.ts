/// <reference types="@webgpu/types" />

import { ensureReady, rhi } from '@forgeax/engine-rhi-wgpu';
import { expect, it } from 'vitest';
import { wrap } from '../recorder';

it('seeds a WebGL2 INDEX buffer from recorded uploads when GPU copy returns zeros', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  document.body.append(canvas);
  try {
    await ensureReady();
    const recorder = wrap(rhi);
    const adapter = (await recorder.requestAdapter(undefined, canvas)).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    expect(device.caps.backendKind).toBe('wgpu-webgl2');
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const buffer = device
      .createBuffer({
        label: 'captured-index',
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      .unwrap();
    device.queue.writeBuffer(buffer, 0, indices).unwrap();

    recorder.arm(1).unwrap();
    (await recorder.snapshotAllLiveResources()).unwrap();
    recorder.onFrameEnd();
    const tape = recorder.getTape();
    if (tape === undefined || 'code' in tape) throw new Error('capture did not produce a tape');
    const create = tape.events.find((event) => event.kind === 'createBuffer');
    if (create?.kind !== 'createBuffer') throw new Error('INDEX buffer has no create event');
    const seed = tape.events.find(
      (event) => event.kind === 'initialData' && event.handleId === create.handleId,
    );
    if (seed?.kind !== 'initialData') throw new Error('INDEX buffer has no initialData event');
    const bytes = tape.blobPool.get(seed.dataHash);
    if (bytes === undefined) throw new Error('INDEX seed blob is absent');
    expect(Array.from(new Uint32Array(bytes))).toEqual(Array.from(indices));

    const encoder = device.createCommandEncoder().unwrap();
    encoder.clearBuffer(buffer, 0, indices.byteLength);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    recorder.arm(1).unwrap();
    expect(await recorder.snapshotAllLiveResources()).toMatchObject({
      ok: false,
      error: { code: 'capture-snapshot-failed' },
    });
    device.destroyBuffer(buffer).unwrap();
  } finally {
    canvas.remove();
  }
}, 60_000);
