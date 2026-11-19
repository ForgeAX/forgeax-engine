import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiCommandEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate } from '@forgeax/engine-rhi-webgpu';
import { expect, vi } from 'vitest';
import { skyboxScenePipelineSpec } from '../assembly/webgpu-ready-passes';
import { nativeDeviceFixture } from './native-device-fixture';

export async function verifyRasterBatchPixels(sampleCount: 1 | 4): Promise<void> {
  const { device, native } = await nativeDeviceFixture();
  native.pushErrorScope('validation');
  const module = createShaderModuleImmediate(device, {
    code: `
@vertex fn vertex(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  return vec4f(p[i], 0.75, 1);
}
@vertex fn translucent(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3));
  return vec4f(p[i], 0.5, 1);
}
@fragment fn sky() -> @location(0) vec4f { return vec4f(0,0,1,1); }
@fragment fn opaque() -> @location(0) vec4f { return vec4f(1,0,0,1); }
@fragment fn transparent() -> @location(0) vec4f { return vec4f(0,1,0,0.5); }
`,
  }).unwrap();
  const sky = skyboxScenePipelineSpec(sampleCount, 'depth32float', 'rgba8unorm');
  expect(sky.renderState).toMatchObject({ depthWriteEnabled: false, depthCompare: 'always' });
  if (
    sky.renderState?.depthCompare === undefined ||
    sky.renderState.depthWriteEnabled === undefined
  )
    throw new Error('scene sky must publish explicit depth state');
  const skyDepthCompare = sky.renderState.depthCompare;
  const skyDepthWrite = sky.renderState.depthWriteEnabled;
  const pipelines = ['sky', 'opaque', 'transparent'].map((entryPoint, i) =>
    device
      .createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: i === 2 ? 'translucent' : 'vertex', buffers: [] },
        fragment: {
          module,
          entryPoint,
          targets: [
            {
              format: 'rgba8unorm',
              ...(i === 2
                ? {
                    blend: {
                      color: {
                        operation: 'add' as const,
                        srcFactor: 'src-alpha' as const,
                        dstFactor: 'one-minus-src-alpha' as const,
                      },
                      alpha: {
                        operation: 'add' as const,
                        srcFactor: 'one' as const,
                        dstFactor: 'one-minus-src-alpha' as const,
                      },
                    },
                  }
                : {}),
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
        multisample: { count: sampleCount, mask: i === 1 ? 3 : 0xffffffff },
        depthStencil: {
          format: 'depth32float',
          depthCompare: i === 0 ? skyDepthCompare : 'greater',
          depthWriteEnabled: i === 0 ? skyDepthWrite : i === 1,
        },
      })
      .unwrap(),
  );
  const results: Uint8Array[] = [];
  for (const separated of [true, false]) {
    const graph = new RenderGraphBuilder<{ encoder: RhiCommandEncoder }>();
    const color = graph
      .createTexture('scene', { size: { width: 8, height: 8 }, format: 'rgba8unorm', sampleCount })
      .unwrap();
    const resolved = graph
      .createTexture('resolved', { size: { width: 8, height: 8 }, format: 'rgba8unorm' })
      .unwrap();
    const depth = graph
      .createTexture('depth', {
        size: { width: 8, height: 8 },
        format: 'depth32float',
        sampleCount,
      })
      .unwrap();
    const colorView = graph.view(color).unwrap(),
      resolvedView = graph.view(resolved).unwrap(),
      depthView = graph.view(depth).unwrap();
    const readback = device.createBuffer({ size: 256 * 8, usage: 9 }).unwrap();
    const buffer = graph
      .importBuffer('readback', { size: 256 * 8, usage: 9 }, () => readback)
      .unwrap();
    for (const [i, name] of ['sky', 'opaque', 'transparent'].entries())
      graph
        .addRasterPass(name, {
          accesses: [
            { resource: colorView, usage: 'color-attachment' },
            ...(sampleCount === 4
              ? [{ resource: resolvedView, usage: 'color-attachment' as const }]
              : []),
            { resource: depthView, usage: 'depth-stencil-write' },
          ],
          colorAttachments: [
            {
              view: colorView,
              ...(sampleCount === 4 ? { resolveTarget: resolvedView } : {}),
              loadOp: i === 0 ? 'clear' : 'load',
              storeOp: 'store',
              clearValue: [0, 0, 0, 0],
            },
          ],
          depthStencilAttachment: {
            view: depthView,
            depthClearValue: 0,
            depthLoadOp: i === 0 ? 'clear' : 'load',
            depthStoreOp: 'store',
          },
          encodeDirect(pass) {
            const pipeline = pipelines[i];
            if (pipeline === undefined) throw new Error('every scene stage requires its pipeline');
            pass.setPipeline(pipeline);
            pass.draw(3);
            // The following logical writer must start with a full viewport/scissor.
            pass.setViewport(0, 0, 1, 1, 0, 1);
            pass.setScissorRect(0, 0, 1, 1);
          },
        })
        .unwrap();
    graph
      .addCopyPass('read', {
        accesses: [
          { resource: sampleCount === 4 ? resolvedView : colorView, usage: 'copy-src' },
          { resource: buffer, usage: 'copy-dst' },
        ],
        encodeDirect(encoder, _frame, resources) {
          encoder.copyTextureToBuffer(
            { texture: resources.texture(sampleCount === 4 ? resolved : color).unwrap() },
            { buffer: readback, bytesPerRow: 256, rowsPerImage: 8 },
            { width: 8, height: 8, depthOrArrayLayers: 1 },
          );
        },
      })
      .unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 8, height: 8 } }).unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      const begin = vi.spyOn(encoder, 'beginRenderPass');
      const boundaries: string[] = [];
      // Materialize native boundaries without changing resolve placement,
      // shaders, attachments or the logical workload.
      const runner = separated
        ? Object.assign((_pass: unknown, encode: () => void) => encode(), {
            requiresPassBoundary: () => true,
          })
        : undefined;
      compiled
        .execute({ encoder }, runner, {
          begin(pass) {
            if (pass.kind === 'raster') boundaries.push(pass.name);
            return undefined;
          },
        })
        .unwrap();
      expect(begin).toHaveBeenCalledTimes(separated ? 3 : 1);
      expect(boundaries).toEqual(
        separated ? ['sky', 'opaque', 'transparent'] : ['sky + opaque + transparent'],
      );
      expect(
        begin.mock.calls.reduce(
          (count, [d]) =>
            count +
            Array.from(d.colorAttachments).filter((a) => a?.resolveTarget !== undefined).length,
          0,
        ),
      ).toBe(sampleCount === 4 ? 1 : 0);
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
      const mapped = (await readback.mapAsync(1)).unwrap();
      const pixels = new Uint8Array(mapped.getMappedRange().unwrap()).slice();
      mapped.unmap();
      results.push(pixels);
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const offset = y * 256 + x * 4;
          expect(Array.from(pixels.subarray(offset, offset + 4))).toEqual(
            sampleCount === 4 ? [128, 64, 64, 255] : [255, 0, 0, 255],
          );
        }
    } finally {
      (await compiled.retire()).unwrap();
      device.destroyBuffer(readback).unwrap();
    }
  }
  expect(results[1]).toEqual(results[0]);
  expect(await native.popErrorScope()).toBeNull();
}
