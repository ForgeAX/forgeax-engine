import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { RenderFeaturePlanExecutionPass } from '../features/host';
import { projectRenderFeatureCopies } from '../features/render-graph-copy';
import { createRenderFeatureGraphBufferState } from '../features/render-graph-resources';

describe('RenderFeature physical copy accesses', () => {
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
