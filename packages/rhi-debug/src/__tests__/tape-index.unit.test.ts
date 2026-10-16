import { describe, expect, it } from 'vitest';
import { buildTapeIndex } from '../protocol/tape-index';
import type { Tape } from '../protocol/types';

const tape: Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: 5, blobCount: 0 },
  bootstrap: [],
  events: [
    {
      kind: 'beginRenderPass',
      passHandleId: 'pass:1',
      cmdHandleId: 'cmd:1',
      desc: { colorAttachments: [] },
      colorAttachmentViewHandleIds: [],
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
      kind: 'drawIndexedIndirect',
      passHandleId: 'pass:1',
      indirectBufferHandleId: 'buf:1',
      indirectOffset: 0,
    },
    { kind: 'endRenderPass', passHandleId: 'pass:1' },
    { kind: 'beginComputePass', passHandleId: 'pass:2', cmdHandleId: 'cmd:1', desc: {} },
    { kind: 'dispatchWorkgroups', passHandleId: 'pass:2', x: 1, y: 1, z: 1 },
  ],
  blobs: [],
};

describe('TapeIndex', () => {
  it('assigns one global workIndex and preserves event/pass positions', () => {
    const index = buildTapeIndex(tape);
    expect(index.works.map((work) => [work.workIndex, work.eventIndex, work.passIndex])).toEqual([
      [0, 1, 0],
      [1, 2, 0],
      [2, 5, 1],
    ]);
    expect(index.passes).toHaveLength(2);
    expect(index.eventKinds).toContain('dispatchWorkgroups');
    expect(index.passIndexByEvent[1]).toBe(0);
    expect(index.passIndexByEvent[5]).toBe(1);
  });

  it('does not invent work for an empty pass', () => {
    const index = buildTapeIndex({ ...tape, events: tape.events.slice(0, 1) });
    expect(index.works).toHaveLength(0);
    expect(index.passes[0]?.workIndices).toEqual([]);
  });
});
