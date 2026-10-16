import {
  type CompiledRenderGraph,
  RenderGraphBuilder,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-webgpu';

/** Real queue and pixel evidence for graph replacement, rollback and resize. */
export async function runTextureReuseGraph() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const readback = device.createBuffer({ size: 256, usage: 0x09 }).unwrap();
  const graphs: CompiledRenderGraph<RenderGraphFrame>[] = [];
  const pixels: number[][] = [];
  const compile = (
    color: number,
    width: number,
    previous?: CompiledRenderGraph<RenderGraphFrame>,
  ) => {
    const builder = new RenderGraphBuilder();
    const texture = builder
      .createTexture('shared-color', { size: 'surface', format: 'rgba8unorm' })
      .unwrap();
    const view = builder.view(texture).unwrap();
    const target = builder
      .importBuffer('readback', { size: 256, usage: 0x09 }, () => readback)
      .unwrap();
    builder
      .addRasterPass(`clear-${color}`, {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [
          {
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [color === 0 ? 1 : 0, color === 1 ? 1 : 0, color === 2 ? 1 : 0, 1],
          },
        ],
        encode() {},
      })
      .unwrap();
    builder
      .addCopyPass('readback', {
        accesses: [
          { resource: view, usage: 'copy-src' },
          { resource: target, usage: 'copy-dst' },
        ],
        encode: ({ encoder, resources }) =>
          encoder.copyTextureToBuffer(
            { texture: resources.texture(texture).unwrap() as unknown as GPUTexture },
            { buffer: readback as unknown as GPUBuffer, bytesPerRow: 256, rowsPerImage: 1 },
            { width: 1, height: 1, depthOrArrayLayers: 1 },
          ),
      })
      .unwrap();
    const graph = builder
      .compile({ device, surfaceSize: { width, height: 8 }, reuseResourcesFrom: previous })
      .unwrap();
    graphs.push(graph);
    return graph;
  };
  const draw = async (graph: CompiledRenderGraph<RenderGraphFrame>) => {
    const encoder = device.createCommandEncoder().unwrap();
    graph.execute({ encoder }).unwrap();
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
    const mapped = (await readback.mapAsync(1)).unwrap();
    pixels.push(Array.from(new Uint8Array(mapped.getMappedRange().unwrap()).slice(0, 4)));
    mapped.unmap();
  };
  try {
    const first = compile(0, 8);
    await draw(first);
    const second = compile(1, 8, first);
    await draw(second);
    const shared =
      first.inspect().resources[0]?.physicalAllocationKey ===
      second.inspect().resources[0]?.physicalAllocationKey;
    (await second.retire()).unwrap();
    await draw(first); // Candidate rollback still initializes the shared target.
    const resized = compile(2, 16, first);
    const distinct =
      resized.inspect().resources[0]?.physicalAllocationKey !==
      first.inspect().resources[0]?.physicalAllocationKey;
    (await first.retire()).unwrap();
    await draw(resized);
    return { pixels, shared, distinct };
  } finally {
    for (const graph of graphs) (await graph.retire()).unwrap();
    device.destroyBuffer(readback).unwrap();
  }
}
