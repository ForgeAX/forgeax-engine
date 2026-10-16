import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  inspectBufferRecords,
  openReplay,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createRayReferenceQuery } from '../../raytracing/query';
import { buildRayReferenceScene, traceReferenceRay } from '../../raytracing/scene';
import { referenceCorpus } from './corpus';

export async function verifyRayReference(kernel: string) {
  const { scene, rays } = referenceCorpus();
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const query = (
    await createRayReferenceQuery(device, recorder.backend.createShaderModule, kernel, scene, rays)
  ).unwrap();
  const capture = recorder.captureFrame();
  (await recorder.frameBoundary()).unwrap();
  const submit = () => {
    const encoder = device.createCommandEncoder({}).unwrap();
    query.record(encoder).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
  };
  submit();
  // A later work overwrites the same output; selected-work inspection must not return the final state.
  const masked = scene.triangles.slice();
  const maskedView = new DataView(masked.buffer);
  for (let i = 0; i < scene.triangleCount; i++) maskedView.setUint32(i * 80 + 64, 0, true);
  device.queue.writeBuffer(query.buffers.triangles, 0, masked).unwrap();
  submit();
  await device.queue.onSubmittedWorkDone();
  (await recorder.frameBoundary()).unwrap();
  const bytes = (await capture).unwrap().bytes;
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(2);
  const firstWork = model.works[0];
  assert(firstWork);
  const binding = (slot: number) => {
    const id = firstWork.bindings.find((b) => b.binding === slot)?.resourceId;
    assert(id);
    return id;
  };
  const outputId = binding(3);
  expect(outputId).toBeTruthy();
  // Close the original resources before replay: no process-local buffers can rescue the tape.
  query.dispose();
  expect(query.record(device.createCommandEncoder({}).unwrap()).ok).toBe(false);
  (await recorder.dispose()).unwrap();
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    const layout = {
      stride: 32,
      fields: [
        { name: 'ids', offset: 0, type: 'u32' as const, components: 4 as const },
        { name: 'metrics', offset: 16, type: 'f32' as const, components: 4 as const },
      ],
    };
    let hitCount = 0;
    for (let first = 0; first < rays.length; first += 4096) {
      const records = (
        await inspectBufferRecords(replay, outputId, 0, layout, {
          first,
          count: Math.min(4096, rays.length - first),
        })
      ).unwrap();
      expect(records.provenance.selectedWorkIndex).toBe(0);
      for (const row of records.records) {
        const ray = rays[row.index];
        assert(ray);
        const expected = traceReferenceRay(scene, ray);
        const ids = row.fields.ids,
          metrics = row.fields.metrics;
        assert(ids && metrics);
        if (expected === null) {
          expect(ids[0], `ray ${row.index}`).toBe(0xffffffff);
          expect(metrics[0]).toBe(-1);
        } else {
          hitCount++;
          expect(ids, `ray ${row.index}`).toEqual([
            expected.instanceId,
            expected.geometryId,
            expected.primitiveId,
            expected.materialId,
          ]);
          expect(metrics[0]).toBeCloseTo(expected.t, 4);
          expect(metrics[1]).toBeCloseTo(expected.barycentrics[0], 4);
          expect(metrics[2]).toBeCloseTo(expected.barycentrics[1], 4);
          expect(metrics[3]).toBe(expected.frontFace ? 1 : 0);
        }
      }
    }
    expect(hitCount).toBeGreaterThan(100);
    const final = (
      await inspectBufferRecords(replay, outputId, 1, layout, { first: 0, count: 8 })
    ).unwrap();
    expect(final.records.every((row) => row.fields.ids?.[0] === 0xffffffff)).toBe(true);
    expect(
      (await inspectBufferRecords(replay, outputId, 99, layout, { first: 0, count: 1 })).ok,
    ).toBe(false);
    const capturedTriangles = (await replay.readResourceAtWork(binding(0), 0)).unwrap().bytes;
    const capturedRays = (await replay.readResourceAtWork(binding(2), 0)).unwrap().bytes;
    const output = (await replay.readResourceAtWork(outputId, 0)).unwrap().bytes;
    const packet = { triangles: words(capturedTriangles, 20), rays: words(capturedRays, 12) };
    // Empty replacement goes through a live device rather than relying on a CPU-only miss.
    const emptyQuery = (
      await createRayReferenceQuery(
        fresh,
        webgpu.createShaderModule,
        kernel,
        buildRayReferenceScene([]).unwrap(),
        rays.slice(0, 1),
      )
    ).unwrap();
    const encoder = fresh.createCommandEncoder({}).unwrap();
    emptyQuery.record(encoder).unwrap();
    const staging = fresh.createBuffer({ size: 32, usage: 9 }).unwrap();
    encoder.copyBufferToBuffer(emptyQuery.buffers.hits, 0, staging, 0, 32);
    fresh.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await staging.mapAsync(1)).unwrap();
    expect(new Uint32Array(mapped.getMappedRange().unwrap())[0]).toBe(0xffffffff);
    mapped.unmap();
    fresh.destroyBuffer(staging).unwrap();
    emptyQuery.dispose();
    return { bytes, packet, output, rayCount: rays.length, hitCount };
  } finally {
    (await replay.dispose()).unwrap();
  }
}

function words(bytes: Uint8Array, stride: number): number[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / (stride * 4) }, (_, i) =>
    Array.from({ length: stride }, (_, j) => view.getUint32((i * stride + j) * 4, true)),
  );
}
