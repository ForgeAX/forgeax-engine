import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModule, requestAdapterFrom } from '@forgeax/engine-rhi-webgpu';
import { expect } from 'vitest';
import { particleRendererRenderState } from '../feature/particle-resources';
import { coalesceVfxRasterPasses } from '../feature/raster-passes';

// This isolates the real particle blend contract and ordered scene-attachment
// writes. The managed VFX/Host companion test proves which emitter order the
// producer supplies; this gate does not pretend to run a cooked VFX kernel.
export async function verifyParticleRasterCoalescing() {
  // Keep both handles at the public provider seam, within this package's
  // production test compilation boundary (no foreign test-fixture import).
  let native: GPUDevice | undefined;
  const adapter = (
    await requestAdapterFrom({
      async requestAdapter(options) {
        const provider = await navigator.gpu.requestAdapter(options);
        if (provider === null) return null;
        return {
          features: provider.features,
          limits: provider.limits,
          async requestDevice(descriptor) {
            const device = await provider.requestDevice(descriptor);
            native = device;
            return device;
          },
        };
      },
    })
  ).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  if (native === undefined) throw new Error('Particle provider did not create a native device');
  native.pushErrorScope('validation');
  const width = 8,
    height = 8;
  const shader = (
    await createShaderModule(device, {
      code: `
    @group(0) @binding(0) var<uniform> tint: vec4<f32>;
    @vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
      var points = array<vec2<f32>,3>(vec2<f32>(-1,-1),vec2<f32>(3,-1),vec2<f32>(-1,3));
      return vec4<f32>(points[i],0,1);
    }
    @fragment fn fragment() -> @location(0) vec4<f32> { return tint; }
  `,
    })
  ).unwrap();
  const layout = device
    .createBindGroupLayout({
      entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }],
    })
    .unwrap();
  const state = particleRendererRenderState('billboard', undefined, undefined);
  const pipeline = device
    .createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap(),
      vertex: { module: shader, entryPoint: 'vertex', buffers: [] },
      fragment: {
        module: shader,
        entryPoint: 'fragment',
        targets: [
          { format: 'rgba8unorm', ...(state?.blend === undefined ? {} : { blend: state.blend }) },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })
    .unwrap();
  const colors = [
    [0.5, 0, 0, 0.5],
    [0, 0, 0.5, 0.5],
  ];
  const buffers = colors.map((color) => {
    const buffer = device.createBuffer({ size: 16, usage: 64 | 8 }).unwrap();
    device.queue.writeBuffer(buffer, 0, Float32Array.from(color)).unwrap();
    return buffer;
  });
  const bindings = buffers.map((buffer) =>
    device
      .createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { kind: 'buffer', value: { buffer, offset: 0, size: 16 } } },
        ],
      })
      .unwrap(),
  );
  const readback = device.createBuffer({ size: 256 * height, usage: 1 | 8 }).unwrap();
  try {
    const render = async (order: readonly number[], coalesced: boolean) => {
      const target = device
        .createTexture({
          size: { width, height },
          format: 'rgba8unorm',
          usage: 1 | 16,
          textureBindingViewDimension: undefined,
        })
        .unwrap();
      const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
      const imported = graph
        .importTexture(
          'scene-color',
          {
            size: { width, height },
            format: 'rgba8unorm',
            usage: 1 | 16,
          },
          () => target,
        )
        .unwrap();
      const view = graph.view(imported).unwrap();
      const commands: number[] = [];
      graph
        .addRasterPass('clear', {
          colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
          accesses: [{ resource: view, usage: 'color-attachment' }],
          encode: () => {},
        })
        .unwrap();
      const declarations: Parameters<typeof coalesceVfxRasterPasses>[0] = order.map((color) => ({
        kind: 'raster',
        name: `emitter-${color}.raster`,
        colorAttachments: [{ target: 'scene-color', loadOp: 'load', storeOp: 'store' }],
        draws: [
          {
            program: 'tint',
            bindings: [String(color)],
            vertexData: [],
            draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
          },
        ],
      }));
      const raster = coalesced ? coalesceVfxRasterPasses(declarations, 'blended') : declarations;
      expect(raster).toHaveLength(coalesced ? 1 : order.length);
      for (const declaration of raster)
        graph
          .addRasterPass(declaration.name, {
            colorAttachments: [{ view, loadOp: 'load', storeOp: 'store' }],
            accesses: [{ resource: view, usage: 'color-attachment' }],
            encode: ({ pass }) => {
              for (const draw of declaration.draws) {
                const color = Number(draw.bindings[0]);
                commands.push(color);
                pass.setPipeline(pipeline);
                const binding = bindings[color];
                if (binding === undefined) throw new Error('Missing particle color binding');
                pass.setBindGroup(0, binding);
                pass.draw(3);
              }
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
        const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
        const pixels = Array.from({ length: height }, (_, y) =>
          Array.from(bytes.slice(y * 256, y * 256 + width * 4)),
        ).flat();
        mapped.unmap();
        expect(commands).toEqual(order);
        return pixels;
      } finally {
        await compiled.retire();
        device.destroyTexture(target).unwrap();
      }
    };
    const queued = await render([0, 1], true);
    const retainedFirst = await render([1, 0], true);
    expect(queued).toEqual(await render([0, 1], false));
    expect(retainedFirst).toEqual(await render([1, 0], false));
    for (const [actual, expected] of [
      [queued, [64, 0, 128, 191]],
      [retainedFirst, [128, 0, 64, 191]],
    ] as const)
      for (const [index, value] of actual.entries()) {
        const expectedValue = expected[index % 4];
        if (expectedValue === undefined) throw new Error('Missing expected particle color');
        expect(Math.abs(value - expectedValue)).toBeLessThanOrEqual(1);
      }
    expect(queued).not.toEqual(retainedFirst);
    expect(await native.popErrorScope()).toBeNull();
  } finally {
    device.destroyBuffer(readback).unwrap();
    for (const buffer of buffers) device.destroyBuffer(buffer).unwrap();
    native.destroy();
  }
}
