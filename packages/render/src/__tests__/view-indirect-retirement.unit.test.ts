import { err, RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { assert, expect, it, vi } from 'vitest';
import type { SubmissionPlan } from '../gpu-driven/batch-topology';
import { clearExitedIndirectCommands } from '../gpu-driven/view-indirect-retirement';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';

it('clears only exited commands, every LOD in both physical phases, and retains rejection', async () => {
  const f = createFilterPlanFixture();
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const source = Array.from(f.source.batches),
    first = source[0],
    kept = source[1];
  assert(first && kept);
  const exited = { ...first, indirectOffset: 40, lod: { coverages: [1, 0.5, 0.2] } };
  const previous: SubmissionPlan = { ...f.source, batches: [exited, kept] };
  const next: SubmissionPlan = { ...f.source, batches: [kept] };
  const buffer = device.createBuffer({ size: 1024, usage: 0x188 }).unwrap();
  const writes = vi.spyOn(device.queue, 'writeBuffer');
  try {
    expect(clearExitedIndirectCommands(device, buffer, previous, next, 512).unwrap()).toBe(120);
    expect(writes.mock.calls.map(([, offset, , , size]) => [offset, size])).toEqual([
      [40, 60],
      [552, 60],
    ]);
    const firstWrite = writes.mock.calls[0];
    assert(firstWrite);
    expect(Array.from(new Uint8Array(firstWrite[2] as ArrayBufferLike))).toEqual(
      Array(160).fill(0),
    );
    writes.mockClear();
    expect(clearExitedIndirectCommands(device, buffer, next, next, 512).unwrap()).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    const failure = new RhiError({
      code: 'device-lost',
      expected: 'injected queue rejection',
      hint: 'recover',
    });
    writes.mockReturnValueOnce(err(failure));
    expect(clearExitedIndirectCommands(device, buffer, previous, next, 512)).toMatchObject({
      ok: false,
      error: failure,
    });
  } finally {
    writes.mockRestore();
    device.destroyBuffer(buffer).unwrap();
  }
});
