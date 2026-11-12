import { describe, expect, it } from 'vitest';
import { buildTapeIndex } from '../protocol/tape-index';
import type { Tape } from '../protocol/types';
import { planReplaySkip } from '../replay/timing-plan';

function pass(label: string, id: string): Tape['events'] {
  return [
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: id,
      desc: { label, colorAttachments: [] },
      colorAttachmentViewHandleIds: [],
    },
    {
      kind: 'draw',
      passHandleId: id,
      vertexCount: 3,
      instanceCount: 1,
      firstVertex: 0,
      firstInstance: 0,
    },
    { kind: 'endRenderPass', passHandleId: id },
  ];
}

const events: Tape['events'] = [
  { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1', desc: {} },
  ...pass('shadow.cascade0', 'pass:0'),
  { kind: 'writeBuffer', handleId: 'buf:1', bufferOffset: 0, dataHash: 'h', size: 4 },
  ...pass('shadow.cascade1', 'pass:1'),
  ...pass('main', 'pass:2'),
  { kind: 'finish', cmdHandleId: 'cmd:1' },
  { kind: 'submit', cmdHandleIds: ['cmd:1'] },
];
const tape: Tape = {
  header: { formatVersion: 7, rhiCaps: {}, eventCount: events.length, blobCount: 0 },
  bootstrap: [],
  events,
  blobs: [],
};
const index = buildTapeIndex(tape);

describe('planReplaySkip', () => {
  it('drops every event of passes matched by label, keeping queue writes', () => {
    const plan = planReplaySkip(tape, index, { passLabel: '^shadow' }).unwrap();
    expect(plan.passIndices).toEqual([0, 1]);
    expect([...plan.events].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 7]);
    expect(plan.events.has(4)).toBe(false);
  });

  it('combines pass indices and single works', () => {
    const plan = planReplaySkip(tape, index, { passIndices: [1], workIndices: [2, 1] }).unwrap();
    expect(plan.passIndices).toEqual([1]);
    expect(plan.workIndices).toEqual([2]);
    expect([...plan.events].sort((a, b) => a - b)).toEqual([5, 6, 7, 9]);
  });

  it('rejects out-of-range indices and invalid patterns', () => {
    const passError = planReplaySkip(tape, index, { passIndices: [7] });
    expect(passError.ok ? undefined : passError.error.code).toBe('replay-position-invalid');
    const workError = planReplaySkip(tape, index, { workIndices: [3] });
    expect(workError.ok ? undefined : workError.error.code).toBe('replay-position-invalid');
    const regexError = planReplaySkip(tape, index, { passLabel: '(' });
    expect(regexError.ok ? undefined : regexError.error.code).toBe('replay-capability-mismatch');
  });

  it('plans nothing for an empty request', () => {
    const plan = planReplaySkip(tape, index, {}).unwrap();
    expect(plan.events.size).toBe(0);
  });
});
