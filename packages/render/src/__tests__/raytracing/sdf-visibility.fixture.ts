import {
  buildVisibilityDistanceField,
  decodeMeshDistanceField,
  encodeMeshDistanceField,
} from '@forgeax/engine-geometry';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createGlobalSdfComposition, type GlobalSdfComposition } from '../../raytracing/global-sdf';
import {
  createSdfQuery,
  type SdfMeshInstance,
  type SdfQuery,
  SdfQueryStatus,
} from '../../raytracing/sdf-query';
import { readBuffer } from './path-tracer.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';

export async function verifyVisibilitySdf(
  onCapture?: (tape: Uint8Array, live: readonly Uint8Array[]) => Promise<void>,
) {
  const sheet = (
    await buildVisibilityDistanceField(
      [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
      [0, 1, 2, 0, 2, 3],
      { voxelSize: 0.125, triangleSidedness: [1, 1] },
    )
  ).unwrap();
  const solid = (
    await buildVisibilityDistanceField(sdfCubePositions, sdfCubeIndices, {
      voxelSize: 0.25,
      triangleSidedness: Array(12).fill(0),
    })
  ).unwrap();
  const dense = (
    await buildVisibilityDistanceField([-52, -52, -52, 52, -52, 52, 0, 52, 0], [0, 1, 2], {
      voxelSize: 1,
      triangleSidedness: [1],
    })
  ).unwrap();
  const denseArtifact = (await encodeMeshDistanceField(dense)).unwrap();
  expect(dense.dimensions.reduce((a, b) => a * b) * 4).toBeGreaterThan(5_000_000);
  expect(denseArtifact.byteLength).toBeLessThan(5_000_000);
  const denseDecoded = (await decodeMeshDistanceField(denseArtifact, dense.meshDigest)).unwrap();
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const plane: SdfMeshInstance = {
    instanceId: 17,
    geometryId: 23,
    mask: 255,
    transform,
    field: sheet,
  };
  const front = {
    origin: [0, 0, 2] as const,
    direction: [0, 0, -1] as const,
    tMin: 0,
    tMax: 5,
    mask: 255,
  };
  const rays = [
    front,
    { ...front, origin: [0, 0, -2] as const, direction: [0, 0, 1] as const },
    { ...front, mask: 0 },
    { ...front, origin: [3, 0, 2] as const },
  ];
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const real = (device as typeof device & { readonly _realDevice: typeof device })._realDevice;
  const native = webgpu._internal_getRawDevice(real),
    errors: string[] = [];
  assert(native);
  native.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const queries: SdfQuery[] = [];
  let composition: GlobalSdfComposition | undefined;
  const live: Uint8Array[] = [];
  let tapeBytes: Uint8Array;
  try {
    queries.push(
      (await createSdfQuery(device, recorder.backend.createShaderModule, [plane], rays)).unwrap(),
    );
    queries.push(
      (
        await createSdfQuery(device, recorder.backend.createShaderModule, [plane], [front], {
          maxSteps: 1,
        })
      ).unwrap(),
    );
    queries.push(
      (
        await createSdfQuery(
          device,
          recorder.backend.createShaderModule,
          [{ ...plane, field: { missing: true, bounds: sheet.bounds } }],
          [front],
        )
      ).unwrap(),
    );
    queries.push(
      (
        await createSdfQuery(
          device,
          recorder.backend.createShaderModule,
          [{ ...plane, field: solid }],
          [{ ...front, origin: [0, 0, 0], direction: [1, 0, 0] }],
        )
      ).unwrap(),
    );
    queries.push(
      (
        await createSdfQuery(
          device,
          recorder.backend.createShaderModule,
          [
            {
              ...plane,
              transform: [-2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 3, 0, 5, 7, 11, 1],
            },
          ],
          [{ ...front, origin: [5, 7, 17], tMax: 12 }],
        )
      ).unwrap(),
    );
    // The tilted sheet is x=z. These intersections use samples past the former
    // 1,048,576-element limit, through real artifact decode and GPU upload.
    queries.push(
      (
        await createSdfQuery(
          device,
          recorder.backend.createShaderModule,
          [{ ...plane, field: denseDecoded }],
          [
            { ...front, origin: [38, -35, 44], tMax: 12 },
            { ...front, origin: [38, -35, 32], direction: [0, 0, 1], tMax: 12 },
            { ...front, origin: [38, -35, 44], tMax: 12, mask: 0 },
          ],
        )
      ).unwrap(),
    );
    composition = (
      await createGlobalSdfComposition(device, recorder.backend.createShaderModule, [plane], {
        origin: [0, 0, -0.125],
        dimensions: [1, 1, 3],
        spacing: 0.125,
        maxDistance: 1,
        coverageDistance: 0.25,
      })
    ).unwrap();
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const query of queries) query.record(encoder).unwrap();
    composition.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    for (const query of queries)
      live.push(await readBuffer(device, query.buffers.hits, query.rayCount * 64));
    live.push(await readBuffer(device, composition.buffers.voxels, 48));
    await onCapture?.(tapeBytes, live);
    const view = (i: number) => {
      const b = live[i];
      assert(b);
      return new DataView(b.buffer, b.byteOffset, b.byteLength);
    };
    const pair = view(0);
    for (const i of [0, 1]) {
      expect(pair.getUint32(i * 64, true)).toBe(SdfQueryStatus.visibilityHit);
      expect(pair.getUint32(i * 64 + 4, true)).toBe(17);
      expect(pair.getUint32(i * 64 + 8, true)).toBe(23);
      expect(Math.abs(pair.getFloat32(i * 64 + 16, true) - 2)).toBeLessThan(0.125);
      expect(pair.getFloat32(i * 64 + 20, true)).toBe(0);
      expect(pair.getFloat32(i * 64 + 56, true)).toBeCloseTo(i === 0 ? 1 : -1, 4);
    }
    expect(pair.getUint32(128, true)).toBe(SdfQueryStatus.miss);
    expect(pair.getUint32(192, true)).toBe(SdfQueryStatus.miss);
    expect(view(1).getUint32(0, true)).toBe(SdfQueryStatus.stepBudget);
    expect(view(2).getUint32(0, true)).toBe(SdfQueryStatus.missingField);
    expect(view(3).getUint32(0, true)).toBe(SdfQueryStatus.visibilityHit);
    expect(view(3).getFloat32(28, true)).toBe(1); // sign heuristic; not a proved solid interior
    expect(view(4).getUint32(0, true)).toBe(SdfQueryStatus.visibilityHit);
    expect(Math.abs(view(4).getFloat32(16, true) - 6)).toBeLessThan(0.375);
    expect(view(4).getFloat32(32, true)).toBeCloseTo(5, 5);
    expect(view(4).getFloat32(36, true)).toBeCloseTo(7, 5);
    expect(view(4).getFloat32(56, true)).toBeCloseTo(1, 5);
    for (const i of [0, 1]) {
      const offset = i * 64;
      expect(view(5).getUint32(offset, true)).toBe(SdfQueryStatus.visibilityHit);
      // Compare perpendicular distance to the analytic plane. The ray is at
      // 45 degrees; its longitudinal error is larger by sqrt(2).
      expect(Math.abs(view(5).getFloat32(offset + 16, true) - 6) * Math.SQRT1_2).toBeLessThan(
        (Math.sqrt(3) * dense.spacing) / 2,
      );
      expect(view(5).getFloat32(offset + 56, true) * (i === 0 ? 1 : -1)).toBeGreaterThan(0.5);
    }
    expect(view(5).getUint32(128, true)).toBe(SdfQueryStatus.miss);
    assert(sheet.policy.kind === 'sampled-visibility');
    const band = sheet.policy.distanceBand;
    const nearSample = (Math.round((0.0625 / band) * 32767) / 32767) * band;
    const farSample = (Math.round((0.1875 / band) * 32767) / 32767) * band;
    for (let i = 0; i < 3; i++) {
      // The unsigned plane lies halfway between samples: interpolation has
      // a half-voxel floor. Composition preserves that approximation.
      const expected = i === 1 ? nearSample : (nearSample + farSample) / 2;
      expect(view(6).getFloat32(i * 16, true)).toBeCloseTo(expected, 7);
      expect(view(6).getFloat32(i * 16 + 4, true)).toBe(0);
      expect(view(6).getUint32(i * 16 + 8, true)).toBe(1);
      expect(view(6).getUint32(i * 16 + 12, true)).toBe(17);
    }
  } finally {
    for (const q of queries) q.dispose();
    composition?.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(7);
  expect(model.unseededResources).toEqual([]);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const freshNative = webgpu._internal_getRawDevice(fresh);
  assert(freshNative);
  freshNative.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [i, work] of model.works.entries()) {
      const output = work.bindings.find((b) => b.binding === (i === 6 ? 4 : 3))?.resourceId;
      assert(output);
      expect((await replay.readResource(output)).unwrap().bytes.every((v) => v === 0)).toBe(true);
      if (i === 0) {
        const id = work.bindings.find((b) => b.binding === 0)?.resourceId;
        assert(id);
        const bytes = (await replay.readResource(id)).unwrap().bytes;
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        expect(v.getFloat32(140, true)).toBe(1);
        expect(v.getFloat32(132, true)).toBe(0);
        expect(v.getFloat32(128, true)).toBeCloseTo((Math.sqrt(3) * 0.125) / 2, 7);
        expect(v.getFloat32(96, true)).toBe(sheet.origin[0]);
      }
    }
    for (const [i, work] of model.works.entries()) {
      const id = work.bindings.find((b) => b.binding === (i === 6 ? 4 : 3))?.resourceId;
      assert(id);
      expect((await replay.readResourceAtWork(id, i)).unwrap().bytes).toEqual(live[i]);
    }
  } finally {
    (await replay.dispose()).unwrap();
    freshNative.destroy();
  }
  expect(errors).toEqual([]);
  return {
    tape: tapeBytes,
    live,
    works: model.works.map((w) => ({ workIndex: w.workIndex, eventIndex: w.eventIndex })),
    errors,
  };
}
