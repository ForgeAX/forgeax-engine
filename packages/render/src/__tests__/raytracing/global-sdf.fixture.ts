import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import {
  createGlobalSdfComposition,
  type GlobalSdfComposition,
  type GlobalSdfGrid,
} from '../../raytracing/global-sdf';
import type { SdfMeshInstance } from '../../raytracing/sdf-query';
import { readBuffer } from './path-tracer.fixture';
import type { SdfCardsFixture } from './sdf-cards.commands';
import { sdfCubeInstance } from './sdf-cards.fixture';

export async function verifyGlobalSdf(fixture: SdfCardsFixture) {
  const field = {
    ...fixture.field,
    bricks: Uint32Array.from(fixture.field.bricks),
    values: Float32Array.from(fixture.field.values),
  };
  const sheet = {
    ...fixture.sheet.field,
    bricks: Uint32Array.from(fixture.sheet.field.bricks),
    values: Float32Array.from(fixture.sheet.field.values),
  };
  assert(sheet.policy.kind !== 'sampled-visibility');
  const cube: SdfMeshInstance = { ...sdfCubeInstance, field };
  const plane: SdfMeshInstance = { ...cube, instanceId: 2, field: sheet };
  const missing: SdfMeshInstance = { ...cube, field: { missing: true, bounds: field.bounds } };
  const grid: GlobalSdfGrid = {
    origin: [-2, -2, -2],
    dimensions: [9, 9, 9],
    spacing: 0.5,
    maxDistance: 2,
    coverageDistance: 0.25,
  };
  const one: GlobalSdfGrid = { ...grid, origin: [1, 0, 0], dimensions: [1, 1, 1] };
  const absentGrid: GlobalSdfGrid = {
    ...grid,
    origin: [-3, -3, -3],
    dimensions: [7, 7, 7],
    spacing: 1,
    maxDistance: 0.5,
  };
  const scaled = (x: number): SdfMeshInstance => ({
    ...cube,
    transform: [x, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1],
  });
  const cases = [
    { name: 'cube', source: [cube], grid },
    { name: 'sheet', source: [plane], grid },
    { name: 'mixed', source: [plane, cube], grid: one },
    { name: 'missing', source: [missing], grid: absentGrid },
    { name: 'masked', source: [{ ...missing, mask: 0 }], grid: absentGrid },
    { name: 'empty', source: [], grid },
    { name: 'tie', source: [cube, { ...cube, instanceId: 2 }], grid: one },
    { name: 'scaled', source: [scaled(2)], grid },
    { name: 'mirrored', source: [scaled(-2)], grid },
    {
      name: 'many',
      source: Array.from({ length: 65 }, (_, instanceId) => ({ ...cube, instanceId })),
      grid,
    },
    {
      name: 'missing-sheet',
      source: [{ ...missing, field: { missing: true as const, bounds: sheet.bounds } }],
      grid,
    },
    { name: 'partial', source: [cube, { ...missing, instanceId: 99 }], grid: one },
  ];
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const recorded = device as typeof device & { readonly _realDevice: typeof device };
  const raw = webgpu._internal_getRawDevice(recorded._realDevice),
    errors: string[] = [];
  assert(raw, 'original native device must expose validation and cleanup');
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const owned: GlobalSdfComposition[] = [],
    live: Uint8Array[] = [],
    counts: Record<string, number>[] = [];
  let tapeBytes: Uint8Array;
  try {
    for (const c of cases)
      owned.push(
        (
          await createGlobalSdfComposition(
            device,
            recorder.backend.createShaderModule,
            c.source,
            c.grid,
          )
        ).unwrap(),
      );
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const c of owned) c.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    for (const [caseIndex, c] of cases.entries()) {
      const composition = owned[caseIndex];
      assert(composition);
      const bytes = await readBuffer(
        device,
        composition.buffers.voxels,
        composition.voxelCount * 16,
      );
      live.push(bytes);
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        count = { complete: 0, missing: 0, twoSided: 0 };
      for (let i = 0; i < composition.voxelCount; i++) {
        const dims = c.grid.dimensions;
        const p = [
          i % dims[0],
          Math.floor(i / dims[0]) % dims[1],
          Math.floor(i / (dims[0] * dims[1])),
        ].map((n, a) => (c.grid.origin[a] ?? 0) + n * c.grid.spacing);
        const distance = v.getFloat32(i * 16, true),
          coverage = v.getFloat32(i * 16 + 4, true),
          status = v.getUint32(i * 16 + 8, true),
          owner = v.getUint32(i * 16 + 12, true);
        expect(Number.isFinite(distance)).toBe(true);
        expect([0, 1]).toContain(coverage);
        expect([1, 2]).toContain(status);
        if (status === 2) count.missing++;
        else count.complete++;
        if (coverage === 0) count.twoSided++;
        if (c.name === 'missing' || c.name === 'missing-sheet') {
          const outside = Math.hypot(
            ...p.map((n, a) =>
              Math.max(Math.abs(n) - (c.name === 'missing-sheet' && a === 2 ? 0 : 1), 0),
            ),
          );
          expect(status).toBe(outside < c.grid.maxDistance ? 2 : 1);
          continue;
        }
        expect(status).toBe(c.name === 'partial' ? 2 : 1);
        if (c.name === 'empty' || c.name === 'masked') {
          expect(distance).toBe(c.grid.maxDistance);
          expect(owner).toBe(0xffffffff);
          expect(coverage).toBe(1);
          continue;
        }
        if (c.name === 'mixed' || c.name === 'tie') {
          expect(Math.abs(distance)).toBeLessThan(field.policy.errorBound + 1e-4);
          expect(coverage).toBe(1);
          if (c.name === 'tie') expect(owner).toBe(2);
          continue;
        }
        const scales = c.name === 'scaled' || c.name === 'mirrored' ? [2, 0.5, 1.5] : [1, 1, 1];
        const q = p.map((n, a) => Math.abs(n) - (scales[a] ?? 1));
        const box = Math.hypot(...q.map((n) => Math.max(n, 0))) + Math.min(0, Math.max(...q));
        let expected: number;
        if (c.name === 'sheet')
          expected = Math.hypot(
            Math.max(Math.abs(p[0] ?? 0) - 1, 0),
            Math.max(Math.abs(p[1] ?? 0) - 1, 0),
            p[2] ?? 0,
          );
        else {
          const local = p.map((n, a) => Math.min(1, Math.abs(n) / (scales[a] ?? 1)));
          expected = Math.max(
            (Math.max(...local) - 1) * Math.min(...scales) + Math.max(box, 0),
            box,
          );
        }
        expected = Math.max(-c.grid.maxDistance, Math.min(expected, c.grid.maxDistance));
        expect(Math.abs(distance - expected)).toBeLessThan(
          field.policy.errorBound + sheet.policy.errorBound + 1e-4,
        );
        if (
          c.name === 'sheet' &&
          Math.abs(expected - c.grid.coverageDistance) > sheet.policy.errorBound + 1e-4
        )
          expect(coverage).toBe(expected < c.grid.coverageDistance ? 0 : 1);
        if (c.name !== 'sheet') expect(coverage).toBe(1);
      }
      counts.push(count);
    }
    expect(errors).toEqual([]);
  } finally {
    for (const c of owned) c.dispose();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
  const positive = live[7],
    negative = live[8];
  assert(positive && negative);
  const pv = new DataView(positive.buffer, positive.byteOffset, positive.byteLength);
  const nv = new DataView(negative.buffer, negative.byteOffset, negative.byteLength);
  // Mirroring reverses trilinear summation order; compare distance numerically.
  // State, coverage and identity must remain exact. Live/replay stays byte-exact.
  for (let i = 0; i < positive.length; i += 16) {
    expect(Math.abs(pv.getFloat32(i, true) - nv.getFloat32(i, true))).toBeLessThan(1e-6);
    expect(positive.subarray(i + 4, i + 16)).toEqual(negative.subarray(i + 4, i + 16));
  }
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(cases.length);
  expect(model.unseededResources).toEqual([]);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const freshRaw = webgpu._internal_getRawDevice(fresh);
  assert(freshRaw, 'replay native device must expose validation and cleanup');
  freshRaw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const resources = model.works.map((w) => {
      const id = w.bindings.find((b) => b.binding === 4)?.resourceId;
      assert(id);
      return id;
    });
    for (const id of resources)
      expect((await replay.readResource(id)).unwrap().bytes.every((v) => v === 0)).toBe(true);
    for (const [i, id] of resources.entries())
      expect((await replay.readResourceAtWork(id, i)).unwrap().bytes).toEqual(live[i]);
  } finally {
    (await replay.dispose()).unwrap();
    freshRaw.destroy();
  }
  expect(errors).toEqual([]);
  return {
    tape: tapeBytes,
    live,
    counts,
    cases: cases.map((c) => ({ name: c.name, grid: c.grid })),
    works: model.works.map((w) => ({ workIndex: w.workIndex, eventIndex: w.eventIndex })),
  };
}
