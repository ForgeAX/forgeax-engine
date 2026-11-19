import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import { projectReceiptColorObservations } from '../assembly/webgpu-renderer-observation';
import { createRendererObservationCaptureOwner } from '../assembly/webgpu-renderer-observation-owner';
import type { RenderFeaturePlanExecutionPass } from '../features/host';
import { projectRenderFeatureCopies } from '../features/render-graph-copy';
import { createRenderFeatureGraphBufferState } from '../features/render-graph-resources';
import { createRenderFeatureGraphTextureTarget } from '../features/targets';
import type { RenderPipelineFrame } from '../render-pipeline';
import { addObservationCapturePass } from '../typed-render-graph-primitives';

describe('RenderFeature physical copy accesses', () => {
  it.each([
    'linear-hdr',
    'final-display',
  ] as const)('projects an actual %s producer with its encoded graph identity', async (domain) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const builder = new RenderGraphBuilder<RenderPipelineFrame>();
    const texture = builder
      .createTexture('color', {
        format: 'rgba8unorm',
        size: { width: 2, height: 2, depthOrArrayLayers: 1 },
        usage: 0x11,
      })
      .unwrap();
    const view = builder.view(texture).unwrap();
    builder
      .addRasterPass('initialize', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encodeDirect: () => {},
      })
      .unwrap();
    addObservationCapturePass(
      builder,
      { texture, view, format: 'rgba8unorm', sampleCount: 1 },
      domain,
    ).unwrap();
    const graph = builder.compile({ device, surfaceSize: { width: 2, height: 2 } }).unwrap();
    const compositorBuilder = new RenderGraphBuilder();
    compositorBuilder.addCopyPass('compositor', { accesses: [], encodeDirect: () => {} }).unwrap();
    const compositor = compositorBuilder
      .compile({ device, surfaceSize: { width: 2, height: 2 } })
      .unwrap();
    const owner = createRendererObservationCaptureOwner((error) => {
      throw error;
    });
    const encoder = device.createCommandEncoder().unwrap();
    try {
      graph
        .execute({
          encoder,
          targetW: 2,
          targetH: 2,
          frameState: { frameNumber: 17, graphGeneration: -1, frameOutputs: {} },
          runtime: {
            device,
            deviceGeneration: 3,
            observationFrameId: 17,
            observationGraphGeneration: graph.inspect().generation,
            observationCaptureDomains: [domain],
            observationCaptureOwner: owner.observationCaptureOwner,
          },
        } as unknown as RenderPipelineFrame)
        .unwrap();
      owner.observationCaptureOwner.recordGraph(17, graph.inspect().generation);
      compositor.execute({ encoder }).unwrap();
      owner.observationCaptureOwner.recordGraph(17, compositor.inspect().generation);
      encoder.finish().unwrap();
      const frame = owner.observationCaptureOwner.consume(17);
      expect(frame.captures).toHaveLength(1);
      expect(frame.captures[0]?.graphGeneration).toBe(graph.inspect().generation);
      const result = projectReceiptColorObservations(
        {
          frameId: 17,
          deviceGeneration: 3,
          backendId: 'null',
          presentation: 'ready',
          graphGeneration: compositor.inspect().generation,
          completed: Promise.resolve({ ok: true, value: undefined }),
        },
        frame.captures.map((capture) => ({
          capture,
          bytes: new Uint8Array(capture.bytesPerRow * capture.height),
        })),
        [domain],
        'null',
        frame.graphGenerations,
      );
      expect(result.ok).toBe(true);
      expect(owner.disposeObservationCaptures(frame.captures)).toBeUndefined();
    } finally {
      await graph.retire();
      await compositor.retire();
    }
  });
  it.each([
    'shared',
    'view',
  ] as const)('captures a %s graph with its current execution identity', async (scope) => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const builder = new RenderGraphBuilder();
    const descriptor = {
      format: 'rgba32float' as const,
      size: { width: 2, height: 2, depthOrArrayLayers: 1 },
      usage: 0x11,
    };
    const texture = builder.createTexture('feature-output', descriptor).unwrap();
    const view = builder.view(texture).unwrap();
    builder
      .addRasterPass('initialize', {
        accesses: [{ resource: view, usage: 'color-attachment' }],
        colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store' }],
        encodeDirect: () => {},
      })
      .unwrap();
    const target = createRenderFeatureGraphTextureTarget({
      name: 'feature-output',
      kind: 'graph-texture',
      format: 'rgba32float',
      sampleCount: 1,
      allocationKey: 'feature-output',
      descriptor,
    });
    projectRenderFeatureCopies(
      builder,
      createRenderFeatureGraphBufferState(),
      {
        featureIdentity: 'copy-accesses',
        order: 0,
        name: 'capture',
        resolvedGpuCopies: [],
        textureReadbacks: [{ name: 'feature-output', target }],
      },
      undefined,
      'capture',
      () => ({ texture, view }),
    ).unwrap();
    const compiled = builder.compile({ device, surfaceSize: { width: 2, height: 2 } }).unwrap();
    const owner = createRendererObservationCaptureOwner((error) => {
      throw error;
    });
    try {
      const encoder = device.createCommandEncoder().unwrap();
      const frame = {
        encoder,
        runtime: {
          device,
          deviceGeneration: 3,
          observationFrameId: 17,
          observationGraphGeneration: compiled.inspect().generation,
          observationCaptureOwner: owner.observationCaptureOwner,
        },
        ...(scope === 'view' ? { frameState: { graphGeneration: -1 } } : {}),
      };
      const result = compiled.execute(frame);
      expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
      const { captures } = owner.observationCaptureOwner.consume(17);
      expect(captures).toHaveLength(1);
      expect(captures[0]).toMatchObject({
        frameNumber: 17,
        deviceGeneration: 3,
        graphGeneration: compiled.inspect().generation,
      });
      encoder.finish().unwrap();
      expect(owner.disposeObservationCaptures(captures)).toBeUndefined();
    } finally {
      await compiled.retire();
    }
  });

  it('declares each physical destination once while retaining ordered copy commands and offsets', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const source = device.createBuffer({ size: 64, usage: 0x0004 }).unwrap();
    const destination = device.createBuffer({ size: 1024, usage: 0x0008 }).unwrap();
    const builder = new RenderGraphBuilder();
    const state = createRenderFeatureGraphBufferState();
    const declared = vi.spyOn(builder, 'addCopyPass');
    const pass: RenderFeaturePlanExecutionPass = {
      featureIdentity: 'copy-accesses',
      order: 0,
      name: 'reset-players',
      resolvedGpuCopies: [
        {
          source: { buffer: source, size: 64, physicalUsage: 0x0004 },
          destination: { buffer: destination, size: 1024, physicalUsage: 0x0008 },
          sourceOffset: 0,
          destinationOffset: 256,
          size: 16,
        },
        {
          source: { buffer: source, size: 64, physicalUsage: 0x0004 },
          destination: { buffer: destination, size: 1024, physicalUsage: 0x0008 },
          sourceOffset: 32,
          destinationOffset: 512,
          size: 16,
        },
      ],
    };
    try {
      projectRenderFeatureCopies(builder, state, pass).unwrap();
      const accesses = declared.mock.calls[0]?.[1].accesses;
      expect(accesses).toEqual([
        { resource: state.handles.get(source), usage: 'copy-src' },
        { resource: state.handles.get(destination), usage: 'copy-dst' },
      ]);
      const compiled = builder.compile({ device, surfaceSize: { width: 1, height: 1 } }).unwrap();
      try {
        const encoder = device.createCommandEncoder().unwrap();
        const copies = vi.spyOn(encoder, 'copyBufferToBuffer');
        compiled.execute({ encoder }).unwrap();
        expect(copies.mock.calls).toEqual([
          [source, 0, destination, 256, 16],
          [source, 32, destination, 512, 16],
        ]);
        encoder.finish().unwrap();
      } finally {
        await compiled.retire();
      }
    } finally {
      declared.mockRestore();
      device.destroyBuffer(source).unwrap();
      device.destroyBuffer(destination).unwrap();
    }
  });

  it('keeps both usages for a physical source/destination alias so graph validation rejects it', async () => {
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shared = device.createBuffer({ size: 1024, usage: 0x0004 | 0x0008 }).unwrap();
    const builder = new RenderGraphBuilder();
    const state = createRenderFeatureGraphBufferState();
    const declared = vi.spyOn(builder, 'addCopyPass');
    try {
      projectRenderFeatureCopies(builder, state, {
        featureIdentity: 'copy-accesses',
        order: 0,
        name: 'alias',
        resolvedGpuCopies: [
          {
            source: { buffer: shared, size: 1024, physicalUsage: 0x0004 | 0x0008 },
            destination: { buffer: shared, size: 1024, physicalUsage: 0x0004 | 0x0008 },
            sourceOffset: 0,
            destinationOffset: 256,
            size: 16,
          },
        ],
      }).unwrap();
      const handle = state.handles.get(shared);
      expect(declared.mock.calls[0]?.[1].accesses).toEqual([
        { resource: handle, usage: 'copy-src' },
        { resource: handle, usage: 'copy-dst' },
      ]);
      expect(builder.compile({ device, surfaceSize: { width: 1, height: 1 } })).toMatchObject({
        ok: false,
        error: { code: 'access-conflict', detail: { accesses: ['copy-src', 'copy-dst'] } },
      });
    } finally {
      declared.mockRestore();
      device.destroyBuffer(shared).unwrap();
    }
  });
});
