import {
  buildMeshDistanceField,
  buildVisibilityDistanceField,
  decodeMeshDistanceField,
  encodeMeshDistanceField,
} from '@forgeax/engine-geometry';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import type { ReferenceRay } from '../../raytracing/scene';
import { createSdfQuery, packSdfScene, type SdfQuery } from '../../raytracing/sdf-query';
import { readBuffer } from './path-tracer.fixture';
import { sdfCubeIndices, sdfCubePositions } from './sdf-cards.geometry';
import { createStorageDecodeProbe } from './sdf-storage-decode.fixture';

export async function verifySdfStorage(
  onCapture?: (tape: Uint8Array, live: readonly Uint8Array[]) => Promise<void>,
) {
  const sampled = (
    await buildVisibilityDistanceField([-1, -1, 0, 1, -1, 0, 0, 1, 0.4], [0, 1, 2], {
      voxelSize: 0.35,
      triangleSidedness: [1],
    })
  ).unwrap();
  const geometric = (
    await buildMeshDistanceField(sdfCubePositions, sdfCubeIndices, { resolution: 8 })
  ).unwrap();
  const extended = (
    await buildVisibilityDistanceField([0, 0, 0, 509, 0, 0, 0, 1, 0], [0, 1, 2], {
      voxelSize: 1,
      triangleSidedness: [1],
    })
  ).unwrap();
  const extendedArtifact = (await encodeMeshDistanceField(extended)).unwrap();
  const loaded = (await decodeMeshDistanceField(extendedArtifact, extended.meshDigest)).unwrap();
  expect(loaded.dimensions).toEqual([514, 6, 6]);
  expect(sampled.dimensions.reduce((a, b) => a * b) % 2).not.toBe(0);
  const sparse = (
    await buildVisibilityDistanceField(
      [-15, -5, -9, -14.8, -5, -9, -15, -4.8, -9, 15, 5, 9, 15.2, 5, 9, 15, 5.2, 9],
      [0, 1, 2, 3, 4, 5],
      { voxelSize: 0.08, triangleSidedness: [1, 1] },
    )
  ).unwrap();
  expect(sparse.dimensions.reduce((a, b) => a * b)).toBeGreaterThan(8_388_608);
  expect(sparse.bricks.byteLength + sparse.values.byteLength).toBeLessThan(1024 * 1024);
  const transform = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const sources = [
    { instanceId: 1, geometryId: 2, mask: 255, transform: transform(0), field: sampled },
    { instanceId: 3, geometryId: 4, mask: 255, transform: transform(10), field: geometric },
    { instanceId: 5, geometryId: 2, mask: 255, transform: transform(20), field: sampled },
    { instanceId: 7, geometryId: 6, mask: 255, transform: transform(1000), field: loaded },
    { instanceId: 9, geometryId: 8, mask: 255, transform: transform(2000), field: sparse },
  ];
  const rays: ReferenceRay[] = [0, 10, 20].map((x) => ({
    origin: [x, 0, 3] as const,
    direction: [0, 0, -1] as const,
    tMin: 0,
    tMax: 6,
    mask: 255,
  }));
  // The queried cell is beyond the old 258-axis limit; decoding alone is not GPU proof.
  rays.push({ origin: [1300, 0.25, 3], direction: [0, 0, -1], tMin: 0, tMax: 6, mask: 255 });
  rays.push({
    origin: [1985.05, -4.95, -8.65],
    direction: [0, 0, -1],
    tMin: 0,
    tMax: 1,
    mask: 255,
  });
  rays.push({ origin: [2000, 0, 0], direction: [0, 0, -1], tMin: 0, tMax: 0.25, mask: 255 });
  const hitBytes = rays.length * 64;
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
  const queries: SdfQuery[] = [];
  const live: Uint8Array[] = [];
  let tapeBytes: Uint8Array;
  let decode: Awaited<ReturnType<typeof createStorageDecodeProbe>> | undefined;
  try {
    const strict = sources[1];
    assert(strict);
    for (const source of [sources, [strict]])
      queries.push(
        (await createSdfQuery(device, recorder.backend.createShaderModule, source, rays)).unwrap(),
      );
    assert(queries[0]);
    decode = await createStorageDecodeProbe(
      device,
      recorder.backend.createShaderModule,
      sources,
      queries[0].buffers,
    );
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const query of queries) query.record(encoder).unwrap();
    decode.record(encoder);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await recorder.frameBoundary()).unwrap();
    tapeBytes = (await capture).unwrap().bytes;
    for (const query of queries) live.push(await readBuffer(device, query.buffers.hits, hitBytes));
    const decoded = await readBuffer(device, decode.output, decode.size);
    live.push(decoded);
    await onCapture?.(tapeBytes, live);
    const pairs = new Uint32Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 4);
    let mismatches = 0;
    for (let i = 0; i < pairs.length; i += 2) if (pairs[i] !== pairs[i + 1]) mismatches++;
    expect(mismatches).toBe(0);
    const [combinedBytes, baselineBytes] = live;
    assert(combinedBytes && baselineBytes);
    const combined = new DataView(
      combinedBytes.buffer,
      combinedBytes.byteOffset,
      combinedBytes.byteLength,
    );
    const baseline = new DataView(
      baselineBytes.buffer,
      baselineBytes.byteOffset,
      baselineBytes.byteLength,
    );
    for (const [i, status, instance] of [
      [0, 5, 1],
      [1, 1, 3],
      [2, 5, 5],
      [3, 5, 7],
      [4, 5, 9],
    ] as const) {
      expect(combined.getUint32(i * 64, true)).toBe(status);
      expect(combined.getUint32(i * 64 + 4, true)).toBe(instance);
    }
    expect(combined.getUint32(5 * 64, true)).toBe(0);
    expect(combined.getFloat32(16, true)).toBeCloseTo(combined.getFloat32(144, true), 5);
    expect(Math.abs(combined.getFloat32(16, true) - 2.8)).toBeLessThan(sampled.spacing);
    expect(Math.abs(combined.getFloat32(3 * 64 + 16, true) - 3)).toBeLessThan(loaded.spacing);
    // The strict geometric branch retains its old scalar values and result.
    expect(combinedBytes.subarray(64, 88)).toEqual(baselineBytes.subarray(64, 88));
    expect(combinedBytes.subarray(92, 128)).toEqual(baselineBytes.subarray(92, 128));
    expect(baseline.getUint32(0, true)).toBe(0);
    expect(baseline.getUint32(128, true)).toBe(0);
  } finally {
    decode?.dispose();
    for (const query of queries) query.dispose();
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
  const tape = decodeTape(tapeBytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(3);
  expect(model.unseededResources).toEqual([]);
  const work = model.works[0];
  assert(work);
  const samples = work.bindings.find((b) => b.binding === 1)?.resourceId;
  const resource = tape.bootstrap.find((r) => r.handleId === samples);
  const seed = resource?.initialData[0];
  assert(seed);
  const blob = tape.blobs.find((b) => b.hash === seed.hash);
  assert(blob);
  const bytes = blob.bytes;
  expect(bytes).toEqual(packSdfScene(sources).unwrap().fields);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const freshRaw = webgpu._internal_getRawDevice(fresh);
  assert(freshRaw);
  freshRaw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [i, item] of model.works.entries()) {
      const result = item.bindings.find((b) => b.binding === 3)?.resourceId;
      assert(result);
      expect((await replay.readResource(result)).unwrap().bytes.every((b) => b === 0)).toBe(true);
      expect((await replay.readResourceAtWork(result, item.workIndex)).unwrap().bytes).toEqual(
        live[i],
      );
    }
  } finally {
    (await replay.dispose()).unwrap();
    freshRaw.destroy();
  }
  expect(errors).toEqual([]);
  return { tape: tapeBytes, live };
}
