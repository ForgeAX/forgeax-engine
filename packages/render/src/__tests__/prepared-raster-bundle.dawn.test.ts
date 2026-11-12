import type { BindGroup, Buffer, RenderPipeline, TextureFormat } from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import {
  type PreparedRasterBindings,
  PreparedRasterBundleCache,
  type PreparedRasterCounters,
  PreparedRasterPassCache,
  recordPreparedRaster,
} from '../gpu-driven/prepared-raster-bundle';
import { nativeDeviceFixture } from './native-device-fixture';

const shader = `
@group(0) @binding(0) var<uniform> view: vec4<f32>;
@group(0) @binding(1) var<uniform> light: vec4<f32>;
@group(1) @binding(0) var<uniform> tint: vec4<f32>;
@group(2) @binding(0) var<uniform> mesh: vec4<f32>;
@group(3) @binding(0) var<storage,read> visible: array<u32>;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>,3>(vec2<f32>(-0.2,-0.3),vec2<f32>(0.2,-0.3),vec2<f32>(0.0,0.3));
  let center = select(-0.5,0.5,visible[0] == 1u);
  return vec4<f32>(p[index % 3u] + vec2<f32>(center,0.0) + view.xy + light.xy + mesh.xy,0.0,1.0);
}
@fragment fn fragment() -> @location(0) vec4<f32> { return tint; }
`;

it('matches direct native pixels for 60 frames across uploads, ranges, attachments and retirement', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const buffers: Buffer[] = [];
  const retired = new Set<Buffer>();
  const allocate = (size: number, usage: number) => {
    const buffer = device.createBuffer({ size, usage }).unwrap();
    buffers.push(buffer);
    return buffer;
  };
  try {
    const module = (await createShaderModule(device, { code: shader })).unwrap();
    const layouts = [2, 1, 1, 1].map((count, group) =>
      device
        .createBindGroupLayout({
          entries: Array.from({ length: count }, (_, binding) => ({
            binding,
            visibility: group === 1 ? 2 : 1,
            buffer:
              group === 3
                ? { type: 'read-only-storage' as const }
                : { type: 'uniform' as const, hasDynamicOffset: true, minBindingSize: 16 },
          })),
        })
        .unwrap(),
    );
    const layout = device.createPipelineLayout({ bindGroupLayouts: layouts }).unwrap();
    const uniform = allocate(256, 64 | 8);
    const tint = allocate(512, 64 | 8);
    const group = (index: number, entries: readonly Buffer[]): BindGroup =>
      device
        .createBindGroup({
          layout: required(layouts[index]),
          entries: entries.map((buffer, binding) => ({
            binding,
            resource: { kind: 'buffer' as const, value: { buffer, offset: 0, size: 16 } },
          })),
        })
        .unwrap();
    const view = group(0, [uniform, uniform]);
    let material = group(1, [tint]);
    const mesh = group(2, [uniform]);
    const visible = allocate(16, 128 | 8);
    let windows = [group(3, [visible])];
    let vertex = allocate(16, 32 | 8);
    const index = allocate(8, 16 | 8);
    device.queue.writeBuffer(index, 0, Uint16Array.of(0, 1, 2, 0)).unwrap();
    const indirect = allocate(40, 256 | 8);
    device.queue.writeBuffer(indirect, 0, Uint32Array.of(3, 1, 0, 0, 0, 3, 1, 0, 0, 0)).unwrap();
    const readback = allocate(256 * 16, 1 | 8);
    const pipelines = new Map<TextureFormat, RenderPipeline>();
    const cache = new PreparedRasterBundleCache();
    const passes = new PreparedRasterPassCache();
    const counters: PreparedRasterCounters = { hits: 0, builds: 0, commands: 0, evictions: 0 };
    let previousPixels: Uint8Array | undefined;
    let changedPixels = 0;
    for (let frame = 0; frame < 60; frame++) {
      const format: TextureFormat = frame < 30 ? 'rgba8unorm' : 'bgra8unorm';
      let pipeline = pipelines.get(format);
      if (pipeline === undefined) {
        pipeline = device
          .createRenderPipeline({
            layout,
            vertex: { module, entryPoint: 'vertex', buffers: [] },
            fragment: { module, entryPoint: 'fragment', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
          })
          .unwrap();
        pipelines.set(format, pipeline);
      }
      device.queue.writeBuffer(tint, 0, Float32Array.of(frame % 2, (frame + 1) % 2, 0, 1)).unwrap();
      device.queue.writeBuffer(tint, 256, Float32Array.of(0, 0, 1, 1)).unwrap();
      device.queue.writeBuffer(visible, 0, Uint32Array.of(frame % 2, 0, 0, 0)).unwrap();
      if (frame === 18) material = group(1, [tint]);
      if (frame === 24) {
        const old = vertex;
        vertex = allocate(16, 32 | 8);
        device.destroyBuffer(old).unwrap();
        retired.add(old);
      }
      if (frame === 36) windows = [group(3, [visible])];
      const bindings: PreparedRasterBindings = {
        pipeline,
        view,
        material,
        mesh,
        meshOffsets: [0],
        materialOffset: frame < 45 ? 0 : 256,
        vertex,
        index,
        indexFormat: 'uint16',
        indirect,
        indirectOffset: frame < 40 ? 0 : 20,
        indexed: true,
        windows,
      };
      const render = async (cached: boolean) => {
        const target = device
          .createTexture({ size: { width: 16, height: 16 }, format, usage: 1 | 16 })
          .unwrap();
        try {
          const encoder = device.createCommandEncoder().unwrap();
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              {
                view: device.createTextureView(target, {}).unwrap(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: [0, 0, 0, 1],
              },
            ],
          });
          if (cached) {
            const recording = cache.begin(
              passes.prepare('native', { colorFormats: [format] }),
              device,
              counters,
            );
            recording.push(bindings);
            pass.executeBundles([recording.finish()]);
          } else recordPreparedRaster(pass, bindings);
          pass.end();
          encoder.copyTextureToBuffer(
            { texture: target },
            { buffer: readback, bytesPerRow: 256 },
            { width: 16, height: 16 },
          );
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          await device.queue.onSubmittedWorkDone();
          const mapped = (await readback.mapAsync(1)).unwrap();
          const pixels = new Uint8Array(mapped.getMappedRange().unwrap().slice(0));
          mapped.unmap();
          expect(await native.popErrorScope()).toBeNull();
          native.pushErrorScope('validation');
          return pixels;
        } finally {
          device.destroyTexture(target).unwrap();
        }
      };
      const direct = await render(false);
      const cached = await render(true);
      expect(equalBytes(cached, direct)).toBe(true);
      expect(cached.some((value, index) => index % 4 !== 3 && value > 200)).toBe(true);
      if (
        previousPixels !== undefined &&
        cached.some((value, index) => value !== previousPixels?.[index])
      )
        changedPixels++;
      previousPixels = cached;
    }
    expect(changedPixels).toBeGreaterThan(45);
    expect(counters.hits).toBe(53);
    expect(counters.builds).toBe(7);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    for (const buffer of buffers) if (!retired.has(buffer)) device.destroyBuffer(buffer).unwrap();
    native.destroy();
  }
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing native fixture layout');
  return value;
}
