import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { createRayPathTracer, type RayPathInitialRay } from '../../raytracing/path-tracer';
import type { RayPathFixture } from './path-tracer.commands';
import { plane, readBuffer } from './path-tracer.fixture';

/** External visible-surface rays reuse the complete material/coverage transport. */
export async function verifyInitialPathRays(fixture: RayPathFixture) {
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const material = fixture.materials.find((m) => m.name === 'emission');
  assert(material);
  const mutableOrigin: [number, number, number] = [0, 0, 2];
  const rays: RayPathInitialRay[] = [
    {
      origin: mutableOrigin,
      direction: [0, 0, -1],
      coneWidth: 0.02,
      coneSpread: 0.1,
      active: true,
    },
    { origin: [0, 0, 2], direction: [0, 0, 1], coneWidth: 0, coneSpread: 0, active: true },
    { origin: [0, 0, 2], direction: [0, 0, -1], coneWidth: 0, coneSpread: 0, active: false },
    { origin: [1, 0, 2], direction: [0, 0, -1], coneWidth: 0.03, coneSpread: 0.2, active: true },
  ];
  const creating = createRayPathTracer(device, recorder.backend.createShaderModule, {
    kernel: fixture.kernel,
    scene: buildRaySurfaceScene([plane()]).unwrap(),
    materials: [{ id: 0, ...material }],
    lights: [],
    settings: {
      width: 2,
      height: 2,
      rays,
      maxBounces: 1,
      seed: 47,
      environment: [0, 0, 0],
      maxDistance: 120,
    },
  });
  mutableOrigin[2] = -10;
  const tracer = (await creating).unwrap();
  const submit = (reset = false) => {
    const e = device.createCommandEncoder({}).unwrap();
    if (reset) tracer.reset(e).unwrap();
    tracer.recordSample(e).unwrap();
    device.queue.submit([e.finish().unwrap()]).unwrap();
  };
  let bytes: Uint8Array, live: Uint8Array, reset: Uint8Array;
  try {
    submit();
    submit();
    const pending = recorder.captureFrame();
    (await recorder.frameBoundary()).unwrap();
    submit();
    live = await readBuffer(device, tracer.buffers.accumulation, 4 * 80);
    submit(true);
    reset = await readBuffer(device, tracer.buffers.accumulation, 4 * 80);
    (await recorder.frameBoundary()).unwrap();
    bytes = (await pending).unwrap().bytes;
    const floats = new Float32Array(live.buffer),
      words = new Uint32Array(live.buffer);
    const expected = [
      [2, 1, 0.5],
      [0, 0, 0],
      [0, 0, 0],
      [2, 1, 0.5],
    ];
    for (let i = 0; i < 4; i++) {
      expect(words[i * 20 + 3]).toBe(3);
      expect(words[i * 20 + 7]).toBe(0);
      for (let c = 0; c < 3; c++)
        expect(floats[i * 20 + c]).toBeCloseTo(expected[i]?.[c] ?? NaN, 5);
    }
  } finally {
    tracer.dispose();
    (await recorder.dispose()).unwrap();
  }
  const tape = decodeTape(bytes).unwrap(),
    model = buildFrameModel(tape);
  const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const replay = (
    await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
  ).unwrap();
  try {
    const generation = model.works[0];
    assert(generation);
    expect(generation.pipeline.shaders[0]?.entryPoint).toBe('generateInitialRays');
    const paths = generation.bindings.find((b) => b.binding === 1);
    assert(paths?.resourceId);
    const source = (await replay.readResourceAtWork(paths.resourceId, 0)).unwrap().bytes;
    const generated = new Float32Array(source.buffer, source.byteOffset, source.byteLength / 4);
    expect(Array.from(generated.slice(0, 3))).toEqual([0, 0, 2]);
    expect(generated[3]).toBeCloseTo(0.02, 6);
    expect(generated[7]).toBeCloseTo(0.1, 6);
    const accumulations = model.works.filter((w) =>
      w.pipeline.shaders.some((s) => s.entryPoint === 'accumulate'),
    );
    expect(accumulations).toHaveLength(2);
    for (const [i, w] of accumulations.entries()) {
      const output = w.bindings.find((b) => b.binding === 6);
      assert(output?.resourceId);
      expect(
        (await replay.readResourceAtWork(output.resourceId, w.workIndex)).unwrap().bytes,
      ).toEqual(i === 0 ? live : reset);
    }
  } finally {
    (await replay.dispose()).unwrap();
  }
  return { bytes, live };
}
