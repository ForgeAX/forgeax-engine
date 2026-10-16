import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createRayReferenceQuery, type RayReferenceQuery } from '../../raytracing/query';
import { type ReferenceRay, traceReferenceRay } from '../../raytracing/scene';
import { resolveVisibleSurface } from '../../raytracing/visible-surface';
import { readBuffer } from './path-tracer.fixture';
import { retainedTransportPlane } from './scene-projection.fixture';

/** Retained edits reach real traversal; replay must recover every retired generation. */
export async function verifyRetainedRayScene(kernel: string) {
  const source = retainedTransportPlane({ kind: 'material' });
  const first = source.project();
  source.update(60, 32);
  const offscreen = source.project();
  source.update(30);
  const moved = source.project();
  source.retained.apply([{ kind: 'remove', worldId: 0, entityKey: 32 }]);
  source.update(-60, 33);
  const reused = source.project();
  const projections = [first, offscreen, moved, reused];
  const rays: ReferenceRay[] = [0, 30, 60, -60].map((x) => ({
    origin: [x, 1, 2],
    direction: [0, 0, -1],
    tMin: 0,
    tMax: 10,
    mask: 255,
  }));
  const expectedEntities = [
    [31, null, null, null],
    [31, null, 32, null],
    [null, 31, 32, null],
    [null, 31, null, 33],
  ];
  const recorder = attachRecorder(webgpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const raw = webgpu._internal_getRawDevice(
    recorder.backend.unwrapDeviceForSurface(device).unwrap(),
  );
  assert(raw);
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const queries: RayReferenceQuery[] = [];
  const outputs: Uint8Array[] = [];
  const facts: { stage: number; ray: number; entity: number | null; generation: number | null }[] =
    [];
  let bytes: Uint8Array;
  try {
    // Initialization occurs before capture: replay has to seed the actual retained inputs.
    for (const projection of projections)
      queries.push(
        (
          await createRayReferenceQuery(
            device,
            recorder.backend.createShaderModule,
            kernel,
            projection.scene,
            rays,
          )
        ).unwrap(),
      );
    const capture = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    for (const [stage, query] of queries.entries()) {
      const encoder = device.createCommandEncoder({}).unwrap();
      query.record(encoder).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const output = await readBuffer(device, query.buffers.hits, rays.length * 32);
      outputs.push(output);
      const words = new Uint32Array(output.buffer),
        floats = new Float32Array(output.buffer);
      const projection = projections[stage];
      assert(projection);
      for (const [ray, input] of rays.entries()) {
        const expected = expectedEntities[stage]?.[ray];
        const cpu = traceReferenceRay(projection.scene, input);
        if (expected === null) {
          expect(cpu).toBeNull();
          expect(words[ray * 8]).toBe(0xffffffff);
          expect(floats[ray * 8 + 4]).toBe(-1);
          facts.push({ stage, ray, entity: null, generation: null });
        } else {
          assert(cpu);
          expect(Array.from(words.subarray(ray * 8, ray * 8 + 4))).toEqual([
            cpu.instanceId,
            cpu.geometryId,
            cpu.primitiveId,
            cpu.materialId,
          ]);
          expect(floats[ray * 8 + 4]).toBe(2);
          const identity = resolveVisibleSurface(
            projection.surfaces,
            cpu.instanceId,
            cpu.primitiveId,
          ).unwrap();
          assert(identity);
          expect(identity.entityKey).toBe(expected);
          facts.push({ stage, ray, entity: identity.entityKey, generation: identity.generation });
        }
      }
    }
    (await recorder.frameBoundary()).unwrap();
    bytes = (await capture).unwrap().bytes;
    expect(errors).toEqual([]);
  } finally {
    for (const query of queries) query.dispose();
    (await recorder.dispose()).unwrap();
  }
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  expect(model.works).toHaveLength(4);
  const fresh = (await (await webgpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: webgpu.createShaderModule })
  ).unwrap();
  try {
    for (const [stage, work] of model.works.entries()) {
      const id = work.bindings.find((binding) => binding.binding === 3)?.resourceId;
      assert(id);
      const replayed = (await replay.readResourceAtWork(id, work.workIndex)).unwrap();
      expect(Array.from(replayed.bytes)).toEqual(Array.from(outputs[stage] ?? []));
    }
  } finally {
    await replay.dispose();
  }
  const removed = facts.find((fact) => fact.stage === 2 && fact.entity === 32);
  const replacement = facts.find((fact) => fact.stage === 3 && fact.entity === 33);
  assert(removed && replacement);
  expect(replacement.generation).not.toBe(removed.generation);
  return { bytes, outputs, facts };
}
