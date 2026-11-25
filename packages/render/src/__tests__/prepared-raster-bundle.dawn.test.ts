import type {
  BindGroup,
  Buffer,
  RenderBundle,
  RenderPipeline,
  TextureFormat,
} from '@forgeax/engine-rhi';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it, vi } from 'vitest';
import { equalBytes } from '../../../../scripts/test/byte-equality.mjs';
import {
  type PreparedRasterBindings,
  PreparedRasterBundleCache,
  type PreparedRasterCounters,
  PreparedRasterPassCache,
  recordPreparedRaster,
  recordPreparedRasters,
} from '../gpu-driven/prepared-raster-bundle';
import { livePhysical, RetainedRasterEncodes } from '../gpu-driven/retained-raster-encode';
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
                : { type: 'uniform' as const, hasDynamicOffset: binding === 0, minBindingSize: 16 },
          })),
        })
        .unwrap(),
    );
    const layout = device.createPipelineLayout({ bindGroupLayouts: layouts }).unwrap();
    const uniform = allocate(768, 64 | 8);
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
        viewOffset: 0,
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
      const render = async (cached: boolean, observed = bindings, bundle?: RenderBundle) => {
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
          if (bundle !== undefined) {
            pass.executeBundles([bundle]);
          } else if (cached) {
            const recording = cache.begin(
              passes.prepare('native', { colorFormats: [format] }),
              device,
              counters,
            );
            recording.push(observed);
            pass.executeBundles([recording.finish()]);
          } else recordPreparedRaster(pass, observed);
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
      if (frame === 0) {
        // These two view windows place alternating draws on opposite sides of the image.
        device.queue.writeBuffer(uniform, 512, Float32Array.of(1, 0, 0, 0)).unwrap();
        const commands = device.createRenderBundleEncoder({ colorFormats: [format] }).unwrap();
        const bindingsObserved = vi.spyOn(commands, 'setBindGroup');
        const draws = vi.spyOn(commands, 'drawIndexedIndirect');
        const rows = Array.from({ length: 128 }, (_, index) => ({
          ...bindings,
          viewOffset: index % 2 === 0 ? 256 : 512,
          materialOffset: index % 2 === 0 ? 0 : 256,
        }));
        recordPreparedRasters(commands, rows);
        const calls = bindingsObserved.mock.calls.filter((call) => call[2] instanceof Uint32Array);
        const viewWords = calls.filter(([group]) => group === 0);
        const materialWords = calls.filter(([group]) => group === 1);
        expect(draws).toHaveBeenCalledTimes(128);
        expect(viewWords).toHaveLength(128);
        expect(materialWords).toHaveLength(64);
        expect(viewWords.every((call) => call[3] === 0 && call[4] === 1)).toBe(true);
        expect(materialWords.every((call) => call[3] === 0 && call[4] === 1)).toBe(true);
        expect(new Set(calls.map((call) => call[2])).size).toBe(1);
        const words = calls[0]?.[2];
        assert(words instanceof Uint32Array);
        expect(words.byteLength).toBe(4);
        const image = await render(false, bindings, commands.finish().unwrap());
        const pixel = (x: number) =>
          Array.from(image.subarray(8 * 256 + x * 4, 8 * 256 + x * 4 + 4));
        expect(pixel(4)).toEqual([0, 255, 0, 255]);
        expect(pixel(12)).toEqual([0, 0, 255, 255]);
      }
      const direct = await render(false);
      const cached = await render(true);
      expect(equalBytes(cached, direct)).toBe(true);
      expect(cached.some((value, index) => index % 4 !== 3 && value > 200)).toBe(true);
      if (frame === 2) {
        // Uniform offsets use the device-aligned windows on the real GPU.
        const meshUniform = allocate(768, 64 | 8);
        device.queue.writeBuffer(meshUniform, 512, Float32Array.of(1, 0, 0, 0)).unwrap();
        const sameGroup = group(2, [meshUniform]);
        const scratch = [256];
        const testPass = passes.prepare('mesh-offset-windows', { colorFormats: [format] });
        const separate = new PreparedRasterBundleCache();
        const counts = { hits: 0, builds: 0, commands: 0, evictions: 0 };
        const row = { ...bindings, mesh: sameGroup, meshOffsets: scratch };
        const record = (first: number, second: number) => {
          const writer = separate.begin(testPass, device, counts);
          scratch[0] = first;
          writer.push(row);
          scratch[0] = second;
          writer.push({ ...row, materialOffset: 256 });
          scratch[0] = 0;
          return writer.finish();
        };
        const first = record(256, 512);
        const reversed = record(512, 256);
        expect(reversed).not.toBe(first);
        const centers = (image: Uint8Array) =>
          [4, 12].map((x) => Array.from(image.subarray(8 * 256 + x * 4, 8 * 256 + x * 4 + 4)));
        const leftGreen = [
          [0, 255, 0, 255],
          [0, 0, 255, 255],
        ];
        expect(centers(await render(false, bindings, first))).toEqual(leftGreen);
        expect(centers(await render(false, bindings, reversed))).toEqual([...leftGreen].reverse());
        expect(centers(await render(false, bindings, first))).toEqual(leftGreen);
      }
      if (frame === 36) {
        const replacementCache = new PreparedRasterBundleCache();
        const replacementPass = passes.prepare('private-window-swap', { colorFormats: [format] });
        const replacementCounters: PreparedRasterCounters = {
          hits: 0,
          builds: 0,
          commands: 0,
          evictions: 0,
        };
        const previous = replacementCache.resolveOne(
          replacementPass,
          device,
          bindings,
          replacementCounters,
        );
        const nextVisible = allocate(16, 128 | 8);
        device.queue.writeBuffer(nextVisible, 0, Uint32Array.of(1, 0, 0, 0)).unwrap();
        const nextWindow = group(3, [nextVisible]);
        const nextBindings = { ...bindings, windows: [nextWindow] };
        const task = prepareWindows(
          replacementCache,
          (window) => (window === windows[0] ? nextWindow : undefined),
          () => true,
        ).unwrap();
        const replacement = task.replacement(previous);
        assert(replacement !== undefined);
        const retained = new RetainedRasterEncodes();
        const live = { meshBinding: { vertex: bindings.vertex, index: bindings.index } };
        const identities = [windows[0], visible];
        const materialOwner = () => ({ group: bindings.material, offset: bindings.materialOffset });
        const classOwner = () => ({ pipeline: bindings.pipeline, mesh: bindings.mesh });
        const runs = retained.begin(replacementPass, identities, materialOwner, classOwner);
        const block = runs.record([live], 0, 1, livePhysical);
        block.bundle = previous;
        block.draws = 1;
        retained.finish(replacementPass, identities, runs);
        const remaps = new Map<unknown, unknown>([
          [windows[0], nextWindow],
          [visible, nextVisible],
        ]);
        expect(
          retained.prepareInputs(
            remaps,
            () => undefined,
            () => task.isCurrent(),
          ).ok,
        ).toBe(false);
        const retainedTask = retained
          .prepareInputs(
            remaps,
            (value) => task.replacement(value),
            () => task.isCurrent(),
          )
          .unwrap();
        expect(
          replacementCache.resolveOne(replacementPass, device, bindings, replacementCounters),
        ).toBe(previous);
        const before = await render(false, bindings, previous);
        const reference = await render(false, nextBindings);
        expect(equalBytes(before, reference)).toBe(false);
        const creates = vi.spyOn(device, 'createRenderBundleEncoder');
        try {
          retainedTask.publish().unwrap();
          task.publish().unwrap();
          const accepted = replacementCache.resolveOne(
            replacementPass,
            device,
            nextBindings,
            replacementCounters,
          );
          expect(accepted).toBe(replacement);
          expect(creates).not.toHaveBeenCalled();
          expect(equalBytes(await render(false, nextBindings, accepted), reference)).toBe(true);
          expect(equalBytes(await render(false, bindings, previous), before)).toBe(true);
          const acceptedRun = retained
            .begin(replacementPass, [nextWindow, nextVisible], materialOwner, classOwner)
            .reuse([live], 0, 1, livePhysical);
          assert(acceptedRun?.bundle !== undefined);
          expect(acceptedRun.bundle).toBe(accepted);
          expect(equalBytes(await render(false, nextBindings, acceptedRun.bundle), reference)).toBe(
            true,
          );
          expect(block.bundle).toBe(previous);
          expect(equalBytes(await render(false, bindings, block.bundle), before)).toBe(true);
          expect(creates).not.toHaveBeenCalled();
        } finally {
          creates.mockRestore();
          retainedTask.release();
          retained.clear();
          task.release();
        }
      }
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

function prepareWindows(
  cache: PreparedRasterBundleCache,
  replace: (window: BindGroup) => BindGroup | undefined,
  current: () => boolean,
) {
  return cache.prepareBindings(
    (binding) => ({
      ...binding,
      windows: binding.windows.map((window) => replace(window) ?? window),
    }),
    current,
  );
}
