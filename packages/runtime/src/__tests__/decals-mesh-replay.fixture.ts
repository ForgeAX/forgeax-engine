import { halfFloat } from '@forgeax/engine-math';
import type { RhiCanvasTarget } from '@forgeax/engine-rhi';
import {
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
  type RecordableBackend,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';

/** Inspect the actual biased mesh draw, replay its lighting target, then remove it. */
export async function verifyMeshDecalReplay(
  bytes: Uint8Array,
  live: readonly number[],
  save: (name: string, bytes: Uint8Array) => void | Promise<void>,
  replayHost: {
    backend: RecordableBackend;
    compatibleSurface?: RhiCanvasTarget | undefined;
  } = { backend: webgpu },
) {
  const tape = decodeTape(bytes).unwrap();
  const model = buildFrameModel(tape);
  const mesh = model.works.find((work) => {
    const descriptor = work.pipeline.descriptor as
      | { desc?: { depthStencil?: { depthBias?: number } } }
      | undefined;
    // The authored decal pulls toward the camera with -2.  Reverse-Z flips
    // the hardware depth-bias direction, so the recorded pipeline carries +2.
    return descriptor?.desc?.depthStencil?.depthBias === 2;
  });
  if (!mesh) throw new Error('missing biased mesh decal draw');
  // A fresh device on the captured backend isolates recorder fidelity from
  // implementation-dependent UNORM filtering and blending precision.
  const { backend, compatibleSurface } = replayHost;
  const adapter = (await backend.rhi.requestAdapter(undefined, compatibleSurface)).unwrap();
  const device = (
    await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
  ).unwrap();
  const replay = (
    await openReplay(tape, { device, createShaderModule: backend.createShaderModule })
  ).unwrap();
  try {
    const inspection = (
      await replay.inspectWork(mesh.workIndex, ['pipeline', 'bindings', 'pixels'])
    ).unwrap();
    const attachment = inspection.attachment;
    if (!attachment || attachment.format !== 'rgba16float' || attachment.width === undefined)
      throw new Error('missing mesh decal HDR attachment');
    const pixels = Array.from(
      new Uint16Array(
        attachment.bytes.buffer,
        attachment.bytes.byteOffset,
        attachment.bytes.byteLength / 2,
      ),
      halfFloat.f16ToF32,
    );
    expect(pixels.length).toBe(live.length);
    const maximum = pixels.reduce(
      (max, value, i) => Math.max(max, Math.abs(value - (live[i] as number))),
      0,
    );
    const worst = pixels.findIndex((value, i) => Math.abs(value - (live[i] as number)) === maximum);
    await save('mesh-live-hdr.f32', new Uint8Array(Float32Array.from(live).buffer));
    await save('mesh-replay-hdr.f32', new Uint8Array(Float32Array.from(pixels).buffer));
    await save(
      'mesh-replay-difference.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            replayBackend: device.caps.backendKind,
            workIndex: mesh.workIndex,
            eventIndex: mesh.eventIndex,
            maximum,
            worst: {
              x: Math.floor(worst / 4) % attachment.width,
              y: Math.floor(worst / 4 / attachment.width),
              channel: worst % 4,
              live: live[worst],
              replay: pixels[worst],
            },
            pipeline: inspection.pipeline,
            bindings: inspection.bindings,
            unseededResources: model.unseededResources,
          },
          null,
          2,
        ),
      ),
    );
    expect(maximum).toBeLessThanOrEqual(0.002);
    const removed = encodeTape(
      {
        ...tape,
        events: tape.events.map((event, i) => {
          if (i !== mesh.eventIndex) return event;
          if (event.kind === 'drawIndexed') return { ...event, indexCount: 0 };
          if (event.kind === 'draw') return { ...event, vertexCount: 0 };
          throw new Error('expected direct mesh decal draw');
        }),
      },
      { compression: 'gzip' },
    ).unwrap();
    const falsifier = (
      await openReplay(decodeTape(removed).unwrap(), {
        device,
        createShaderModule: backend.createShaderModule,
      })
    ).unwrap();
    try {
      const without = (await falsifier.inspectWork(mesh.workIndex, ['pixels'])).unwrap();
      expect(equalBytes(without.attachment?.bytes, attachment.bytes)).toBe(false);
    } finally {
      (await falsifier.dispose()).unwrap();
    }
    await save(
      'mesh-inspection.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            replayBackend: device.caps.backendKind,
            workIndex: mesh.workIndex,
            eventIndex: mesh.eventIndex,
            pipeline: inspection.pipeline,
            bindings: inspection.bindings,
            maxLiveReplayError: maximum,
            unseededResources: model.unseededResources,
          },
          null,
          2,
        ),
      ),
    );
  } finally {
    (await replay.dispose()).unwrap();
  }
}
