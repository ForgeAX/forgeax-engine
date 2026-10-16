import {
  type RasterGraphPass,
  RenderGraphBuilder,
  type RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { QuerySet } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';

it('resolves query-page changes after an idle compiled frame on the real backend', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const pages = [0, 1].map(() => device.createQuerySet({ type: 'occlusion', count: 1 }).unwrap());
  type Frame = RenderGraphFrame & { querySet: QuerySet | undefined };
  const graph = new RenderGraphBuilder<Frame>();
  const color = graph
    .createTexture('color', {
      format: 'rgba8unorm',
      size: { width: 2, height: 2 },
    })
    .unwrap();
  const view = graph.view(color).unwrap();
  const resolved: (QuerySet | undefined)[] = [];
  const descriptor: RasterGraphPass<Frame> = {
    accesses: [{ resource: view, usage: 'color-attachment' }],
    colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
    occlusionQuerySet: (frame) => {
      resolved.push(frame.querySet);
      return frame.querySet;
    },
    encode: ({ pass, frame }) => {
      if (frame.querySet !== undefined) {
        pass.beginOcclusionQuery(0).unwrap();
        pass.endOcclusionQuery().unwrap();
      }
    },
  };
  graph.addRasterPass('query-lifecycle', descriptor).unwrap();
  const compiled = graph.compile({ device, surfaceSize: { width: 2, height: 2 } }).unwrap();
  Object.assign(descriptor, {
    occlusionQuerySet: () => {
      throw new Error('caller replacement must not change the admitted callback');
    },
  });
  const sequence = [undefined, pages[0], undefined, pages[1], pages[0]];
  try {
    for (const querySet of sequence) {
      const encoder = device.createCommandEncoder().unwrap();
      compiled.execute({ encoder, querySet }).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      await device.queue.onSubmittedWorkDone();
    }
    expect(resolved).toEqual(sequence);
  } finally {
    (await compiled.retire()).unwrap();
    for (const page of pages) device.destroyQuerySet(page).unwrap();
  }
});
