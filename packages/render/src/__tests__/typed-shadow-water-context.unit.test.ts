import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { waterMaterialRecordContext } from '../record/main-pass';
import type { _InternalRenderPipelineContext } from '../record/render-context';
import { ShadowRasterLedger } from '../record/shadow-raster-ledger';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import { addTypedShadowPasses } from '../typed-shadow-passes';

function topology(spotCount: number, water = false): RenderPipelineTopology {
  return {
    pipelineId: 'forgeax::standard',
    config: undefined,
    surface: { width: 64, height: 64, storageFormat: 'rgba8unorm', viewFormat: 'rgba8unorm' },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'off', bloomIntensity: 1 },
    shadow: {
      directional: 'disabled',
      spotMapSize: 32,
      pointCount: 0,
      pointFaceSize: 16,
      spotCount,
    },
    lane: { compute: true, storageBuffer: true, multisample: false, maxColorAttachments: 8 },
    featureTopologySignature: 'typed-shadow-water-context',
    gpuDrivenTopologySignature: 'typed-shadow-water-context',
    opaque: { lane: 'forward', lateOcclusion: true },
    ...(water ? { water: true } : {}),
  };
}

describe('typed shadow Water context admission', () => {
  it.each([
    0, 1,
  ])('owns only requested non-Water spot targets without a material context (spotCount=%s)', async (spotCount) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const outputs = addTypedShadowPasses(graph, topology(spotCount)).unwrap();
    expect(outputs.spot !== undefined).toBe(spotCount > 0);
    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
    const ledger = new ShadowRasterLedger();
    let rasters = 0;
    try {
      for (let frame = 0; frame < 3; frame += 1) {
        const encoder = device.createCommandEncoder().unwrap();
        const begin = vi.spyOn(encoder, 'beginRenderPass');
        ledger.begin();
        compiled
          .execute({
            encoder,
            frameState: { spotShadowSnapshots: [], shadowRaster: ledger },
          } as unknown as RenderPipelineFrame)
          .unwrap();
        expect(begin.mock.calls.map(([descriptor]) => descriptor.label)).toEqual(
          spotCount === 0 ? [] : ['spot-shadow-0'],
        );
        rasters += begin.mock.calls.length;
        device.queue.submit([encoder.finish().unwrap()]).unwrap();
        compiled.commitExecution();
        ledger.commit();
      }
      expect(rasters).toBe(spotCount * 3);
    } finally {
      (await compiled.retire()).unwrap();
    }
  });

  it('requires the real material context for a Water topology', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    addTypedShadowPasses(graph, topology(1, true)).unwrap();
    const compiled = graph.compile({ device, surfaceSize: { width: 64, height: 64 } }).unwrap();
    const encoder = device.createCommandEncoder().unwrap();
    try {
      const result = compiled.execute({
        encoder,
        frameState: { spotShadowSnapshots: [], shadowRaster: new ShadowRasterLedger() },
      } as unknown as RenderPipelineFrame);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('Water admission accepted a missing material context');
      expect(result.error.detail).toMatchObject({
        cause: { message: "Cannot read properties of undefined (reading 'rendererFrameNumber')" },
      });
    } finally {
      compiled.discardExecution();
      (await compiled.retire()).unwrap();
    }
  });

  it('retains a real Water context with no selected WaterMesh draws', () => {
    const context = {
      runtime: { rendererFrameNumber: 1, deviceGeneration: 1 },
      camera: { entityKey: 1, position: [0, 0, 5] },
      validatedOrdered: [],
    } as unknown as _InternalRenderPipelineContext;
    expect(waterMaterialRecordContext(context, undefined)).toBe(context);
  });
});
