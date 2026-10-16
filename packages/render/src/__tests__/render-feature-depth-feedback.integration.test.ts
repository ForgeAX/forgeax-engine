import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { BindGroup, RenderPipeline } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { RenderFeatureRasterGraphProjection } from '../features/render-graph-raster';
import { createRenderFeatureTarget } from '../features/targets';

it.each([
  [true, 1, 'before-pass'],
  [false, 1, 'read-only'],
  [true, 4, 'before-pass'],
  [true, 1, undefined],
  [true, 1, 'read-only'],
] as const)('requires declared depth semantics (writes=%s, samples=%s, version=%s)', async (writesDepth, sampleCount, sceneDepth) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const graph = new RenderGraphBuilder();
  const depth = graph
    .createTexture('depth', {
      format: 'depth32float-stencil8',
      size: { width: 3, height: 2 },
      sampleCount,
    })
    .unwrap();
  const depthView = graph.view(depth).unwrap();
  graph
    .addRasterPass('opaque', {
      accesses: [{ resource: depthView, usage: 'depth-stencil-write' }],
      colorAttachments: [],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'store' },
      encode: () => undefined,
    })
    .unwrap();
  const target = createRenderFeatureTarget({
    name: 'depth',
    kind: 'scene-depth',
    format: 'depth32float-stencil8',
    sampleCount,
  });
  const pipeline = { kind: 'pipeline', generation: 1 } as const;
  const bindings = { kind: 'bindings', generation: 1 } as const;
  const sampledTextures: object[] = [];
  const projection = new RenderFeatureRasterGraphProjection(
    graph,
    () => ({ texture: depth, view: depthView }),
    ({ resolveTarget, resources }) => {
      const sampled = resolveTarget(target);
      if (sampled === undefined) throw Error('missing depth');
      sampledTextures.push(resources.texture(sampled.texture).unwrap());
      return {} as BindGroup;
    },
  );
  const planned = projection.addPass(
    'particles',
    'depth-feedback',
    0,
    {
      attachments: {
        colors: [],
        depthStencil: {
          resource: target,
          format: target.format,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      },
      sampledTargets: [target],
      ...(sceneDepth === undefined ? {} : { sceneDepth }),
      draws: [
        {
          kind: 'draw',
          pipeline,
          bindings: [bindings],
          vertexData: [],
          vertexLayout: 'none',
          command: { vertexCount: 3, instanceCount: 1 },
        },
      ],
    },
    {
      capabilityAvailable: true,
      generation: 1,
      attachments: [{ resource: target, format: target.format }],
      pipeline,
      pipelines: [pipeline],
      bindings: [bindings],
      vertexData: [],
      indexData: [],
    },
    {
      generation: 1,
      resolve: (ref) =>
        ref === pipeline
          ? { kind: 'pipeline', reference: pipeline, handle: {} as RenderPipeline, writesDepth }
          : ref === bindings
            ? { kind: 'bindings', reference: bindings, handle: undefined }
            : undefined,
    },
  );
  if (writesDepth && sceneDepth !== 'before-pass') {
    expect(planned).toMatchObject({
      ok: false,
      error: { code: 'resource-descriptor-invalid', detail: { field: 'sceneDepth' } },
    });
    return;
  }
  if (sampleCount === 4) {
    expect(planned).toMatchObject({
      ok: false,
      error: { code: 'resource-descriptor-invalid', detail: { field: 'sampleCount', actual: '4' } },
    });
    return;
  }
  planned.unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 30, height: 20 } }).unwrap();
  try {
    const encoder = device.createCommandEncoder().unwrap();
    const copies = vi.spyOn(encoder, 'copyTextureToTexture');
    const passes = vi.spyOn(encoder, 'beginRenderPass');
    compiled.execute({ encoder }).unwrap();
    const attachment = passes.mock.calls.at(-1)?.[0].depthStencilAttachment;
    expect(attachment?.depthReadOnly === true).toBe(!writesDepth);
    expect(copies).toHaveBeenCalledTimes(writesDepth ? 1 : 0);
    if (writesDepth) {
      const copy = copies.mock.calls[0];
      if (copy === undefined) throw Error('missing depth snapshot copy');
      const [source, destination, size] = copy;
      expect(source.texture).not.toBe(destination.texture);
      expect(sampledTextures).toEqual([destination.texture]);
      expect(size).toEqual({ width: 3, height: 2, depthOrArrayLayers: 1 });
    }
  } finally {
    await compiled.retire();
  }
});
