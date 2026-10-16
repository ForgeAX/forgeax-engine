import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import type { RaySurfaceInstance } from '../../raytracing/attributes';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
} from '../../raytracing/card-lookup';
import type { ReferenceRay } from '../../raytracing/scene';
import { createSdfQuery, SdfQueryStatus } from '../../raytracing/sdf-query';
import { CARD_PLANES, createSurfaceCapture } from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeIndices as indices, sdfCubePositions as positions } from './sdf-cards.geometry';
export const sdfCubeInstance: RaySurfaceInstance = {
  instanceId: 7,
  geometryId: 9,
  materialId: 0,
  mask: 255,
  positions,
  indices,
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  uvSets: [[0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]],
};
export async function verifySdfCards(fixture: SdfCardsFixture) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(device),
    errors: string[] = [];
  raw?.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const field = {
    ...fixture.field,
    bricks: Uint32Array.from(fixture.field.bricks),
    values: Float32Array.from(fixture.field.values),
  };
  const ray = (
    origin: ReferenceRay['origin'],
    direction: ReferenceRay['direction'],
  ): ReferenceRay => ({ origin, direction, tMin: 0, tMax: 20, mask: 255 });
  const rays = [ray([0, 0, 3], [0, 0, -1]), ray([3, 3, 3], [0, 0, -1]), ray([0, 0, 0], [0, 0, 1])];
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      rays.push(ray([((x + 0.5) / 32 - 0.5) * 3.6, ((y + 0.5) / 32 - 0.5) * 3.6, 3], [0, 0, -1]));
  const query = (
    await createSdfQuery(
      device,
      recorder.backend.createShaderModule,
      [{ ...sdfCubeInstance, field }],
      rays,
    )
  ).unwrap();
  const cards = (
    await createSurfaceCapture(device, recorder.backend.createShaderModule, [
      {
        instance: sdfCubeInstance,
        layout: fixture.layout,
        sections: [
          {
            indexOffset: 0,
            indexCount: sdfCubeInstance.indices.length,
            material: { id: 0, ...fixture.card },
          },
        ],
      },
    ])
  ).unwrap();
  const source = {
    instance: sdfCubeInstance,
    layout: fixture.layout,
    sections: [
      {
        indexOffset: 0,
        indexCount: sdfCubeInstance.indices.length,
        material: { id: 0, ...fixture.card },
      },
    ],
  };
  const lookup = (
    await createSdfCardLookup(device, recorder.backend.createShaderModule, query, cards, [source])
  ).unwrap();
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const encoder = device.createCommandEncoder({}).unwrap();
  cards.record(encoder).unwrap();
  query.record(encoder).unwrap();
  lookup.record(encoder).unwrap();
  device.queue.submit([encoder.finish().unwrap()]).unwrap();
  const live = await readBuffer(device, query.buffers.hits, rays.length * 64);
  const mapped = await readBuffer(device, lookup.buffer, rays.length * CARD_LOOKUP_STRIDE);
  const planes = await readCardPlanes(device, cards);
  (await recorder.frameBoundary()).unwrap();
  const tapeBytes = (await capture).unwrap().bytes;
  const ints = new Uint32Array(live.buffer),
    floats = new Float32Array(live.buffer);
  expect(ints[0]).toBe(SdfQueryStatus.surfaceBand);
  expect(ints[1]).toBe(7);
  expect(Math.abs((floats[4] ?? 0) - 2)).toBeLessThan(floats[5] ?? 0);
  expect(ints[16]).toBe(SdfQueryStatus.miss);
  expect(ints[32]).toBe(SdfQueryStatus.insideStart);
  expect(Array.from(floats.slice(44, 47))).toEqual([0, 0, 0]);
  for (let i = 3; i < rays.length; i++) {
    const r = rays[i];
    assert(r);
    if (Math.abs(r.origin[0]) <= 1 && Math.abs(r.origin[1]) <= 1)
      expect(ints[i * 16]).toBe(SdfQueryStatus.surfaceBand);
    if (ints[i * 16] === SdfQueryStatus.surfaceBand) {
      const q = [floats[i * 16 + 8] ?? 0, floats[i * 16 + 9] ?? 0, floats[i * 16 + 10] ?? 0].map(
        (v) => Math.abs(v) - 1,
      );
      const distance = Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(Math.max(...q), 0);
      expect(Math.abs(distance)).toBeLessThan(floats[i * 16 + 5] ?? 0);
    }
  }
  expect(errors).toEqual([]);
  const mappedInts = new Uint32Array(mapped.buffer),
    mappedFloats = new Float32Array(mapped.buffer);
  expect(mappedInts[0]).toBe(CardLookupStatus.mapped);
  expect(mappedInts[CARD_LOOKUP_STRIDE / 4]).toBe(CardLookupStatus.notSurface);
  expect(mappedInts[CARD_LOOKUP_STRIDE / 2]).toBe(CardLookupStatus.notSurface);
  // These are linear shared Standard Surface values in the unlit card.
  for (const [lane, expected] of [
    [4, 0.8],
    [5, 0.4],
    [6, 0.2],
    [7, 0.65],
    [10, 1],
  ])
    expect(mappedFloats[lane ?? 0]).toBeCloseTo(expected ?? 0, 3);
  for (let i = 0; i < 6; i++) {
    const offset =
      ((Math.floor(i / (cards.width / 16)) * 16 + 8) * cards.width +
        (i % (cards.width / 16)) * 16 +
        8) *
      8;
    expect(half(planes[3] ?? new Uint8Array(), offset + 6)).toBe(1);
    expect(half(planes[0] ?? new Uint8Array(), offset)).toBeCloseTo(0.8, 3);
    const normal = [0, 0, 0];
    normal[Math.floor(i / 2)] = i % 2 === 0 ? 1 : -1;
    for (const pair of [0, 4]) {
      const decoded = decodeNormal(
        half(planes[1] ?? new Uint8Array(), offset + pair),
        half(planes[1] ?? new Uint8Array(), offset + pair + 2),
      );
      for (let c = 0; c < 3; c++) expect(decoded[c]).toBeCloseTo(normal[c] ?? 0, 3);
    }
  }
  lookup.dispose();
  query.dispose();
  cards.dispose();
  (await recorder.dispose()).unwrap();
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works.length).toBe(8);
  const last = model.works[6];
  assert(last);
  const resource = last.bindings.find((b) => b.binding === 3)?.resourceId;
  assert(resource);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    expect(Array.from((await replay.readResourceAtWork(resource, 6)).unwrap().bytes)).toEqual(
      Array.from(live),
    );
    const lookupResource = model.works[7]?.bindings.find((b) => b.binding === 2)?.resourceId;
    assert(lookupResource);
    expect(Array.from((await replay.readResourceAtWork(lookupResource, 7)).unwrap().bytes)).toEqual(
      Array.from(mapped),
    );
    const validityResource = model.works[7]?.bindings.find((b) => b.binding === 6)?.resourceId;
    assert(validityResource);
    const prefix = (await replay.readResourceAtWork(validityResource, 0)).unwrap().bytes;
    expect(half(prefix, (8 * cards.width + 8) * 8 + 6)).toBe(1);
    expect(half(prefix, ((16 + 8) * cards.width + 2 * 16 + 8) * 8 + 6)).toBe(0);
    for (let i = 0; i < 4; i++) {
      const textureResource = model.works[7]?.bindings.find((b) => b.binding === i + 3)?.resourceId;
      assert(textureResource);
      expect(
        Array.from((await replay.readResourceAtWork(textureResource, 7)).unwrap().bytes),
      ).toEqual(Array.from(planes[i] ?? []));
    }
  } finally {
    (await replay.dispose()).unwrap();
  }
  return { tape: tapeBytes, live, mapped, planes };
}

export async function readCardPlanes(
  device: import('@forgeax/engine-rhi').RhiDevice,
  cards: import('../../raytracing/surface-cards').SurfaceCapture,
) {
  const width = cards.width,
    rowBytes = width * 8,
    stride = Math.ceil(rowBytes / 256) * 256;
  const planes: Uint8Array[] = [];
  for (const name of CARD_PLANES) {
    const buffer = device.createBuffer({ size: stride * cards.height, usage: 12 }).unwrap();
    try {
      const copy = device.createCommandEncoder({}).unwrap();
      copy.copyTextureToBuffer(
        { texture: cards.textures[name] },
        { buffer, bytesPerRow: stride },
        { width, height: cards.height },
      );
      device.queue.submit([copy.finish().unwrap()]).unwrap();
      const padded = await readBuffer(device, buffer, stride * cards.height),
        bytes = new Uint8Array(rowBytes * cards.height);
      for (let row = 0; row < cards.height; row++)
        bytes.set(padded.subarray(row * stride, row * stride + rowBytes), row * rowBytes);
      planes.push(bytes);
    } finally {
      device.destroyBuffer(buffer);
    }
  }
  return planes;
}
export function half(bytes: Uint8Array, offset: number): number {
  const u = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true),
    e = (u >> 10) & 31,
    m = u & 1023;
  return (
    (u & 32768 ? -1 : 1) *
    (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15))
  );
}

export function decodeNormal(x: number, y: number): number[] {
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) [x, y] = [(1 - Math.abs(y)) * (x < 0 ? -1 : 1), (1 - Math.abs(x)) * (y < 0 ? -1 : 1)];
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
