import { describe, expect, it } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { summarizeFrame } from '../frame-summary';
import { passLine, summarizePasses, summarizeResources } from '../pass-summary';
import type { Tape } from '../protocol/types';

function makeTape(): Tape {
  return {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [
      {
        handleId: 'tex:hdr',
        kind: 'texture',
        create: {
          kind: 'createTexture',
          handleId: 'tex:hdr',
          desc: { label: 'scene-hdr', size: { width: 640, height: 360 }, format: 'rgba16float' },
        },
        initialData: [],
      },
      {
        handleId: 'view:hdr',
        kind: 'texture-view',
        create: {
          kind: 'createTextureView',
          handleId: 'view:hdr',
          sourceHandleId: 'tex:hdr',
          desc: {},
        },
        initialData: [],
      },
    ],
    events: [
      {
        kind: 'beginRenderPass',
        passHandleId: 'pass:1',
        cmdHandleId: 'encoder:1',
        desc: { label: 'forward', colorAttachments: [] },
        colorAttachmentViewHandleIds: ['view:hdr'],
      },
      {
        kind: 'draw',
        passHandleId: 'pass:1',
        vertexCount: 3,
        instanceCount: 1,
        firstVertex: 0,
        firstInstance: 0,
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
      { kind: 'finish', cmdHandleId: 'encoder:1' },
      { kind: 'submit', cmdHandleIds: ['encoder:1'] },
      { kind: 'frameMark', frameIdx: 0 },
    ],
    blobs: [],
  } as unknown as Tape;
}

describe('pass summary', () => {
  const model = buildFrameModel(makeTape());

  it('reports label, work counts and resolved target for each pass', () => {
    const passes = summarizePasses(model);
    expect(passes).toHaveLength(1);
    const pass = passes[0];
    expect(pass?.label).toBe('forward');
    expect(pass?.workCounts).toEqual({ draw: 2 });
    expect(pass?.colorTargets[0]).toMatchObject({
      viewId: 'view:hdr',
      textureId: 'tex:hdr',
      label: 'scene-hdr',
      width: 640,
      height: 360,
      format: 'rgba16float',
    });
    expect(passLine(pass as NonNullable<typeof pass>)).toContain('"forward"');
    expect(passLine(pass as NonNullable<typeof pass>)).toContain('scene-hdr 640x360');
  });

  it('is part of summarizeFrame and finds resources by label', () => {
    expect(summarizeFrame(model).passes).toHaveLength(1);
    const hits = summarizeResources(model, /scene-hdr/);
    expect(hits.length).toBeGreaterThan(0);
    expect(summarizeResources(model, /nothing-matches/)).toEqual([]);
  });
});
