import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
} from '../../raytracing/card-lookup';
import type { ReferenceRay } from '../../raytracing/scene';
import { createSdfQuery, SdfQueryStatus } from '../../raytracing/sdf-query';
import { createSurfaceCapture } from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeInstance } from './sdf-cards.fixture';

export async function verifyTwoSidedSdf(fixture: SdfCardsFixture) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  // Recorder adapters wrap handles; observe the actual native device as well.
  const recorded = device as typeof device & { readonly _realDevice: typeof device };
  const raw = webgpu._internal_getRawDevice(recorded._realDevice);
  assert(raw, 'the recorder must expose its real test-owned device');
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const { sheet } = fixture;
  const field = {
    ...sheet.field,
    bricks: Uint32Array.from(sheet.field.bricks),
    values: Float32Array.from(sheet.field.values),
  };
  assert(field.policy.kind === 'two-sided');
  const material = sheet.materials[0];
  assert(material);
  const instance = {
    ...sdfCubeInstance,
    positions: sheet.positions,
    indices: sheet.indices,
    uvSets: [],
  };
  const source = {
    instance,
    layout: sheet.two,
    sections: [
      { indexOffset: 0, indexCount: instance.indices.length, material: { id: 0, ...material } },
    ],
  };
  const rays: ReferenceRay[] = [];
  for (const side of [1, -1])
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++)
        rays.push({
          origin: [((x + 0.5) / 32) * 1.8 - 0.9, ((y + 0.5) / 32) * 1.8 - 0.9, side * 3],
          direction: [0, 0, -side * 2],
          tMin: 0,
          tMax: 3,
          mask: 255,
        });
  rays.push({ origin: [2, 0, 3], direction: [0, 0, -1], tMin: 0, tMax: 4, mask: 255 });
  rays.push({ origin: [0, 0, 3], direction: [0, 0, -1], tMin: 0, tMax: 4, mask: 0 });
  const query = (
    await createSdfQuery(
      device,
      recorder.backend.createShaderModule,
      [{ ...instance, field }],
      rays,
    )
  ).unwrap();
  const cards = (
    await createSurfaceCapture(device, recorder.backend.createShaderModule, [source])
  ).unwrap();
  const lookup = (
    await createSdfCardLookup(device, recorder.backend.createShaderModule, query, cards, [source])
  ).unwrap();
  let tapeBytes: Uint8Array, live: Uint8Array, mapped: Uint8Array;
  try {
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    cards.record(encoder).unwrap();
    query.record(encoder).unwrap();
    lookup.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    // Diagnostic staging copies run after the captured frame, not as render inputs.
    live = await readBuffer(device, query.buffers.hits, rays.length * 64);
    mapped = await readBuffer(device, lookup.buffer, rays.length * CARD_LOOKUP_STRIDE);
  } finally {
    lookup.dispose();
    query.dispose();
    cards.dispose();
    (await recorder.dispose()).unwrap();
    raw?.destroy();
  }
  const words = new Uint32Array(live.buffer),
    values = new Float32Array(live.buffer),
    maps = new Uint32Array(mapped.buffer);
  let maxWorldDistanceError = 0,
    mappedCount = 0;
  for (let i = 0; i < 2048; i++) {
    expect(words[i * 16]).toBe(SdfQueryStatus.surfaceBand);
    const error = Math.abs((values[i * 16 + 4] ?? 0) - 1.5) * 2;
    maxWorldDistanceError = Math.max(maxWorldDistanceError, error);
    expect(error).toBeLessThan(values[i * 16 + 5] ?? 0);
    expect(values[i * 16 + 14]).toBeCloseTo(i < 1024 ? 1 : -1, 4);
    if (maps[i * (CARD_LOOKUP_STRIDE / 4)] === CardLookupStatus.mapped) mappedCount++;
  }
  expect(mappedCount).toBe(2048);
  expect(words[2048 * 16]).toBe(SdfQueryStatus.miss);
  expect(words[2049 * 16]).toBe(SdfQueryStatus.miss);
  expect(errors).toEqual([]);
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.unseededResources).toEqual([]);
  expect(model.works.length).toBe(4);
  const hitResource = model.works[2]?.bindings.find((b) => b.binding === 3)?.resourceId;
  const lookupResource = model.works[3]?.bindings.find((b) => b.binding === 2)?.resourceId;
  assert(hitResource && lookupResource);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const freshRaw = webgpu._internal_getRawDevice(fresh);
  assert(freshRaw, 'fresh replay must expose its real device');
  freshRaw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    expect((await replay.readResource(hitResource)).unwrap().bytes.every((v) => v === 0)).toBe(
      true,
    );
    expect((await replay.readResourceAtWork(hitResource, 2)).unwrap().bytes).toEqual(live);
    expect((await replay.readResourceAtWork(lookupResource, 3)).unwrap().bytes).toEqual(mapped);
  } finally {
    (await replay.dispose()).unwrap();
    freshRaw?.destroy();
  }
  expect(errors).toEqual([]);
  return {
    tape: tapeBytes,
    live,
    mapped,
    metrics: {
      rays: rays.length,
      surfaceBand: 2048,
      mapped: mappedCount,
      miss: 2,
      insideStart: 0,
      maxWorldDistanceError,
      localErrorBound: field.policy.errorBound,
      liveReplayDifferentBytes: 0,
      noWorkOutputNonzeroBytes: 0,
    },
  };
}
