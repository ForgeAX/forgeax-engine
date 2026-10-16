import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type {
  Buffer,
  RhiCommandEncoder,
  RhiRenderPassEncoder,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { nativeDeviceFixture } from '../../__tests__/native-device-fixture';
import {
  type RenderBundleCounters,
  type SceneRenderBundleState,
  sceneRenderBundleCache,
} from '../render-bundle-cache';

const width = 16;
const height = 16;
const code = `
@group(0) @binding(0) var<uniform> tint: vec4<f32>;
@vertex fn vertex(@builtin(vertex_index) index: u32, @builtin(instance_index) instance: u32) -> @builtin(position) vec4<f32> {
  var positions = array<vec2<f32>, 3>(vec2<f32>(-0.3,-0.3), vec2<f32>(0.3,-0.3), vec2<f32>(0.0,0.3));
  let center = select(vec2<f32>(-0.5,0.0), select(vec2<f32>(0.5,0.0),vec2<f32>(0.0,0.5),instance == 2u), instance > 0u);
  return vec4<f32>(positions[index % 3u]+center,0.0,1.0);
}
@fragment fn fragment() -> @location(0) vec4<f32> { return tint; }`;

it.each([
  1, 4,
])('retains native output across graph replacement and resource retirement with %i changing batches', async (changingBatches) => {
  const state: SceneRenderBundleState = { frameNumber: 0 };
  const counters: RenderBundleCounters = { hits: 0, misses: 0 };
  let changedOutputs = 0;
  let bypassedFrames = 0;
  let previous: Uint8Array | undefined;
  // Keep the same scene cache owner across a device change; native identities must reset it.
  for (let generation = 0; generation < 2; generation++) {
    const { device, native } = await nativeDeviceFixture();
    native.pushErrorScope('validation');
    const buffers: Buffer[] = [];
    const retired = new Set<unknown>();
    try {
      const module = (await createShaderModule(device, { code })).unwrap();
      const layout = device
        .createBindGroupLayout({
          entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }],
        })
        .unwrap();
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
      const pipelines = new Map<TextureFormat, ReturnType<typeof device.createRenderPipeline>>();
      const pipeline = (format: TextureFormat) => {
        let value = pipelines.get(format);
        if (value === undefined) {
          value = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module, entryPoint: 'vertex', buffers: [] },
            fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
          });
          pipelines.set(format, value);
        }
        return value.unwrap();
      };
      const binding = (color: readonly number[]) => {
        const buffer = device.createBuffer({ size: 16, usage: 64 | 8 }).unwrap();
        buffers.push(buffer);
        device.queue.writeBuffer(buffer, 0, Float32Array.from(color)).unwrap();
        const group = device
          .createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { kind: 'buffer', value: { buffer, offset: 0, size: 16 } } },
            ],
          })
          .unwrap();
        return { buffer, group };
      };
      const stable = binding([0, 0, 1, 1]);
      let dynamic = binding([1, 0, 0, 1]);
      const readback = device.createBuffer({ size: 256 * height, usage: 1 | 8 }).unwrap();
      try {
        for (let frame = 0; frame < 60; frame++) {
          state.frameNumber++;
          const format: TextureFormat = frame < 30 ? 'rgba8unorm' : 'bgra8unorm';
          const replaced = frame === 18 ? dynamic : undefined;
          if (replaced !== undefined) dynamic = binding([0, 1, 0, 1]);
          // A changing upload through the same native handle must remain visible to reused bundles.
          device.queue
            .writeBuffer(dynamic.buffer, 0, Float32Array.of(frame % 2, (frame + 1) % 2, 0, 1))
            .unwrap();
          const record = (pass: RhiRenderPassEncoder) => {
            for (let batch = 0; batch < changingBatches; batch++) {
              pass.setPipeline(pipeline(format));
              pass.setBindGroup(0, dynamic.group);
              pass.draw(3, 1, 0, frame % 2 === 0 ? 1 : 2);
            }
            pass.setPipeline(pipeline(format));
            pass.setBindGroup(0, stable.group);
            pass.draw(3, 1, 0, 0);
          };
          const render = async (cached: boolean) => {
            const target = device
              .createTexture({ size: { width, height }, format, usage: 1 | 16 })
              .unwrap();
            const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
            const imported = graph
              .importTexture(
                'scene-color',
                { size: { width, height }, format, usage: 1 | 16 },
                () => target,
              )
              .unwrap();
            const view = graph.view(imported).unwrap();
            graph
              .addRasterPass('main', {
                colorAttachments: [
                  { view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
                ],
                accesses: [{ resource: view, usage: 'color-attachment' }],
                encode: ({ pass }) => {
                  if (cached)
                    sceneRenderBundleCache(state, 'main', { colorFormats: [format] }).encode(
                      device,
                      pass,
                      (encoded) => {
                        if (encoded === pass) bypassedFrames++;
                        record(encoded);
                      },
                      counters,
                    );
                  else record(pass);
                },
              })
              .unwrap();
            const compiled = graph.compile({ device, surfaceSize: { width, height } }).unwrap();
            try {
              const encoder = device.createCommandEncoder().unwrap();
              compiled.execute({ encoder }).unwrap();
              encoder.copyTextureToBuffer(
                { texture: target },
                { buffer: readback, bytesPerRow: 256, rowsPerImage: height },
                { width, height, depthOrArrayLayers: 1 },
              );
              device.queue.submit([encoder.finish().unwrap()]).unwrap();
              await device.queue.onSubmittedWorkDone();
              const mapped = (await readback.mapAsync(1)).unwrap();
              const data = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
              mapped.unmap();
              const pixels = new Uint8Array(width * height * 4);
              for (let y = 0; y < height; y++)
                pixels.set(data.subarray(y * 256, y * 256 + width * 4), y * width * 4);
              const validation = await native.popErrorScope();
              native.pushErrorScope('validation');
              expect(validation, validation?.message).toBeNull();
              return pixels;
            } finally {
              await compiled.retire();
              device.destroyTexture(target).unwrap();
            }
          };
          const direct = await render(false);
          const retained = await render(true);
          expect(retained).toEqual(direct);
          expect(retained.some((value, index) => index % 4 !== 3 && value > 200)).toBe(true);
          if (
            previous !== undefined &&
            retained.some((value, index) => value !== previous?.[index])
          )
            changedOutputs++;
          previous = retained;
          if (replaced !== undefined) {
            device.destroyBuffer(replaced.buffer).unwrap();
            retired.add(replaced.buffer);
          }
        }
      } finally {
        device.destroyBuffer(readback).unwrap();
      }
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      for (const buffer of buffers) if (!retired.has(buffer)) device.destroyBuffer(buffer).unwrap();
      native.destroy();
    }
  }
  expect(counters.hits).toBeGreaterThan(changingBatches === 1 ? 60 : 0);
  expect(counters.misses).toBeGreaterThan(0);
  expect(changedOutputs).toBeGreaterThan(30);
  if (changingBatches === 1) expect(bypassedFrames).toBe(0);
  else expect(bypassedFrames).toBeGreaterThan(0);
});
