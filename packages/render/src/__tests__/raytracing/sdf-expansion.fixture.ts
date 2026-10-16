import { buildVisibilityDistanceField, createBoxGeometry } from '@forgeax/engine-geometry';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createSdfQuery, type SdfQuery, SdfQueryStatus } from '../../raytracing/sdf-query';
import { readBuffer } from './path-tracer.fixture';

/** Fixed geometry and rays distinguish missing near occlusion from extra occlusion. */
export async function verifySdfExpansion(
  onCapture?: (tape: Uint8Array, live: readonly Uint8Array[]) => Promise<void>,
) {
  const positions: number[] = [],
    indices: number[] = [];
  for (const [center, size] of [
    [
      [-0.1, 0, 0],
      [0.2, 0.8, 0.8],
    ],
    [
      [0.115, 0.043, 0.012],
      [0.01, 0.15, 0.04],
    ],
    [
      [2, 0, 0],
      [0.1, 0.8, 0.8],
    ],
  ] as const) {
    const mesh = createBoxGeometry(size[0], size[1], size[2]).unwrap(),
      base = positions.length / 3;
    const points = mesh.attributes?.position;
    assert(points instanceof Float32Array);
    assert(mesh.indices);
    positions.push(...Array.from(points, (v, i) => v + (center[i % 3] ?? 0)));
    indices.push(...Array.from(mesh.indices, (i) => base + i));
  }
  const field = (
    await buildVisibilityDistanceField(positions, indices, {
      voxelSize: 0.125,
      triangleSidedness: new Uint8Array(indices.length / 3),
    })
  ).unwrap();
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const source = { instanceId: 0, geometryId: 0, mask: 255, transform: identity, field };
  const ray = {
    origin: [0.0001, 0.043, 0.012] as const,
    direction: [1, 0, 0] as const,
    tMin: 0,
    tMax: 3,
    mask: 255,
  };
  const rays = [ray, { ...ray, origin: [0.0001, 0.043, 0.08] as const }, { ...ray, mask: 0 }];
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
  const queries: SdfQuery[] = [],
    live: Uint8Array[] = [];
  let bytes: Uint8Array;
  try {
    for (const visibilityExpansion of ['clearance', 'ray-distance'] as const)
      queries.push(
        (
          await createSdfQuery(device, recorder.backend.createShaderModule, [source], rays, {
            maxSteps: 512,
            visibilityExpansion,
          })
        ).unwrap(),
      );
    queries.push(
      (
        await createSdfQuery(
          device,
          recorder.backend.createShaderModule,
          [
            {
              ...source,
              transform: identity.map((v, i) => (i === 0 || i === 5 || i === 10 ? 2 : v)),
            },
          ],
          [{ ...ray, origin: [0.0002, 0.086, 0.024], tMax: 6 }],
          { maxSteps: 512, visibilityExpansion: 'ray-distance' },
        )
      ).unwrap(),
    );
    queries.push(
      (
        await createSdfQuery(
          device,
          recorder.backend.createShaderModule,
          [source],
          [{ ...ray, direction: [2, 0, 0], tMax: 1.5 }],
          { maxSteps: 512, visibilityExpansion: 'ray-distance' },
        )
      ).unwrap(),
    );
    queries.push(
      (
        await createSdfQuery(device, recorder.backend.createShaderModule, [source], rays, {
          maxSteps: 1,
          visibilityExpansion: 'ray-distance',
        })
      ).unwrap(),
    );
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    for (const query of queries) query.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await recorder.frameBoundary()).unwrap();
    bytes = (await pending).unwrap().bytes;
    for (const query of queries)
      live.push(await readBuffer(device, query.buffers.hits, query.rayCount * 64));
    await onCapture?.(bytes, live);
    const view = (i: number) => {
      const data = live[i];
      assert(data);
      return new DataView(data.buffer, data.byteOffset, data.byteLength);
    };
    const near = view(1).getFloat32(16, true);
    expect(view(0).getFloat32(16, true)).toBeGreaterThan(1.5);
    // Actual first intersection is 0.1099 m; the declared approximate policy
    // must recover this near neighbor without accepting the receiver at t=0.
    expect(near).toBeGreaterThan(0.075);
    expect(near).toBeLessThan(0.16);
    for (const i of [0, 1]) {
      expect(view(i).getUint32(0, true)).toBe(SdfQueryStatus.visibilityHit);
      expect(view(i).getFloat32(80, true)).toBeGreaterThan(1.5);
      expect(view(i).getUint32(128, true)).toBe(SdfQueryStatus.miss);
    }
    expect(view(2).getFloat32(16, true)).toBeCloseTo(near * 2, 5);
    expect(view(3).getFloat32(16, true)).toBeCloseTo(near / 2, 5);
    expect(view(4).getUint32(0, true)).toBe(SdfQueryStatus.stepBudget);
    expect(view(4).getUint32(128, true)).toBe(SdfQueryStatus.miss);
  } finally {
    for (const query of queries) query.dispose();
    (await recorder.dispose()).unwrap();
    native.destroy();
  }
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(5);
  expect(model.unseededResources).toEqual([]);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = webgpu._internal_getRawDevice(fresh);
  assert(raw);
  raw.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [i, work] of model.works.entries()) {
      const result = work.bindings.find((b) => b.binding === 3)?.resourceId;
      const settings = work.bindings.find((b) => b.binding === 4)?.resourceId;
      assert(result);
      assert(settings);
      expect((await replay.readResource(result)).unwrap().bytes.every((b) => b === 0)).toBe(true);
      const input = (await replay.readResource(settings)).unwrap().bytes;
      expect(new DataView(input.buffer, input.byteOffset).getUint32(8, true)).toBe(i === 0 ? 0 : 1);
      expect(
        Array.from((await replay.readResourceAtWork(result, work.workIndex)).unwrap().bytes),
      ).toEqual(Array.from(live[i] ?? []));
    }
  } finally {
    (await replay.dispose()).unwrap();
    raw.destroy();
  }
  expect(errors).toEqual([]);
  return { tape: bytes, live };
}
