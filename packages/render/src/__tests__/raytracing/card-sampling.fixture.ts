import { buildMeshCardLayout, buildVisibilityDistanceField } from '@forgeax/engine-geometry';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  CARD_LOOKUP_STRIDE,
  CardLookupStatus,
  createSdfCardLookup,
} from '../../raytracing/card-lookup';
import { createSdfQuery, SdfQueryStatus } from '../../raytracing/sdf-query';
import { createSurfaceCapture, type SurfaceCardSource } from '../../raytracing/surface-cards';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { readCardPlanes, sdfCubeInstance } from './sdf-cards.fixture';

/** Real raster texels plus analytic hit positions isolate sampling from SDF traversal error. */
export async function verifyCardSampling(fixture: SdfCardsFixture) {
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
  const captures: { mode: string; tape: Uint8Array; lookup: Uint8Array; planes: Uint8Array[] }[] =
    [];
  const material = (id: number, color: number[]) => ({
    id,
    ...fixture.card,
    asset: { ...fixture.card.asset, values: { ...fixture.card.asset.values, baseColor: color } },
  });
  try {
    for (const mode of ['mixed', 'missing', 'depth', 'dense'] as const) {
      const resolution = mode === 'dense' ? 512 : 16;
      const z = mode === 'depth' ? -1 : 0;
      const positions = [-1, -1, 0, 0, -1, 0, -1, 1, 0, 0, 1, 0];
      const indices = [0, 1, 2, 1, 3, 2];
      if (mode !== 'missing') {
        positions.push(0, -1, z, 1, -1, z, 0, 1, z, 1, 1, z);
        indices.push(4, 5, 6, 5, 7, 6);
      }
      const layout = (await buildMeshCardLayout(positions, indices)).unwrap();
      const field = (
        await buildVisibilityDistanceField(positions, indices, {
          voxelSize: 0.25,
          triangleSidedness: new Uint8Array(indices.length / 3),
        })
      ).unwrap();
      const source: SurfaceCardSource = {
        instance: { ...sdfCubeInstance, positions, indices, uvSets: [] },
        layout: { ...layout, cards: fixture.layers.layout.cards },
        sections: [
          { indexOffset: 0, indexCount: 6, material: material(10, [1, 0, 0, 1]) },
          ...(mode === 'missing'
            ? []
            : [{ indexOffset: 6, indexCount: 6, material: material(20, [0, 0, 1, 1]) }]),
        ],
      };
      // A green adjacent atlas tile catches filtering across a card boundary.
      const neighbor: SurfaceCardSource = {
        ...source,
        instance: {
          ...source.instance,
          instanceId: 42,
          transform: Array.from(source.instance.transform, (v, i) => (i === 12 ? 10 : v)),
        },
        sections: source.sections.map((s) => ({ ...s, material: material(30, [0, 1, 0, 1]) })),
      };
      const points = [
        [0, 0, 0],
        [-1, 0, 0],
        [1, 0, 0],
        [0, 0, 0.5],
        [0, 0, 0],
        [-0.5, 0, 0.025],
      ] as const;
      const query = (
        await createSdfQuery(
          device,
          recorder.backend.createShaderModule,
          [{ ...source.instance, field }],
          points.map((origin) => ({ origin, direction: [0, 0, -1], tMin: 0, tMax: 4, mask: 255 })),
        )
      ).unwrap();
      const hitBytes = new Uint8Array(points.length * 64),
        hits = new DataView(hitBytes.buffer);
      for (const [i, point] of points.entries()) {
        hits.setUint32(i * 64, SdfQueryStatus.visibilityHit, true);
        hits.setUint32(i * 64 + 4, source.instance.instanceId, true);
        hits.setUint32(i * 64 + 8, source.instance.geometryId, true);
        hits.setUint32(i * 64 + 12, 0xffffffff, true);
        point.forEach((v, a) => {
          hits.setFloat32(i * 64 + 32 + a * 4, v, true);
        });
        hits.setFloat32(i * 64 + 56, i === 4 ? -1 : 1, true);
      }
      device.queue.writeBuffer(query.buffers.hits, 0, hitBytes).unwrap();
      const cards = (
        await createSurfaceCapture(
          device,
          recorder.backend.createShaderModule,
          [source, neighbor],
          { kind: 'cards', resolution },
        )
      ).unwrap();
      const lookup = (
        await createSdfCardLookup(device, recorder.backend.createShaderModule, query, cards, [
          source,
          neighbor,
        ])
      ).unwrap();
      try {
        const pending = recorder.captureFrame();
        (await recorder.frameBoundary()).unwrap();
        const encoder = device.createCommandEncoder({}).unwrap();
        cards.record(encoder).unwrap();
        lookup.record(encoder).unwrap();
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        (await recorder.frameBoundary()).unwrap();
        const tape = (await pending).unwrap().bytes;
        const bytes = await readBuffer(device, lookup.buffer, points.length * CARD_LOOKUP_STRIDE);
        const view = new DataView(bytes.buffer),
          expected = mode === 'mixed' || mode === 'dense' ? [0.5, 0, 0.5] : [1, 0, 0];
        expect(view.getUint32(0, true)).toBe(CardLookupStatus.mapped);
        for (const [channel, value] of expected.entries())
          expect(view.getFloat32(16 + channel * 4, true)).toBeCloseTo(value, 5);
        expect(view.getUint32(CARD_LOOKUP_STRIDE, true)).toBe(CardLookupStatus.mapped);
        expect(view.getFloat32(CARD_LOOKUP_STRIDE + 16, true)).toBe(1);
        expect(view.getFloat32(CARD_LOOKUP_STRIDE + 20, true)).toBe(0);
        for (let i = 0; i < points.length; i++) {
          const mapped = view.getUint32(i * CARD_LOOKUP_STRIDE, true) === CardLookupStatus.mapped;
          let sum = 0;
          for (let tap = 0; tap < 4; tap++) {
            const weight = view.getFloat32(i * CARD_LOOKUP_STRIDE + 96 + tap * 4, true);
            const texel = view.getUint32(i * CARD_LOOKUP_STRIDE + 80 + tap * 4, true);
            sum += weight;
            if (weight > 0) expect(texel % cards.width).toBeLessThan(resolution);
          }
          expect(sum).toBeCloseTo(mapped ? 1 : 0, 6);
          expect(view.getUint32(i * CARD_LOOKUP_STRIDE + 12, true)).toBe(
            source.instance.instanceId,
          );
        }
        expect(view.getUint32(2 * CARD_LOOKUP_STRIDE, true)).toBe(
          mode === 'mixed' || mode === 'dense'
            ? CardLookupStatus.mapped
            : CardLookupStatus.unmapped,
        );
        for (const i of [3, 4])
          expect(view.getUint32(i * CARD_LOOKUP_STRIDE, true)).toBe(CardLookupStatus.unmapped);
        // The same 2.5 cm off-plane point fits a coarse texel footprint, but a
        // denser capture must reject it while preserving actual surface colors.
        expect(view.getUint32(5 * CARD_LOOKUP_STRIDE, true)).toBe(
          mode === 'dense' ? CardLookupStatus.unmapped : CardLookupStatus.mapped,
        );
        captures.push({ mode, tape, lookup: bytes, planes: await readCardPlanes(device, cards) });
      } finally {
        lookup.dispose();
        cards.dispose();
        query.dispose();
      }
    }
  } finally {
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
  for (const capture of captures) {
    const tape = decodeTape(capture.tape).unwrap(),
      model = buildFrameModel(tape);
    expect(model.unseededResources).toEqual([]);
    const work = model.works.at(-1);
    assert(work);
    const id = work.bindings.find((b) => b.binding === 2)?.resourceId;
    assert(id);
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const native = webgpu._internal_getRawDevice(fresh);
    assert(native);
    native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      expect((await replay.readResource(id)).unwrap().bytes.every((b) => b === 0)).toBe(true);
      expect((await replay.readResourceAtWork(id, work.workIndex)).unwrap().bytes).toEqual(
        capture.lookup,
      );
    } finally {
      (await replay.dispose()).unwrap();
      native.destroy();
    }
  }
  expect(errors).toEqual([]);
  return captures;
}
