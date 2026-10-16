import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  encodeTape,
  openReplay,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createGlobalSdfComposition } from '../../raytracing/global-sdf';
import { GlobalSdfQueryStatus as GlobalStatus } from '../../raytracing/global-sdf-query';
import { packReferenceRays, type ReferenceRay } from '../../raytracing/scene';
import { SdfQueryStatus as DetailStatus } from '../../raytracing/sdf-query';
import { createSoftwareSdfQuery, type SoftwareSdfQuery } from '../../raytracing/software-sdf-query';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeInstance } from './sdf-cards.fixture';

export async function verifySoftwareSdfQuery(
  fixture: SdfCardsFixture,
  save?: (name: string, bytes: Uint8Array) => Promise<void>,
) {
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const native = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(native);
  const errors: string[] = [];
  native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const source = {
    ...sdfCubeInstance,
    field: {
      ...fixture.field,
      bricks: Uint32Array.from(fixture.field.bricks),
      values: Float32Array.from(fixture.field.values),
    },
  };
  const missing = { ...source, field: { missing: true as const, bounds: fixture.field.bounds } };
  const grid = {
    origin: [-3, -3, -3] as const,
    dimensions: [13, 13, 13] as const,
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.5,
  };
  const ray = (
    origin: readonly [number, number, number],
    direction: readonly [number, number, number],
    tMax: number,
    mask = 255,
  ): ReferenceRay => ({ origin, direction, tMin: 0, tMax, mask });
  const rays = [
    ray([0, 2, 0], [0, -1, 0], 4),
    ray([0, 2, 0], [0, -2, 0], 2),
    ray([0, 1.15, 0], [0, -1, 0], 4),
    ray([0, 0, 0], [0, 1, 0], 2),
    ray([2, 2, 2], [0, 0, 1], 0.1),
    ray([2, 2, 2], [0, 0, 1], 0.5),
    ray([0, 2, 0], [0, -1, 0], 4, 0),
    { ...ray([0, 3, 0], [0, -1, 0], 5), tMin: 1 },
    ray([0, 4, 0], [0, -1, 0], 10),
  ];
  const compositions = [];
  const queries: SoftwareSdfQuery[] = [];
  const outputs: Uint8Array[][] = [];
  let bytes: Uint8Array;
  try {
    for (const inputs of [[source], [missing], []])
      compositions.push(
        (
          await createGlobalSdfComposition(
            device,
            recorder.backend.createShaderModule,
            inputs,
            grid,
          )
        ).unwrap(),
      );
    const complete = compositions[0],
      unavailable = compositions[1],
      empty = compositions[2];
    assert(complete && unavailable && empty);
    for (const [composition, inputs, options] of [
      [complete, [source], { detailDistance: 0.25 }],
      [unavailable, [missing], { detailDistance: 2 }],
      [empty, [], { detailDistance: 0.25 }],
      [complete, [source], { detailDistance: 2, detail: { maxSteps: 1 } }],
    ] as const)
      queries.push(
        (
          await createSoftwareSdfQuery(
            device,
            recorder.backend.createShaderModule,
            composition,
            inputs,
            rays,
            options,
          )
        ).unwrap(),
      );
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    complete.record(encoder).unwrap();
    queries[0]?.record(encoder).unwrap();
    queries[0]?.record(encoder).unwrap(); // Same frozen interval on repeated recording.
    unavailable.record(encoder).unwrap();
    queries[1]?.record(encoder).unwrap();
    empty.record(encoder).unwrap();
    queries[2]?.record(encoder).unwrap();
    queries[3]?.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    bytes = (await pending).unwrap().bytes;
    for (const [i, q] of queries.entries()) {
      const row = [
        await readBuffer(device, q.detail.buffers.hits, rays.length * 64),
        await readBuffer(device, q.global.buffers.rays, rays.length * 48),
        await readBuffer(device, q.global.buffers.hits, rays.length * 64),
      ];
      outputs.push(row);
      for (const [j, b] of row.entries()) await save?.(`case-${i}-${j}.bin`, b);
    }
    await save?.('software-sdf.rhitape', bytes);
  } finally {
    for (const q of queries) q.dispose();
    for (const c of compositions) c.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const at = (c: number, k: number) => {
    const b = outputs[c]?.[k];
    assert(b);
    return view(b);
  };
  const detail = at(0, 0),
    continued = at(0, 1),
    global = at(0, 2);
  const masks = rays.map((_, i) => continued.getUint32(i * 48 + 32, true));
  expect(masks).toEqual([255, 255, 0, 0, 0, 255, 0, 255, 255]);
  expect(detail.getUint32(2 * 64, true)).toBe(DetailStatus.surfaceBand);
  expect(detail.getUint32(3 * 64, true)).toBe(DetailStatus.insideStart);
  expect(at(1, 0).getUint32(0, true)).toBe(DetailStatus.missingField);
  expect(at(1, 1).getUint32(32, true)).toBe(0);
  expect(at(3, 0).getUint32(0, true)).toBe(DetailStatus.stepBudget);
  expect(at(3, 1).getUint32(32, true)).toBe(0);
  expect(global.getUint32(0, true)).toBe(GlobalStatus.hit);
  expect(global.getUint32(8 * 64, true)).toBe(GlobalStatus.outsideRegion);
  expect(continued.getFloat32(12, true)).toBe(0.25);
  expect(continued.getFloat32(48 + 12, true)).toBe(0.125);
  expect(continued.getFloat32(7 * 48 + 12, true)).toBe(1.25);
  expect(Math.abs(global.getFloat32(16, true) - global.getFloat32(64 + 16, true) * 2)).toBeLessThan(
    1e-5,
  );
  expect(
    Math.abs(global.getFloat32(7 * 64 + 16, true) - global.getFloat32(16, true) - 1),
  ).toBeLessThan(1e-5);
  for (const [c, row] of outputs.entries())
    for (const [i, r] of rays.entries()) {
      const near = at(c, 0),
        far = at(c, 1),
        hit = at(c, 2),
        mask = far.getUint32(i * 48 + 32, true);
      expect(far.getFloat32(i * 48 + 28, true)).toBe(Math.fround(r.tMax));
      expect([0, 1, 2].map((a) => far.getFloat32(i * 48 + a * 4, true))).toEqual(
        r.origin.map(Math.fround),
      );
      expect([0, 1, 2].map((a) => far.getFloat32(i * 48 + 16 + a * 4, true))).toEqual(
        r.direction.map(Math.fround),
      );
      if (mask) {
        expect(near.getUint32(i * 64, true)).toBe(DetailStatus.miss);
        expect(r.mask).toBe(255);
      } else expect(hit.getUint32(i * 64 + 8, true)).toBe(0);
      expect(row).toHaveLength(3);
    }
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.unseededResources).toEqual([]);
  expect(model.works).toHaveLength(18);
  const plans = [
    { detail: 1, gate: 2, global: 3, case: 0 },
    { detail: 4, gate: 5, global: 6, case: 0 },
    { detail: 8, gate: 9, global: 10, case: 1 },
    { detail: 12, gate: 13, global: 14, case: 2 },
    { detail: 15, gate: 16, global: 17, case: 3 },
  ];
  const binding = (work: number, b: number) => {
    const id = model.works[work]?.bindings.find((x) => x.binding === b)?.resourceId;
    assert(id);
    return id;
  };
  for (const p of plans) {
    expect(binding(p.detail, 2)).toBe(binding(p.gate, 0));
    expect(binding(p.detail, 3)).toBe(binding(p.gate, 1));
    expect(binding(p.gate, 2)).toBe(binding(p.global, 2));
  }
  for (const skip of [null, 1, 2, 0]) {
    const eventIndex = skip === null ? -1 : model.works[skip]?.eventIndex;
    assert(eventIndex !== undefined);
    const modified = {
      ...tape,
      events: tape.events.map((e, i) =>
        i === eventIndex && e.kind === 'dispatchWorkgroups' ? { ...e, x: 0 } : e,
      ),
    };
    const checked = decodeTape(encodeTape(modified).unwrap()).unwrap();
    const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
      raw = webgpu._internal_getRawDevice(fresh);
    assert(raw);
    raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    const replay = (
      await openReplay(checked, { device: fresh, createShaderModule: webgpu.createShaderModule })
    ).unwrap();
    try {
      if (skip === null) {
        for (const p of plans)
          for (const [part, work, b] of [
            [0, p.detail, 3],
            [1, p.gate, 2],
            [2, p.global, 3],
          ] as const) {
            expect(
              (await replay.readResourceAtWork(binding(work, b), work)).unwrap().bytes,
            ).toEqual(outputs[p.case]?.[part]);
          }
      } else {
        const actual = (await replay.readResourceAtWork(binding(3, 2), 3)).unwrap().bytes,
          a = view(actual);
        if (skip === 1)
          expect(rays.map((_, i) => a.getUint32(i * 48 + 32, true))).toEqual(rays.map(() => 0));
        if (skip === 2) expect(actual).toEqual(packReferenceRays(rays).unwrap());
        if (skip === 0) {
          const hits = (await replay.readResourceAtWork(binding(3, 3), 3)).unwrap().bytes;
          expect(view(hits).getUint32(0, true)).toBe(GlobalStatus.missingField);
        }
        await save?.(`no-work-${skip}.rhitape`, encodeTape(modified).unwrap());
      }
    } finally {
      (await replay.dispose()).unwrap();
      raw.destroy();
    }
  }
  expect(errors).toEqual([]);
  return { works: model.works.length, rays: rays.length, masks, errors };
}
