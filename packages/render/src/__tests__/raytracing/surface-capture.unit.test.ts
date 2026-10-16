import { buildMeshCardLayout } from '@forgeax/engine-geometry';
import { createShaderModule } from '@forgeax/engine-rhi-null';
import { rayMaterialContract } from '@forgeax/engine-shader';
import { assert, expect, it, vi } from 'vitest';
import { Materials } from '../../materials';
import {
  createSurfaceCapture,
  prepareSurfaceCapture,
  type SurfaceCaptureSource,
} from '../../raytracing/surface-cards';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { queryTestDevice } from './global-sdf-query-device.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

it('records the same Card draws into a caller-owned pass without ending or submitting it', async () => {
  const device = await queryTestDevice();
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const layout = (await buildMeshCardLayout(sdfCubePositions, sdfCubeIndices)).unwrap();
  const asset = Materials.standard({ baseColor: [0.25, 0.5, 0.75, 1] });
  const capture = (
    await createSurfaceCapture(device, createShaderModule, [
      {
        instance: {
          instanceId: 0,
          geometryId: 0,
          mask: 255,
          transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          positions: sdfCubePositions,
          indices: sdfCubeIndices,
        },
        layout,
        sections: [
          {
            indexOffset: 0,
            indexCount: sdfCubeIndices.length,
            material: {
              id: 0,
              asset,
              program: {
                context: 'card-capture',
                wgsl: '',
                paramSchema: [{ name: 'baseColor', type: 'color', default: [1, 1, 1, 1] }],
                contract: rayMaterialContract(asset),
                sourceClosureDigest: 'null-device-structural-fixture',
              },
            },
          },
        ],
      },
    ])
  ).unwrap();
  expect(capture).toHaveProperty('recordPass');
  const encoder = device.createCommandEncoder({}).unwrap();
  const pass = encoder.beginRenderPass({ colorAttachments: [] });
  const draw = vi.spyOn(pass, 'draw');
  const end = vi.spyOn(pass, 'end');
  const submit = vi.spyOn(device.queue, 'submit');
  const record = vi.spyOn(capture, 'recordPass');
  capture.recordPass(pass).unwrap();
  expect(draw).toHaveBeenCalledTimes(layout.cards.length);
  expect(end).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  pass.end();
  capture.record(encoder).unwrap();
  expect(record).toHaveBeenCalledTimes(2);
  encoder.finish().unwrap();
  capture.dispose();
  expect(capture.recordPass(pass).ok).toBe(false);
});

async function acceptedCaptureFixture() {
  const device = await queryTestDevice();
  Object.assign(device.caps, { rgba16floatRenderable: true, maxColorAttachments: 4 });
  const layout = (await buildMeshCardLayout(sdfCubePositions, sdfCubeIndices)).unwrap();
  const source: SurfaceCaptureSource = {
    instance: {
      instanceId: 0,
      geometryId: 0,
      mask: 255,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      positions: sdfCubePositions,
      indices: sdfCubeIndices,
    },
    layout,
    captureKey: 'accepted-card-source',
    sections: [
      {
        indexOffset: 0,
        indexCount: sdfCubeIndices.length,
        material: {
          id: 0,
          program: {
            source: '',
            paramSchema: [{ name: 'baseColor', type: 'color', default: [1, 1, 1, 1] }],
          },
          snapshot: {
            ...defaultMaterialSnapshot(),
            paramSnapshot: { baseColor: [0.25, 0.5, 0.75, 1] },
          },
        },
      },
    ],
  };
  return { device, source };
}

it('uses accepted linear material values exactly once and preserves whole-Mesh validation', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const write = vi.spyOn(device.queue, 'writeBuffer');
  const capture = (await prepareSurfaceCapture(device, createShaderModule, [source])).unwrap();
  const material = capture.bufferReads.at(-1);
  expect(material?.usage).toBe('uniform-read');
  const row = write.mock.calls.find(([buffer]) => buffer === material?.buffer)?.[2];
  assert(row);
  const bytes =
    row instanceof ArrayBuffer
      ? new Uint8Array(row)
      : new Uint8Array(row.buffer, row.byteOffset, row.byteLength);
  expect(Array.from(new Float32Array(bytes.slice(0, 16).buffer))).toEqual([0.25, 0.5, 0.75, 1]);
  expect(capture.entries[0]?.captureKey).toBe(source.captureKey);
  capture.dispose();
  const section = source.sections[0];
  assert(section);
  for (const sections of [
    [],
    [{ ...section, indexOffset: 3 }],
    [{ ...section, indexCount: 3 }],
    [
      {
        ...section,
        material: {
          ...section.material,
          snapshot: {
            ...section.material.snapshot,
            renderState: { cullMode: 'none' as const },
          },
        },
      },
    ],
  ]) {
    expect(
      (await prepareSurfaceCapture(device, createShaderModule, [{ ...source, sections }])).ok,
    ).toBe(false);
  }
});

it('rejects an explicit attachment budget before allocating GPU resources', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const create = vi.spyOn(device, 'createTexture');
  const capture = await prepareSurfaceCapture(
    device,
    createShaderModule,
    [source],
    { kind: 'cards', resolution: 16 },
    1,
  );
  expect(capture.ok).toBe(false);
  expect(create).not.toHaveBeenCalled();
});

it('adds, rematerializes and removes Card instances in place within the reserved atlas', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const cards = source.layout.cards.length;
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      [source],
      { kind: 'cards', resolution: 16 },
      256 * 1024 * 1024,
      cards,
    )
  ).unwrap();
  expect(capture.allocatedTiles).toBe(cards);
  expect(capture.capacity).toBeGreaterThanOrEqual(2 * cards);
  const at = (instanceId: number) => ({
    ...source,
    instance: { ...source.instance, instanceId },
  });
  expect(capture.admitted(at(1))).toBe(true);
  expect(capture.add(at(1)).unwrap()).toEqual({ first: cards, count: cards });
  expect(capture.add(at(1)).ok).toBe(false);
  expect(capture.entries.map((e) => e.instanceId)).toEqual([0, 1]);

  const section = source.sections[0];
  assert(section);
  const white = {
    ...at(0),
    sections: [
      {
        ...section,
        material: {
          ...section.material,
          snapshot: { ...section.material.snapshot, paramSnapshot: { baseColor: [1, 1, 1, 1] } },
        },
      },
    ],
  };
  const reads = capture.bufferReads.length;
  const revision = capture.revision;
  expect(capture.rematerialize(0, white).unwrap()).toEqual({ first: 0, count: cards });
  // Replaced draws retire their buffers instead of accumulating them.
  expect(capture.bufferReads.length).toBe(reads);
  expect(capture.revision).toBeGreaterThan(revision);
  expect(capture.entries.map((e) => e.instanceId)).toEqual([0, 1]);
  expect(capture.rematerialize(0, { ...white, layout: { ...source.layout, cards: [] } }).ok).toBe(
    false,
  );

  expect(capture.remove(0).unwrap()).toEqual({ first: 0, count: cards });
  expect(capture.has(0)).toBe(false);
  expect(capture.bufferReads.length).toBeLessThan(reads);
  expect(capture.remove(0).ok).toBe(false);
  // A freed run is reused before the high-water mark grows.
  expect(capture.add(at(2)).unwrap()).toEqual({ first: 0, count: cards });
  expect(capture.allocatedTiles).toBe(2 * cards);

  let next = 3;
  for (; next < 3 + capture.capacity; next++) if (!capture.add(at(next)).ok) break;
  const full = capture.add(at(next));
  assert(!full.ok);
  expect(full.error.code).toBe('ray-reference-limit');
  // Overflow leaves the capture intact: no partial install, tiles stay inside the atlas.
  expect(capture.entries.some((e) => e.instanceId === next)).toBe(false);
  expect(capture.allocatedTiles).toBeLessThanOrEqual(capture.capacity);
  capture.dispose();
  expect(capture.add(at(99)).ok).toBe(false);
});

it('installs the priority prefix past the Card ceilings in residency mode instead of failing', async () => {
  const { device, source } = await acceptedCaptureFixture();
  const cards = source.layout.cards.length;
  const sources = Array.from({ length: 8 }, (_, instanceId) => ({
    ...source,
    instance: { ...source.instance, instanceId },
  }));
  // Room for about three instances' tiles at 16x16 rgba16f x4 + depth (36 B/texel).
  const maxBytes = 3 * cards * 16 * 16 * 36 * 2;
  const strict = await prepareSurfaceCapture(
    device,
    createShaderModule,
    sources,
    { kind: 'cards', resolution: 16 },
    maxBytes,
  );
  assert(!strict.ok);
  expect(strict.error.code).toBe('ray-reference-limit');
  const capture = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      sources,
      { kind: 'cards', resolution: 16 },
      maxBytes,
      0,
      { maxTexels: 1 << 20 },
    )
  ).unwrap();
  const resident = capture.entries.map((e) => e.instanceId);
  expect(resident.length).toBeGreaterThan(0);
  expect(resident.length).toBeLessThan(sources.length);
  // The installed set is the leading prefix of the priority-ordered sources.
  expect(resident).toEqual(resident.map((_, i) => i));
  expect(capture.residency).toEqual({ maxTexels: 1 << 20 });
  expect(capture.allocatedTiles).toBeLessThanOrEqual(capture.capacity);
  expect(capture.width * capture.height * 36).toBeLessThanOrEqual(maxBytes);
  // Streaming swaps residents: an eviction frees tiles that the next install reuses.
  const last = resident[resident.length - 1];
  assert(last !== undefined);
  const evicted = capture.remove(last).unwrap();
  const next = sources[resident.length];
  assert(next);
  expect(capture.add(next).unwrap()).toEqual(evicted);
  expect(capture.has(next.instance.instanceId)).toBe(true);
  expect(capture.has(last)).toBe(false);
  // The texel ceiling bounds the atlas even when bytes would allow more.
  const narrow = (
    await prepareSurfaceCapture(
      device,
      createShaderModule,
      sources,
      { kind: 'cards', resolution: 16 },
      256 * 1024 * 1024,
      0,
      { maxTexels: 16 * 16 * cards },
    )
  ).unwrap();
  expect(narrow.width * narrow.height).toBeLessThanOrEqual(16 * 16 * cards);
  expect(narrow.entries.length).toBeGreaterThan(0);
  capture.dispose();
  narrow.dispose();
});
