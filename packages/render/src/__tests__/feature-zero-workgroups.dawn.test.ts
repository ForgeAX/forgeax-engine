/// <reference types="@webgpu/types" />
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import type { RenderFeatureExecutionFrame } from '../features/frame-execution';
import { createRenderFeatureHost } from '../features/host';
import { freezeRenderFeaturePlan, type RenderFeatureWorkPlan } from '../features/plan';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import { RenderFeatureComputeGraphProjection } from '../features/render-graph-compute';

it('reuses one compiled graph for current zero/nonzero XYZ counts and preserves indirect work', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const raw = device.nativeDevice().unwrap();
  const errors: string[] = [];
  raw.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  raw.pushErrorScope('validation');
  const code = `@group(0) @binding(0) var<storage, read_write> count: atomic<u32>;
@compute @workgroup_size(1) fn step(){ atomicAdd(&count, 1u); }
@compute @workgroup_size(1) fn indirect(){ atomicAdd(&count, 100u); }`;
  const shader = (await createShaderModule(device, { code })).unwrap();
  const pipelines = vi.spyOn(device, 'createComputePipeline');
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const host = createRenderFeatureHost([]).unwrap();
  const session = owner.beginFeature('counts', 0);
  const programDeclaration = {
    wgsl: code,
    entryPoints: ['step', 'indirect'],
    bindings: [{ entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' as const } }] }],
  };
  const program = session.prepareProgram('program', programDeclaration).unwrap();
  const counter = session
    .prepareBuffer('counter', { size: 4, usage: ['storage', 'copy-src'], data: new Uint32Array(1) })
    .unwrap();
  const args = session
    .prepareBuffer('args', { size: 12, usage: ['indirect'], data: new Uint32Array([1, 1, 1]) })
    .unwrap();
  const bindings = session
    .prepareBindings('bindings', { program, entries: [{ binding: 0, buffer: counter }] })
    .unwrap();
  const work = (workgroups: readonly [number, number?, number?]) =>
    session
      .resolveComputePass('counts', {
        program,
        bindings,
        dispatches: [
          { entryPoint: 'step', workgroups },
          { entryPoint: 'indirect', indirect: { buffer: args, offset: 0 } },
        ],
      })
      .unwrap();
  const plan = (workgroups: readonly [number, number?, number?]): RenderFeatureWorkPlan => ({
    resources: [
      { kind: 'compute-program', name: 'program', program: programDeclaration },
      { kind: 'buffer', name: 'counter', size: 4, usage: ['storage', 'copy-src'] },
      { kind: 'buffer', name: 'args', size: 12, usage: ['indirect'] },
      {
        kind: 'compute-bindings',
        name: 'bindings',
        program: 'program',
        entries: [{ binding: 0, resource: 'counter' }],
      },
    ],
    passes: [
      {
        kind: 'compute',
        name: 'count',
        program: 'program',
        bindings: 'bindings',
        dispatches: [
          { kind: 'direct', entryPoint: 'step', workgroups },
          { kind: 'indirect', entryPoint: 'indirect', resource: 'args', offset: 0 },
        ],
      },
    ],
  });
  const initial = work([1]);
  const builder = new RenderGraphBuilder<RenderFeatureExecutionFrame>();
  new RenderFeatureComputeGraphProjection(builder)
    .addPasses([
      { name: 'count', featureIdentity: 'counts', order: 0, resolvedGpuCompute: initial },
    ])
    .unwrap();
  const graph = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
  const source = session.resolveBuffer(counter);
  if (source === undefined) throw new Error('Missing counter');
  const readback = device.createBuffer({ size: 4, usage: 1 | 8 }).unwrap();
  const recorded: number[][] = [];
  let recordedIndirect = 0;
  let expected = 0;
  let signature: string | undefined;
  const counts = [[1], [0], [1], [0, 2, 3], [2, 0, 3], [2, 3, 0], [2], [2, 3], [2, 3, 4]] as const;
  try {
    for (const currentCounts of counts) {
      const currentPlan = freezeRenderFeaturePlan('counts', plan(currentCounts)).unwrap();
      const next = host.recordPlanSignature?.('counts', currentPlan);
      if (next === undefined) throw new Error('Missing signature owner');
      signature ??= next;
      expect(next).toBe(signature);
      const current = work(currentCounts);
      expect(current.buffers).toEqual(initial.buffers);
      expect(current.dispatches.length).toBe(currentCounts.some((count) => count === 0) ? 1 : 2);
      const encoder = device.createCommandEncoder().unwrap();
      const begin = encoder.beginComputePass.bind(encoder);
      vi.spyOn(encoder, 'beginComputePass').mockImplementation((descriptor) => {
        const pass = begin(descriptor);
        const dispatch = pass.dispatchWorkgroups.bind(pass);
        const indirect = pass.dispatchWorkgroupsIndirect.bind(pass);
        vi.spyOn(pass, 'dispatchWorkgroups').mockImplementation((x, y, z) => {
          recorded.push([x, y ?? 1, z ?? 1]);
          dispatch(x, y, z);
        });
        vi.spyOn(pass, 'dispatchWorkgroupsIndirect').mockImplementation((buffer, offset) => {
          recordedIndirect += 1;
          indirect(buffer, offset);
        });
        return pass;
      });
      graph
        .execute({
          encoder,
          featureExecutions: [
            {
              featureIdentity: 'counts',
              order: 0,
              passes: [
                { featureIdentity: 'counts', order: 0, name: 'count', resolvedGpuCompute: current },
              ],
            },
          ],
        })
        .unwrap();
      encoder.copyBufferToBuffer(source.buffer, 0, readback, 0, 4);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const mapped = (await readback.mapAsync(1)).unwrap();
      expected += currentCounts.reduce<number>((product, count) => product * count, 1) + 100;
      expect(new DataView(mapped.getMappedRange().unwrap()).getUint32(0, true)).toBe(expected);
      mapped.unmap();
    }
    expect(recorded).toEqual([
      [1, 1, 1],
      [1, 1, 1],
      [2, 1, 1],
      [2, 3, 1],
      [2, 3, 4],
    ]);
    expect(recordedIndirect).toBe(counts.length);
    expect(pipelines).toHaveBeenCalledTimes(2);
    expect(host.inspection?.().signatures[0]).toMatchObject({
      cacheHits: counts.length - 1,
      cacheMisses: 1,
    });
    // Falsify current-frame routing: omitting it replays the creation-time
    // nonzero count. A zero-work frame must not accept that extra increment.
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder }).unwrap();
    encoder.copyBufferToBuffer(source.buffer, 0, readback, 0, 4);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const mapped = (await readback.mapAsync(1)).unwrap();
    const stale = new DataView(mapped.getMappedRange().unwrap()).getUint32(0, true);
    mapped.unmap();
    expect(stale).toBe(expected + 101);
    expect(stale).not.toBe(expected + 100);
    expect((await raw.popErrorScope())?.message).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    (await graph.retire()).unwrap();
    owner.dispose().unwrap();
    host.dispose().unwrap();
    device.destroyBuffer(readback).unwrap();
    raw.destroy();
  }
});
