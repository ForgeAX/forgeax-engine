import {
  type CompiledRenderGraph,
  RenderGraphBuilder,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { attachRecorder, buildFrameModel, decodeTape, openReplay } from '@forgeax/engine-rhi-debug';
import * as gpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect } from 'vitest';
import { createRayPathTracer } from '../../raytracing/path-tracer';
import type { RayPathFixture } from './path-tracer.commands';
import { readBuffer } from './path-tracer.fixture';
import { retainedTransportPlane } from './scene-projection.fixture';

const SOURCE = `
@group(0) @binding(0) var<storage, read_write> rays: array<vec4u>;
@group(0) @binding(1) var<uniform> control: vec4u;
@compute @workgroup_size(4) fn writeReceiverRays(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= 4u) { return; }
  let base = id.x * 5u;
  let x = select(0.0, 1.0, id.x == 3u);
  let direction = select(-1.0, 1.0, id.x == 1u || control.x == 1u);
  rays[base] = bitcast<vec4u>(vec4f(x, 0.0, 2.0, 0.02));
  rays[base + 1u] = bitcast<vec4u>(vec4f(0.0, 0.0, direction, 0.1));
  rays[base + 2u] = bitcast<vec4u>(vec4f(1.0, 1.0, 1.0, 0.0));
  rays[base + 3u] = vec4u(0u);
  rays[base + 4u] = vec4u(select(1u, 0u, id.x == 2u), 0u, 47u, 0u);
}
`;

/** A GPU producer changes the initial rays without any receiver readback or CPU ray upload. */
export async function verifyGpuPathSource(fixture: RayPathFixture, graphOwned = false) {
  const recorder = attachRecorder(gpu).unwrap();
  const device = (
    await (await recorder.backend.rhi.requestAdapter()).unwrap().requestDevice()
  ).unwrap();
  const errors: string[] = [];
  const raw = gpu._internal_getRawDevice(recorder.backend.unwrapDeviceForSurface(device).unwrap());
  assert(raw);
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  try {
    const seeds = device.createBuffer({ label: 'receiver-seeds', size: 320, usage: 0x8c }).unwrap();
    const control = device
      .createBuffer({ label: 'receiver-control', size: 16, usage: 0x48 })
      .unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 4, buffer: { type: 'storage' } },
          { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const module = (await recorder.backend.createShaderModule(device, { code: SOURCE })).unwrap();
    const pipeline = device
      .createComputePipeline({
        layout: pipelineLayout,
        compute: { module, entryPoint: 'writeReceiverRays' },
      })
      .unwrap();
    const bindings = device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer: seeds } } },
          { binding: 1, resource: { kind: 'buffer', value: { buffer: control } } },
        ],
      })
      .unwrap();
    const material = fixture.materials.find((entry) => entry.name === 'emission');
    assert(material);
    const tracer = (
      await createRayPathTracer(device, recorder.backend.createShaderModule, {
        kernel: fixture.kernel,
        scene: retainedTransportPlane(material.asset).project().scene,
        materials: [{ id: 0, ...material }],
        lights: [],
        settings: {
          width: 2,
          height: 2,
          rayBuffer: seeds,
          maxBounces: 1,
          seed: 47,
          environment: [0, 0, 0],
          maxDistance: 120,
        },
      })
    ).unwrap();
    let compiled: CompiledRenderGraph<RenderGraphFrame> | undefined;
    let activeSeeds = seeds;
    if (graphOwned) {
      const missing = tracer.addSampleToGraph(new RenderGraphBuilder<RenderGraphFrame>(), {
        label: 'missing-source',
        buffers: new Map(),
        textures: new Map(),
        reset: true,
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(JSON.stringify(missing.error)).toContain('borrowed ray buffer');
      const graph = new RenderGraphBuilder<RenderGraphFrame>();
      const source = graph
        .importBuffer('receiver-seeds', { size: 320, usage: 0x8c }, () => activeSeeds)
        .unwrap();
      const settings = graph
        .importBuffer('receiver-control', { size: 16, usage: 0x48 }, () => control)
        .unwrap();
      graph
        .addComputePass('receiver-producer', {
          accesses: [
            { resource: source, usage: 'storage-write' },
            { resource: settings, usage: 'uniform-read' },
          ],
          encode: ({ pass }) => {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindings);
            pass.dispatchWorkgroups(1);
          },
        })
        .unwrap();
      const accumulation = tracer
        .addSampleToGraph(graph, {
          label: 'diffuse',
          buffers: new Map([[seeds, source]]),
          textures: new Map(),
          reset: true,
        })
        .unwrap();
      graph
        .addCopyPass('observe-accumulation', {
          accesses: [{ resource: accumulation, usage: 'copy-src' }],
          encode: ({ resources }) => {
            expect(resources.buffer(accumulation).unwrap()).toBe(tracer.buffers.accumulation);
          },
        })
        .unwrap();
      compiled = graph.compile({ device, surfaceSize: { width: 2, height: 2 } }).unwrap();
      const inspection = compiled.inspect();
      expect(inspection.passes.filter((pass) => pass.kind === 'compute')).toHaveLength(2);
      expect(
        inspection.passes.find((pass) => pass.name.endsWith('0.ray-path.batch'))?.dependencies,
      ).toContain('receiver-producer');
      expect(
        inspection.passes.filter((pass) => pass.kind === 'copy').map((pass) => pass.name),
      ).toEqual(['diffuse.reset', 'observe-accumulation']);
    }
    const submit = (miss: boolean) => {
      device.queue.writeBuffer(control, 0, new Uint32Array([Number(miss), 0, 0, 0])).unwrap();
      const encoder = device.createCommandEncoder({}).unwrap();
      if (compiled !== undefined) compiled.execute({ encoder }).unwrap();
      else {
        const pass = encoder.beginComputePass({ label: 'receiver-producer' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(1);
        pass.end();
        tracer.reset(encoder).unwrap();
        tracer.recordSample(encoder).unwrap();
      }
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
    };
    let bytes: Uint8Array, lit: Uint8Array, dark: Uint8Array;
    try {
      const capture = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      submit(false);
      lit = await readBuffer(device, tracer.buffers.accumulation, 320);
      submit(true);
      dark = await readBuffer(device, tracer.buffers.accumulation, 320);
      (await recorder.frameBoundary()).unwrap();
      bytes = (await capture).unwrap().bytes;
      for (const [result, expected] of [
        [lit, [2, 0, 0, 2]],
        [dark, [0, 0, 0, 0]],
      ] as const) {
        const floats = new Float32Array(result.buffer, result.byteOffset, 80);
        const words = new Uint32Array(result.buffer, result.byteOffset, 80);
        for (let i = 0; i < 4; i++) {
          expect(words[i * 20 + 3]).toBe(1);
          expect(words[i * 20 + 7]).toBe(0);
          for (let channel = 0; channel < 3; channel++) {
            expect(floats[i * 20 + channel]).toBeCloseTo((expected[i] ?? NaN) / 2 ** channel, 5);
          }
        }
      }
      if (compiled !== undefined) {
        // A reused producer address cannot silently relabel frozen transport bindings.
        activeSeeds = device.createBuffer({ size: 320, usage: 0x8c }).unwrap();
        const stale = compiled.execute({ encoder: device.createCommandEncoder({}).unwrap() });
        expect(stale.ok).toBe(false);
        if (!stale.ok)
          expect(JSON.stringify(stale.error)).toContain('transport buffer generation changed');
        device.destroyBuffer(activeSeeds).unwrap();
        activeSeeds = seeds;
      }
    } finally {
      await compiled?.retire();
      tracer.dispose();
      // The transport borrows the source. Its owner can still read it after transport retirement.
      expect((await readBuffer(device, seeds, 320)).byteLength).toBe(320);
      device.destroyBuffer(seeds).unwrap();
      device.destroyBuffer(control).unwrap();
    }
    const tape = decodeTape(bytes).unwrap(),
      model = buildFrameModel(tape);
    const fresh = (await (await gpu.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const freshRaw = gpu._internal_getRawDevice(fresh);
    assert(freshRaw);
    freshRaw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    const replay = (
      await openReplay(tape, { device: fresh, createShaderModule: gpu.createShaderModule })
    ).unwrap();
    try {
      const producers = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'writeReceiverRays'),
      );
      const generators = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'generateInitialRays'),
      );
      const accumulations = model.works.filter((work) =>
        work.pipeline.shaders.some((shader) => shader.entryPoint === 'accumulate'),
      );
      expect(producers).toHaveLength(2);
      expect(generators).toHaveLength(2);
      expect(accumulations).toHaveLength(2);
      for (const [index, work] of accumulations.entries()) {
        expect(producers[index]?.workIndex).toBeLessThan(generators[index]?.workIndex ?? -1);
        expect(generators[index]?.workIndex).toBeLessThan(work.workIndex);
        const producer = producers[index];
        assert(producer);
        const source = producer.bindings.find((binding) => binding.binding === 0);
        assert(source?.resourceId);
        expect(
          generators[index]?.bindings.find((binding) => binding.binding === 0)?.resourceId,
        ).toBe(source.resourceId);
        const sourceBytes = (
          await replay.readResourceAtWork(source.resourceId, producer.workIndex)
        ).unwrap().bytes;
        const sourceFloats = new Float32Array(sourceBytes.buffer, sourceBytes.byteOffset, 80);
        expect(Array.from(sourceFloats.slice(0, 3))).toEqual([0, 0, 2]);
        expect(sourceFloats[3]).toBeCloseTo(0.02, 6);
        expect(sourceFloats[6]).toBe(index === 0 ? -1 : 1);
        expect(sourceFloats[7]).toBeCloseTo(0.1, 6);
        const output = work.bindings.find((binding) => binding.binding === 6);
        assert(output?.resourceId);
        expect(
          (await replay.readResourceAtWork(output.resourceId, work.workIndex)).unwrap().bytes,
        ).toEqual(index === 0 ? lit : dark);
      }
    } finally {
      (await replay.dispose()).unwrap();
      freshRaw.destroy();
    }
    expect(errors).toEqual([]);
    return { bytes, lit, dark };
  } finally {
    (await recorder.dispose()).unwrap();
    raw.destroy();
  }
}
