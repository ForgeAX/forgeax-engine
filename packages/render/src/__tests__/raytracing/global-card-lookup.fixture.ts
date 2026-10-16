import type { Buffer } from '@forgeax/engine-rhi';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  packCardLookupProjections,
} from '../../raytracing/card-lookup';
import {
  createGlobalSdfCardLookup,
  createGlobalSdfCardLookupRecorder,
  GLOBAL_CARD_CANDIDATE_STRIDE,
  GLOBAL_SDF_CARD_LOOKUP_WGSL,
  GlobalCardCandidateFlags,
  type GlobalSdfCardLookupInputs,
} from '../../raytracing/global-card-lookup';
import { createGlobalSdfComposition, packGlobalSdfComposition } from '../../raytracing/global-sdf';
import { createGlobalSdfQuery, GlobalSdfQueryStatus } from '../../raytracing/global-sdf-query';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';
import {
  CARD_TEXTURES,
  createSurfaceCapture,
  type SurfaceCardSource,
} from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeInstance } from './sdf-cards.fixture';

/** Analytic hit controls isolate association; live mode records the entire composition/query/Card chain. */
export async function verifyGlobalCards(fixture: SdfCardsFixture) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const field = {
    ...fixture.field,
    bricks: Uint32Array.from(fixture.field.bricks),
    values: Float32Array.from(fixture.field.values),
  };
  const source = (id: number, z: number, color: number[]): SurfaceCardSource => ({
    instance: {
      ...sdfCubeInstance,
      instanceId: id,
      transform: Array.from(sdfCubeInstance.transform, (v, i) => (i === 14 ? z : v)),
    },
    layout: fixture.layout,
    sections: [
      {
        indexOffset: 0,
        indexCount: sdfCubeInstance.indices.length,
        material: {
          id,
          ...fixture.card,
          asset: {
            ...fixture.card.asset,
            values: { ...fixture.card.asset.values, baseColor: color },
          },
        },
      },
    ],
  });
  const first = source(7, 0, [1, 0, 0, 1]),
    second = source(3, -0.2, [0, 1, 0, 1]);
  const modes = [
    'live',
    'ordered',
    'permuted',
    'missing',
    'masked',
    'overflow',
    'stale-material',
    'stale-pose',
    'uncaptured',
  ] as const;
  const evidence: {
    mode: string;
    tape: Uint8Array;
    candidates: Uint8Array;
    samples: Uint8Array;
    hits: Uint8Array;
    borrowedCandidates: Uint8Array;
    borrowedSamples: Uint8Array;
    borrowedOffset: number;
  }[] = [];
  try {
    for (const mode of modes) {
      let sources = [first, second];
      if (mode === 'overflow')
        sources = Array.from({ length: 6 }, (_, i) => source(6 - i, 0, [1, 0, 0, 1]));
      const expected =
        mode === 'stale-material'
          ? [source(7, 0, [0, 0, 1, 1]), second]
          : mode === 'stale-pose'
            ? [source(7, 0.1, [1, 0, 0, 1]), second]
            : sources;
      const objects: SdfMeshInstance[] = expected.map((s) => ({ ...s.instance, field }));
      if (mode === 'permuted') objects.reverse();
      if (mode === 'missing' || mode === 'masked')
        objects.push({
          ...first.instance,
          instanceId: 99,
          mask: mode === 'masked' ? 0 : 255,
          field: { missing: true, bounds: field.bounds },
        });
      // Distant unavailable geometry must not contaminate the local candidate set.
      objects.push({
        ...source(100, 10, [1, 1, 1, 1]).instance,
        field: { missing: true, bounds: field.bounds },
      });
      const composition = (
        await createGlobalSdfComposition(device, recorder.backend.createShaderModule, objects, {
          origin: [-4, -4, -4],
          dimensions: [17, 17, 17],
          spacing: 0.5,
          maxDistance: 2,
          coverageDistance: 0.25,
        })
      ).unwrap();
      const rays = Array.from({ length: 9 }, (_, i) => ({
        origin: [i === 8 ? 3 : 0, 0, 3] as const,
        direction: [0, 0, -1] as const,
        tMin: 0,
        tMax: 4,
        mask: 255,
      }));
      const query = (
        await createGlobalSdfQuery(device, recorder.backend.createShaderModule, composition, rays)
      ).unwrap();
      const cards = (
        await createSurfaceCapture(
          device,
          recorder.backend.createShaderModule,
          mode === 'uncaptured' ? [second] : sources,
          { kind: 'cards', resolution: 32 },
        )
      ).unwrap();
      const lookup = (
        await createGlobalSdfCardLookup(
          device,
          recorder.backend.createShaderModule,
          composition,
          query,
          cards,
          expected,
        )
      ).unwrap();
      const borrowedOwned: Buffer[] = [];
      const borrowedOffset = Math.max(
        256,
        device.limits.minStorageBufferOffsetAlignment,
        device.limits.minUniformBufferOffsetAlignment,
      );
      const makeBorrowed = (label: string, data: Uint8Array) => {
        const bytes = new Uint8Array(borrowedOffset + data.byteLength + 256).fill(0xcd);
        bytes.set(data, borrowedOffset);
        const buffer = device.createBuffer({ label, size: bytes.byteLength, usage: 0xcc }).unwrap();
        borrowedOwned.push(buffer);
        device.queue.writeBuffer(buffer, 0, bytes).unwrap();
        return { buffer, offset: borrowedOffset, size: data.byteLength };
      };
      const packed = packGlobalSdfComposition(objects, composition.grid).unwrap();
      const projections = packCardLookupProjections(
        cards,
        composition.sources.map((source) => ({
          instanceId: source.instanceId,
          key: source.geometryKey,
        })),
        expected,
      );
      const inputs: GlobalSdfCardLookupInputs = {
        hits: { buffer: query.buffers.hits, size: query.rayCount * 64 },
        instances: {
          buffer: composition.buffers.instances,
          size: packed.data.instances.byteLength,
        },
        fields: { buffer: composition.buffers.fields, size: packed.data.fields.byteLength },
        bounds: { buffer: composition.buffers.bounds, size: packed.data.bounds.byteLength },
        grid: { buffer: composition.buffers.settings, size: 48 },
        candidates: makeBorrowed(
          'global-cards.borrowed-candidates',
          new Uint8Array(query.rayCount * GLOBAL_CARD_CANDIDATE_STRIDE),
        ),
        cards: makeBorrowed('global-cards.borrowed-projections', projections.bytes),
        output: makeBorrowed(
          'global-cards.borrowed-samples',
          new Uint8Array(query.rayCount * 4 * CARD_LOOKUP_STRIDE),
        ),
        settings: makeBorrowed(
          'global-cards.borrowed-settings',
          new Uint8Array(new Uint32Array([projections.count, cards.resolution, 0, 0]).buffer),
        ),
        textures: Object.fromEntries(
          CARD_TEXTURES.map((name) => [
            name,
            device.createTextureView(cards.textures[name], {}).unwrap(),
          ]),
        ) as GlobalSdfCardLookupInputs['textures'],
      };
      const borrowed = createGlobalSdfCardLookupRecorder(
        device,
        (
          await recorder.backend.createShaderModule(device, { code: GLOBAL_SDF_CARD_LOOKUP_WGSL })
        ).unwrap(),
      ).unwrap();
      const statuses = [1, 1, 2, 0, 3, 4, 5, 1, 1];
      if (mode !== 'live') {
        const bytes = new Uint8Array(9 * 64),
          v = new DataView(bytes.buffer);
        statuses.forEach((status, i) => {
          v.setUint32(i * 64, status, true);
          v.setFloat32(i * 64 + 32, i === 8 ? 3 : 0, true);
          v.setFloat32(i * 64 + 40, 1, true);
          v.setFloat32(i * 64 + 56, i === 1 ? 0 : i === 7 ? -1 : 1, true);
        });
        device.queue.writeBuffer(query.buffers.hits, 0, bytes).unwrap();
      }
      try {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const encoder = device.createCommandEncoder({}).unwrap();
        if (mode === 'live') {
          composition.record(encoder).unwrap();
          query.record(encoder).unwrap();
        }
        cards.record(encoder).unwrap();
        lookup.record(encoder).unwrap();
        for (const stage of ['selectCandidates', 'sampleCards'] as const) {
          const pass = encoder.beginComputePass({ label: `global-cards.borrowed.${stage}` });
          borrowed.record(pass, inputs, query.rayCount, stage).unwrap();
          pass.end();
        }
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        (await recorder.frameBoundary()).unwrap();
        const tape = (await pending).unwrap().bytes;
        const candidates = await readBuffer(
          device,
          lookup.candidateBuffer,
          9 * GLOBAL_CARD_CANDIDATE_STRIDE,
        );
        const samples = await readBuffer(device, lookup.buffer, 9 * 4 * CARD_LOOKUP_STRIDE);
        const hits = await readBuffer(device, query.buffers.hits, 9 * 64);
        const borrowedCandidates = await readBuffer(
          device,
          inputs.candidates.buffer,
          borrowedOffset + inputs.candidates.size + 256,
        );
        const borrowedSamples = await readBuffer(
          device,
          inputs.output.buffer,
          borrowedOffset + inputs.output.size + 256,
        );
        expect(
          borrowedCandidates.subarray(borrowedOffset, borrowedOffset + candidates.byteLength),
        ).toEqual(candidates);
        expect(
          borrowedSamples.subarray(borrowedOffset, borrowedOffset + samples.byteLength),
        ).toEqual(samples);
        for (const [bytes, size] of [
          [borrowedCandidates, candidates.byteLength],
          [borrowedSamples, samples.byteLength],
        ] as const) {
          expect(bytes.subarray(0, borrowedOffset).every((value) => value === 0xcd)).toBe(true);
          expect(bytes.subarray(borrowedOffset + size).every((value) => value === 0xcd)).toBe(true);
        }
        const c = new DataView(candidates.buffer),
          s = new DataView(samples.buffer),
          h = new DataView(hits.buffer);
        expect(h.getUint32(0, true)).toBe(GlobalSdfQueryStatus.hit);
        expect(c.getUint32(0, true)).toBe(mode === 'overflow' ? 4 : 2);
        expect(c.getUint32(12, true)).toBe(mode === 'overflow' ? 6 : 2);
        expect(c.getUint32(4, true)).toBe(
          mode === 'missing'
            ? GlobalCardCandidateFlags.missingField
            : mode === 'overflow'
              ? GlobalCardCandidateFlags.overflow
              : 0,
        );
        expect(c.getUint32(16, true)).toBe(mode === 'overflow' ? 1 : 7);
        expect(c.getUint32(20, true)).toBe(mode === 'overflow' ? 2 : 3);
        const firstStatus = mode.startsWith('stale')
          ? CardLookupStatus.stale
          : mode === 'missing' || mode === 'overflow' || mode === 'uncaptured'
            ? CardLookupStatus.unmapped
            : CardLookupStatus.mapped;
        expect(s.getUint32(0, true)).toBe(firstStatus);
        if (firstStatus === CardLookupStatus.mapped) {
          expect(s.getFloat32(16, true)).toBe(1);
          expect(s.getFloat32(20, true)).toBe(0);
        }
        if (mode !== 'missing' && mode !== 'overflow') {
          expect(s.getUint32(CARD_LOOKUP_STRIDE, true)).toBe(CardLookupStatus.mapped);
          expect(s.getFloat32(CARD_LOOKUP_STRIDE + 20, true)).toBe(1);
        }
        if (mode !== 'live') {
          expect(c.getUint32(32 + 4, true)).toBe(GlobalCardCandidateFlags.invalidNormal);
          for (let i = 2; i <= 6; i++) {
            expect(c.getUint32(i * 32, true)).toBe(0);
            expect(c.getUint32(i * 32 + 8, true)).toBe(statuses[i]);
            expect(s.getUint32(i * 4 * CARD_LOOKUP_STRIDE, true)).toBe(CardLookupStatus.notSurface);
          }
          // Reverse normal keeps object association but rejects the front-facing captured surface.
          expect(s.getUint32(7 * 4 * CARD_LOOKUP_STRIDE, true)).not.toBe(CardLookupStatus.mapped);
          expect(c.getUint32(8 * 32, true)).toBe(0);
        }
        for (let i = 0; i < 36; i++) {
          const offset = i * CARD_LOOKUP_STRIDE,
            mapped = s.getUint32(offset, true) === CardLookupStatus.mapped;
          let weight = 0;
          for (let tap = 0; tap < 4; tap++) weight += s.getFloat32(offset + 96 + tap * 4, true);
          expect(weight).toBeCloseTo(mapped ? 1 : 0, 6);
        }
        evidence.push({
          mode,
          tape,
          candidates,
          samples,
          hits,
          borrowedCandidates,
          borrowedSamples,
          borrowedOffset,
        });
      } finally {
        for (const buffer of borrowedOwned) device.destroyBuffer(buffer).unwrap();
        lookup.dispose();
        cards.dispose();
        query.dispose();
        composition.dispose();
      }
    }
  } finally {
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
  for (const item of evidence) {
    const tape = decodeTape(item.tape).unwrap(),
      model = buildFrameModel(tape);
    expect(model.unseededResources).toEqual([]);
    const selection = model.works.at(-4),
      sampling = model.works.at(-3),
      borrowedSelection = model.works.at(-2),
      borrowedSampling = model.works.at(-1);
    assert(selection && sampling && borrowedSelection && borrowedSampling);
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const native = webgpu._internal_getRawDevice(fresh);
    assert(native);
    native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      for (const [work, binding, expected, offset] of [
        [selection, 5, item.candidates, 0],
        [sampling, 7, item.samples, 0],
        [borrowedSelection, 5, item.borrowedCandidates, item.borrowedOffset],
        [borrowedSampling, 7, item.borrowedSamples, item.borrowedOffset],
      ] as const) {
        const id = work.bindings.find((b) => b.binding === binding)?.resourceId;
        assert(id);
        const before = (await replay.readResource(id)).unwrap().bytes;
        const size = binding === 5 ? item.candidates.byteLength : item.samples.byteLength;
        expect(before.subarray(offset, offset + size).every((b) => b === 0)).toBe(true);
        if (offset) {
          const range = work.bindings.find((b) => b.binding === binding);
          expect(range?.bufferOffset).toBe(offset);
          expect(range?.bufferSize).toBe(size);
          expect(before.subarray(0, offset).every((b) => b === 0xcd)).toBe(true);
          expect(before.subarray(offset + size).every((b) => b === 0xcd)).toBe(true);
        }
        expect((await replay.readResourceAtWork(id, work.workIndex)).unwrap().bytes).toEqual(
          expected,
        );
      }
    } finally {
      (await replay.dispose()).unwrap();
      native.destroy();
    }
  }
  expect(evidence.find((e) => e.mode === 'ordered')?.candidates).toEqual(
    evidence.find((e) => e.mode === 'permuted')?.candidates,
  );
  expect(evidence.find((e) => e.mode === 'ordered')?.samples).toEqual(
    evidence.find((e) => e.mode === 'permuted')?.samples,
  );
  expect(errors).toEqual([]);
  return evidence;
}
