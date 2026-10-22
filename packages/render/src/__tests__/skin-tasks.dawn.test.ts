import { createShaderModuleImmediate, rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { SkinTasks } from '../record/skin-tasks';
import { skinTaskFixture } from './skin-task-fixture';

it.each([
  false,
  true,
])('consumes the paired current/previous actual task buffers after same-record growth (storage=%s)', async (storage) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap(),
    f = skinTaskFixture(),
    tasks = new SkinTasks(device, storage);
  const output = device.createBuffer({ size: 32, usage: 132 }).unwrap(),
    readback = device.createBuffer({ size: 32, usage: 9 }).unwrap();
  try {
    await f.skin.submitFrame(f.frame, Promise.resolve(), true);
    f.matrix[12] = 5;
    f.skin.joint(0, 19, f.matrix);
    const frame = f.skin.prepareFrame(f.scene.slotsSnapshot());
    if (!frame) throw new Error('Missing current fixed root');
    tasks.begin(frame);
    const first = tasks.demand(f.first),
      second = tasks.demand(f.second);
    if (!first || !second) throw new Error('Missing actual Skin task data');
    const code =
      (storage
        ? `
@group(0) @binding(0) var<storage,read> data:array<vec4<u32>>;
@group(0) @binding(1) var<uniform> address:vec4<u32>;
fn sampleTask()->vec4<f32>{let descriptor=data[address.y+data[address.x].x];return vec4<f32>(bitcast<vec4<f32>>(data[descriptor.z+3u]).x,bitcast<vec4<f32>>(data[descriptor.z+descriptor.y*4u+3u]).x,f32(descriptor.y),f32(descriptor.w));}
`
        : `
struct Current { joints:array<mat4x4<f32>,255>,state:vec4<u32> }
@group(0) @binding(0) var<uniform> current:Current;
@group(0) @binding(1) var<uniform> previous:array<mat4x4<f32>,255>;
fn sampleTask()->vec4<f32>{return vec4<f32>(current.joints[0][3].x,previous[0][3].x,f32(current.state.x),f32(current.state.y));}
`) +
      `
@group(0) @binding(2) var<storage,read_write> result:array<vec4<f32>>;
@compute @workgroup_size(1) fn runA(){result[0]=sampleTask();}
@compute @workgroup_size(1) fn runB(){result[1]=sampleTask();}
`;
    const module = createShaderModuleImmediate(device, { code }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: 4,
            buffer: { type: storage ? 'read-only-storage' : 'uniform' },
          },
          { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
          { binding: 2, visibility: 4, buffer: { type: 'storage' } },
        ],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      encoder = device.createCommandEncoder().unwrap();
    for (const [index, row] of [first, second].entries()) {
      const pipeline = device
        .createComputePipeline({
          layout: pipelineLayout,
          compute: { module, entryPoint: index === 0 ? 'runA' : 'runB' },
        })
        .unwrap();
      const group = device
        .createBindGroup({
          layout,
          entries: [
            {
              binding: 0,
              resource: {
                kind: 'buffer',
                value: { buffer: row.data, offset: row.dataOffset, size: row.dataSize },
              },
            },
            {
              binding: 1,
              resource: {
                kind: 'buffer',
                value: {
                  buffer: row.auxiliary,
                  offset: row.auxiliaryOffset,
                  size: row.auxiliarySize,
                },
              },
            },
            {
              binding: 2,
              resource: { kind: 'buffer', value: { buffer: output, offset: 0, size: 32 } },
            },
          ],
        })
        .unwrap();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
    }
    encoder.copyBufferToBuffer(output, 0, readback, 0, 32);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    const completed = device.queue.onSubmittedWorkDone();
    tasks.trackSubmittedWork(completed);
    const released = f.skin.trackSubmittedWork(frame, completed);
    const cleanup = tasks.complete();
    await f.skin.submitFrame(frame, completed, true);
    await released;
    await cleanup;
    const mapped = (await readback.mapAsync(1)).unwrap();
    try {
      expect(Array.from(new Float32Array(mapped.getMappedRange().unwrap()))).toEqual([
        5, 3, 1, 3, 5, 3, 1, 3,
      ]);
    } finally {
      mapped.unmap();
    }
  } finally {
    await tasks.complete();
    await tasks.dispose();
    f.dispose();
    device.destroyBuffer(output).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
});
