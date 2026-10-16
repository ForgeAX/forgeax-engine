import { buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
} from '../../raytracing/card-lookup';
import { createSdfQuery, SdfQueryStatus } from '../../raytracing/sdf-query';
import { createSurfaceCapture } from '../../raytracing/surface-cards';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeIndices as indices, sdfCubePositions as positions } from './sdf-cards.geometry';

/** Real raster -> sampled SDF -> lookup; shared by Browser, Dawn and the Metal probe. */
export async function verifyVisibilityCards(
  fixture: SdfCardsFixture,
  save?: (tape: Uint8Array, hits: Uint8Array, lookup: Uint8Array) => Promise<void>,
) {
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.25,
      triangleSidedness: Array(12).fill(0),
    })
  ).unwrap();
  const instance = {
    instanceId: 7,
    geometryId: 9,
    mask: 255,
    positions,
    indices,
    transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
  const source = {
    instance,
    layout: {
      ...fixture.layout,
      cards: [
        {
          // Asymmetric non-binary projection reduced from the failing GPU capture.
          origin: [14.39926528930664, 12.365679740905762, -9.61166000366211] as const,
          u: [0, 0, 1] as const,
          v: [-1, 0, 0] as const,
          n: [0, 1, 0] as const,
          width: 18.604270935058594,
          height: 29.766834259033203,
          depth: 14.883417129516602,
        },
      ],
    },
    sections: [
      { indexOffset: 0, indexCount: indices.length, material: { id: 0, ...fixture.card } },
    ],
  };
  const rays = [-0.73, 0.04208417, 0.61].flatMap((x) =>
    [-0.68, -0.1666894, 0.57].map((y) => ({
      origin: [x, 3, y] as const,
      direction: [0, -1, 0] as const,
      tMin: 0,
      tMax: 10,
      mask: 255,
    })),
  );
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const real = (device as typeof device & { readonly _realDevice: typeof device })._realDevice;
  const native = webgpu._internal_getRawDevice(real);
  if (!native) throw Error('Missing WebGPU device');
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const cards = (
    await createSurfaceCapture(device, recorder.backend.createShaderModule, [source], {
      kind: 'cards',
      resolution: 64,
    })
  ).unwrap();
  const query = (
    await createSdfQuery(
      device,
      recorder.backend.createShaderModule,
      [{ ...instance, field }],
      rays,
    )
  ).unwrap();
  const lookup = (
    await createSdfCardLookup(device, recorder.backend.createShaderModule, query, cards, [source])
  ).unwrap();
  const read = async (buffer: typeof lookup.buffer, size: number) => {
    const stage = device.createBuffer({ size, usage: 9 }).unwrap();
    try {
      const e = device.createCommandEncoder({}).unwrap();
      e.copyBufferToBuffer(buffer, 0, stage, 0, size);
      device.queue.submit([e.finish().unwrap()]).unwrap();
      const map = (await stage.mapAsync(1)).unwrap();
      const bytes = new Uint8Array(map.getMappedRange().unwrap()).slice();
      map.unmap();
      return bytes;
    } finally {
      device.destroyBuffer(stage);
    }
  };
  let tapeBytes: Uint8Array, hitBytes: Uint8Array, lookupBytes: Uint8Array;
  try {
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    cards.record(encoder).unwrap();
    query.record(encoder).unwrap();
    lookup.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await pending).unwrap().bytes;
    hitBytes = await read(query.buffers.hits, rays.length * 64);
    lookupBytes = await read(lookup.buffer, rays.length * CARD_LOOKUP_STRIDE);
    await save?.(tapeBytes, hitBytes, lookupBytes);
    const hits = new DataView(hitBytes.buffer),
      mapped = new DataView(lookupBytes.buffer);
    for (let i = 0; i < rays.length; i++) {
      if (
        hits.getUint32(i * 64, true) !== SdfQueryStatus.visibilityHit ||
        hits.getFloat32(i * 64 + 20, true) !== 0
      )
        throw Error(`Ray ${i} must reach a sampled visibility hit with zero geometric allowance`);
      if (mapped.getUint32(i * CARD_LOOKUP_STRIDE, true) !== CardLookupStatus.mapped)
        throw Error(`Interior visibility hit ${i} was not mapped to its raster card`);
      for (const [lane, expected] of [0.8, 0.4, 0.2, 0.65].entries())
        if (
          Math.abs(mapped.getFloat32(i * CARD_LOOKUP_STRIDE + 16 + lane * 4, true) - expected) >
          0.001
        )
          throw Error(`Ray ${i} lost shared material channel ${lane}`);
    }
    // Faults preserve hit status and zero allowance. No tolerance may admit
    // outside silhouettes, separated depth or the opposite geometric orientation.
    for (const [offset, value] of [
      [32, 30],
      [36, 5],
      [52, -1],
    ] as const) {
      const changed = hitBytes.slice();
      new DataView(changed.buffer).setFloat32(offset, value, true);
      device.queue.writeBuffer(query.buffers.hits, 0, changed).unwrap();
      const e = device.createCommandEncoder({}).unwrap();
      lookup.record(e).unwrap();
      device.queue.submit([e.finish().unwrap()]).unwrap();
      const rejected = await read(lookup.buffer, rays.length * CARD_LOOKUP_STRIDE);
      if (new DataView(rejected.buffer).getUint32(0, true) !== CardLookupStatus.unmapped)
        throw Error(`Invalid card association survived fault at byte ${offset}`);
    }
  } finally {
    lookup.dispose();
    query.dispose();
    cards.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  if (model.works.length !== 3 || model.unseededResources.length !== 0)
    throw Error('Visibility/card tape must contain the complete raster and query chain');
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(fresh);
  raw?.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [workIndex, binding, expected] of [
      [1, 3, hitBytes],
      [2, 2, lookupBytes],
    ] as const) {
      const id = model.works[workIndex]?.bindings.find((b) => b.binding === binding)?.resourceId;
      if (!id) throw Error('Missing production work binding');
      const before = (await replay.readResourceAtWork(id, 0)).unwrap().bytes;
      if (before.some((v) => v !== 0)) throw Error('Unexecuted query/lookup produced data');
      const actual = (await replay.readResourceAtWork(id, workIndex)).unwrap().bytes;
      if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i]))
        throw Error(`Visibility/card replay differs at work ${workIndex}`);
    }
  } finally {
    (await replay.dispose()).unwrap();
    raw?.destroy();
  }
  if (errors.length) throw Error(errors.join('\n'));
  return { rays: rays.length, mapped: rays.length, faultRejections: 3, replayDifferentBytes: 0 };
}
