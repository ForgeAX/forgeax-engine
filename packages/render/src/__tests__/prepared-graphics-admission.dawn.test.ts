import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { RenderFeatureGraphicsPassDescriptor } from '../features/prepared-graphics';
import { validateRenderFeatureGraphicsPass } from '../features/prepared-graphics';
import {
  createPreparedGraphicsStore,
  type PreparedGraphicsTransaction,
} from '../features/prepared-graphics-store';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import {
  createPreparedGraphicsResolver,
  type PreparedGraphicsResolvedResource,
} from '../prepare/prepared-graphics-resolver';
import { nativeDeviceFixture } from './native-device-fixture';

const CODE = `
@group(0) @binding(0) var<uniform> color: vec4<f32>;
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2<f32>(-1,-1), vec2<f32>(3,-1), vec2<f32>(-1,3));
  return vec4<f32>(p[i], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return color; }
`;
const attachments = [{ resource: 'output', format: 'rgba8unorm' as const }];
function declare(tx: PreparedGraphicsTransaction, color: readonly number[], name = 'current') {
  const pipeline = tx
    .prepare('pipeline', `p:${name}`, {
      shader: 'admission-witness',
      vertexLayout: 'none',
      colorFormats: ['rgba8unorm'],
    })
    .unwrap();
  const bindings = tx.prepare('bindings', `b:${name}`, { pipeline, values: { color } }).unwrap();
  return { pipeline, bindings };
}
function descriptor(refs: ReturnType<typeof declare>): RenderFeatureGraphicsPassDescriptor {
  return {
    attachments: {
      colors: [{ resource: 'output', format: 'rgba8unorm', loadOp: 'clear', storeOp: 'store' }],
    },
    draws: [
      {
        kind: 'draw',
        vertexLayout: 'none',
        vertexData: [],
        pipeline: refs.pipeline,
        bindings: [refs.bindings],
        command: { vertexCount: 3, instanceCount: 1 },
      },
    ],
  };
}

// Managed transaction -> admission -> actual resolver -> raster projection -> GPU readback.
// This fullscreen witness checks prepared binding/lifecycle correctness, not PBR lighting or FPS.
it('matches legacy admission pixels through changing resources, held/retired frames and new logical transaction generations', async () => {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  try {
    const output = device
      .createTexture({
        size: { width: 1, height: 1 },
        format: 'rgba8unorm',
        usage: 16 | 1,
        textureBindingViewDimension: '2d',
      })
      .unwrap();
    const readback = device.createBuffer({ size: 256, usage: 1 | 8 }).unwrap();
    const layout = device
      .createBindGroupLayout({
        entries: [{ binding: 0, visibility: 2, buffer: { type: 'uniform', minBindingSize: 16 } }],
      })
      .unwrap();
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] }).unwrap();
    const shader = createShaderModuleImmediate(device, { code: CODE }).unwrap();
    const pipeline = device
      .createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shader, entryPoint: 'vs_main', buffers: [] },
        fragment: { module: shader, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      .unwrap();
    const store = createPreparedGraphicsStore();
    const releases: number[] = [];
    const render = async (
      tx: PreparedGraphicsTransaction,
      pass: RenderFeatureGraphicsPassDescriptor,
      optimized: boolean,
    ) => {
      const state = optimized
        ? tx.validateGraphicsPass(pass, true, attachments).unwrap()
        : tx.graphicsState(true, attachments);
      if (!optimized) validateRenderFeatureGraphicsPass(tx.featureIdentity, pass, state).unwrap();
      const resolver = createPreparedGraphicsResolver({
        device,
        featureIdentity: tx.featureIdentity,
        generation: tx.generation,
        capabilityAvailable: true,
        lookup: (reference) => tx.lookup(reference),
        resolvePipeline: () => ok(pipeline),
        resolveBindings: (input) => {
          const color = input.values.color;
          if (!Array.isArray(color) || color.length !== 4) throw new Error('Missing witness color');
          const buffer = device.createBuffer({ size: 16, usage: 64 | 8 }).unwrap();
          device.queue.writeBuffer(buffer, 0, new Float32Array(color)).unwrap();
          const handle = device
            .createBindGroup({
              layout,
              entries: [{ binding: 0, resource: { kind: 'buffer', value: { buffer } } }],
            })
            .unwrap();
          let released = false;
          return ok({
            handle,
            release: () => {
              if (!released) {
                released = true;
                releases.push(tx.generation);
                return device.destroyBuffer(buffer);
              }
              return ok(undefined);
            },
          });
        },
      });
      try {
        const refs = pass.draws.flatMap((draw) => [draw.pipeline, ...draw.bindings]);
        const resolved = new Map<object, PreparedGraphicsResolvedResource>(
          refs.map((ref) => [ref, resolver.resolve(ref).unwrap()]),
        );
        const graph = new RenderGraphBuilder<{ readonly encoder: RhiCommandEncoder }>();
        const texture = graph
          .importTexture(
            'output',
            { size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: 16 | 1 },
            () => output,
          )
          .unwrap();
        const view = graph.view(texture).unwrap();
        const projection = new RenderFeatureRasterGraphProjection(graph, () => ({ texture, view }));
        projection
          .addPass('witness', tx.featureIdentity, 0, pass, state, {
            generation: tx.generation,
            resolve: (ref) => resolved.get(ref),
          })
          .unwrap();
        const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
        try {
          const encoder = device.createCommandEncoder().unwrap();
          compiled.execute({ encoder }).unwrap();
          encoder.copyTextureToBuffer(
            { texture: output },
            { buffer: readback, bytesPerRow: 256, rowsPerImage: 1 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
          );
          device.queue.submit([encoder.finish().unwrap()]).unwrap();
          await device.queue.onSubmittedWorkDone();
          const mapped = (await readback.mapAsync(1)).unwrap();
          const pixels = Array.from(new Uint8Array(mapped.getMappedRange().unwrap().slice(0, 4)));
          mapped.unmap();
          return pixels;
        } finally {
          await compiled.retire();
        }
      } finally {
        resolver.release().unwrap();
      }
    };
    try {
      const first = store.beginFrame('gpu-admission', 1);
      for (let i = 0; i < 32; i++) declare(first, [1, 1, 1, 1], `unused:${i}`);
      first.graphicsState(true, attachments); // Warm projection must invalidate when the next declaration arrives.
      const original = declare(first, [1, 0, 0, 1]);
      const firstPass = descriptor(original);
      for (const optimized of [false, true])
        expect(await render(first, firstPass, optimized)).toEqual([255, 0, 0, 255]);
      first.commit().unwrap();
      const next = store.beginFrame('gpu-admission', 1);
      const replacement = declare(next, [0, 0, 1, 1]);
      expect(replacement.bindings).not.toBe(original.bindings);
      const bluePass = descriptor(replacement);
      for (const optimized of [false, true])
        expect(await render(next, bluePass, optimized)).toEqual([0, 0, 255, 255]);
      next.commit().unwrap();
      // An already held owner keeps its captured slot after later retirement.
      store.beginFrame('gpu-admission', 1).commit().unwrap();
      for (const optimized of [false, true])
        expect(await render(first, firstPass, optimized)).toEqual([255, 0, 0, 255]);
      store.invalidate('gpu-admission', 2);
      const recovered = store.beginFrame('gpu-admission', 2);
      const reinserted = declare(recovered, [0, 1, 0, 1]);
      expect(recovered.validateGraphicsPass(firstPass, true, attachments).ok).toBe(false);
      for (const optimized of [false, true])
        expect(await render(recovered, descriptor(reinserted), optimized)).toEqual([
          0, 255, 0, 255,
        ]);
      expect(releases).toHaveLength(8);
      expect(await native.popErrorScope()).toBeNull();
    } finally {
      device.destroyBuffer(readback).unwrap();
      device.destroyTexture(output).unwrap();
    }
  } finally {
    native.destroy();
  }
}, 30_000);
