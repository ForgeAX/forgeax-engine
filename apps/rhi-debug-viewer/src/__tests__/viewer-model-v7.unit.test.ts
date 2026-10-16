import type { V7Tape } from '@forgeax/engine-rhi-debug';
import { describe, expect, it } from 'vitest';
import { buildViewerModel } from '../viewer-model';

function makeTape(): V7Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 3, blobCount: 0 },
    bootstrap: [
      {
        handleId: 'texture:1',
        kind: 'texture',
        create: {
          kind: 'createTexture',
          handleId: 'texture:1',
          desc: { size: [2, 2, 1], format: 'rgba8unorm', usage: 16 },
        },
        initialData: [],
      },
    ],
    events: [
      {
        kind: 'beginRenderPass',
        cmdHandleId: 'encoder:1',
        passHandleId: 'pass:1',
        desc: { colorAttachments: [] },
        colorAttachmentViewHandleIds: ['view:1'],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
      },
      { kind: 'endRenderPass', passHandleId: 'pass:1' },
    ],
    blobs: [],
  };
}

describe('v7 viewer model', () => {
  it('projects one decoded tape into one canonical work index', () => {
    const model = buildViewerModel(makeTape());

    expect(model.works[0]).toMatchObject({
      workIndex: 0,
      eventIndex: 1,
      passIndex: 0,
      kind: 'draw',
    });
    expect(model.events[1]?.kind).toBe('draw');
    expect(model.resources[0]?.resourceId).toBe('texture:1');
    expect(model.passes[0]?.workIndices).toEqual([0]);
  });

  it('keeps the model JSON-safe and does not expose tape blobs', () => {
    const model = buildViewerModel(makeTape());

    expect(model).not.toHaveProperty('blobs');
    expect(model).not.toHaveProperty('resourceTable');
    expect(JSON.stringify(model)).toContain('texture:1');
  });
});
