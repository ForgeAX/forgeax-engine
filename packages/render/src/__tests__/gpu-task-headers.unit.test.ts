import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { MemberCandidates } from '../gpu-driven/batch-members';
import {
  BatchTopology,
  type GpuDrivenBatch,
  type SubmissionPlan,
} from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { GPU_TASK_HEADER_WORDS } from '../gpu-driven/task-header';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { encodedViewTopology } from '../gpu-driven/view-topology';
import { GpuInputArena } from '../gpu-input-arena';
import { GpuSceneInputs } from '../gpu-scene-inputs';
import { FrameListBase } from '../scene/frame-list';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const f = createFilterPlanFixture({ instances: 65 });
  const plan = new FilteredPlanContributionOwner().update(f.prepare()).resident.plan;
  const batch = plan.batches.at(0);
  if (batch === undefined || f.source.sourceGroups === undefined)
    throw Error('missing native header source');
  const inputs = new GpuSceneInputs(device, (slot) => slot + 10);
  inputs.adoptSources(f.source.sourceGroups);
  const demand = {
    plan,
    index: 0,
    batch,
    candidates: batch.candidates,
    materialAddress: 0,
    geometryAddress: 0,
  };
  return { ...f, plan, batch, inputs, device, demand };
}

it.each([
  'header',
  'members',
] as const)('retires held %s ranges after Inputs disposal while the shared arena remains live', async (kind) => {
  const f = await fixture();
  const arena = new GpuInputArena(65536);
  const survivor = arena.allocateDescriptor(4);
  arena.writeDescriptorWord(survivor, 4, 0, 29);
  const inputs = new GpuSceneInputs(f.device, (slot) => slot + 10, arena);
  if (f.source.sourceGroups === undefined || !MemberCandidates.is(f.batch.candidates))
    throw Error('missing actual owned source/member roots');
  inputs.adoptSources(f.source.sourceGroups);
  const read = inputs.capture();
  const header = read.header(f.demand);
  const release =
    kind === 'header' ? inputs.holdHeader(header, f.batch) : inputs.holdMembers(f.batch.candidates);
  read.seal().unwrap();
  read.release();
  try {
    inputs.dispose();
    expect(inputs.isLiveOn(f.device)).toBe(false);
    expect(arena.live).toBe(true);
    release();
    release();
    expect(inputs.taskHeadersReleased).toBe(inputs.taskHeadersWritten);
    expect(inputs.memberNodesReleased).toBe(inputs.memberNodesWritten);
    expect(arena.readWord(survivor)).toBe(29);
    const reclaimed = arena.allocateDescriptor(32);
    expect(reclaimed).toBe(survivor + 4);
    arena.releaseDescriptor(reclaimed, 32);
  } finally {
    release();
    read.release();
    inputs.dispose();
    f.inputs.dispose();
    arena.dispose();
  }
});

it('reuses a raw task moved to another active ordinal only after observing its complete value', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const batch = f.original.batches.at(0);
  if (batch === undefined) throw Error('missing actual source task');
  const firstRows = [
    { ...batch, batchId: 11, materialAddress: 1 },
    { ...batch, batchId: 22, materialAddress: 2 },
  ];
  const first = f.gpuScene.inputs.capture();
  const second = f.gpuScene.inputs.capture();
  const changed = f.gpuScene.inputs.capture();
  try {
    const prior = encodedViewTopology({ ...f.original, batches: firstRows }, f.gpuScene, first);
    const secondRow = firstRows[1];
    if (secondRow === undefined) throw Error('missing second observed task');
    const moved = { ...secondRow };
    const next = encodedViewTopology(
      { ...f.original, batches: [moved] },
      f.gpuScene,
      second,
      prior,
    );
    const before = prior.headers[1];
    const after = next.headers[0];
    if (before === undefined || after === undefined) throw Error('missing captured task headers');
    expect(after).not.toBe(before);
    expect(after.address).toBe(before.address);
    expect(f.gpuScene.inputs.taskHeadersWritten).toBe(2);
    expect(() => f.gpuScene.inputs.holdHeader(before, moved)).toThrow(RhiError);
    expect(second.reuseHeader(after, moved)).toBe(true);
    // Same lookup ID with changed observed columns must allocate, not inherit authority.
    const incompatible = encodedViewTopology(
      { ...f.original, batches: [{ ...moved, materialAddress: 99 }] },
      f.gpuScene,
      changed,
      next,
    );
    expect(incompatible.headers[0]?.address).not.toBe(after.address);
    expect(f.gpuScene.inputs.taskHeadersWritten).toBe(3);
    first.seal().unwrap();
    second.seal().unwrap();
    changed.seal().unwrap();
  } finally {
    first.release();
    second.release();
    changed.release();
    f.close();
  }
});

it('holds actual header/member nodes independently in resident and read domains', async () => {
  const f = await fixture();
  const frame = f.inputs.capture();
  const writes = vi.spyOn(f.device.queue, 'writeBuffer');
  const scan = vi.spyOn(MemberCandidates.prototype, Symbol.iterator).mockImplementation(() => {
    throw Error('header preparation must not expand instances');
  });
  let release = () => {};
  try {
    const header = frame.header(f.demand);
    release = f.inputs.holdHeader(header, f.batch);
    const buffer = frame.buffer().unwrap();
    frame.seal().unwrap();
    const upload = writes.mock.calls.find(([target]) => target === buffer.buffer)?.[2];
    if (!(upload instanceof Uint32Array)) throw Error('missing actual native input upload');
    expect(upload[header.address]).toBe(f.batch.visibleBase);
    expect(upload[header.address + 1]).toBe(65);
    expect(upload[header.address + 2]).toBe(f.batch.key.count);
    const member = upload[header.address + 12] as number;
    expect(upload[member + 3]).toBe(65);
    expect(f.inputs.taskHeadersWritten).toBe(1);
    frame.release();
    const empty = new BatchTopology().sourcePlan().sourceGroups;
    if (empty === undefined) throw Error('missing actual empty source');
    f.inputs.adoptSources(empty);
    expect(f.inputs.taskHeadersReleased).toBe(0);
    const next = f.inputs.capture();
    expect(next.header(f.demand)).toBe(header);
    expect(next.reuseHeader(header, f.batch)).toBe(true);
    release();
    expect(f.inputs.taskHeadersReleased).toBe(0);
    next.seal().unwrap();
    next.release();
    expect(f.inputs.taskHeadersReleased).toBe(1);
    expect(f.inputs.memberNodesReleased).toBe(f.inputs.memberNodesWritten);
    expect(scan).not.toHaveBeenCalled();
  } finally {
    scan.mockRestore();
    writes.mockRestore();
    release();
    frame.release();
    f.inputs.dispose();
  }
});

it('rejects copied, foreign, wrong-batch and retired header capabilities even after reuse', async () => {
  const f = await fixture();
  const other = new GpuSceneInputs(f.device, (slot) => slot);
  const frame = f.inputs.capture();
  const foreign = other.capture();
  try {
    const header = frame.header(f.demand);
    const batch = f.plan.batches.at(1);
    if (batch === undefined) throw Error('missing second batch');
    expect(() => f.inputs.holdHeader({ ...header }, f.batch)).toThrow(RhiError);
    expect(() => f.inputs.holdHeader(header, batch)).toThrow(RhiError);
    expect(() => other.holdHeader(header, f.batch)).toThrow(RhiError);
    expect(foreign.reuseHeader(header, f.batch)).toBe(false);
    frame.release();
    expect(() => f.inputs.holdHeader(header, f.batch)).toThrow(RhiError);
    const fresh = f.inputs.capture();
    const replacement = fresh.header(f.demand);
    expect(replacement).not.toBe(header);
    expect(fresh.reuseHeader(header, f.batch)).toBe(false);
    expect(fresh.reuseHeader(replacement, f.batch)).toBe(true);
    fresh.release();
  } finally {
    frame.release();
    foreign.release();
    other.dispose();
    f.inputs.dispose();
  }
});

it('refuses a real fixed batch paired with another real member root before encoding', async () => {
  const f = await fixture();
  const frame = f.inputs.capture();
  try {
    const other = f.plan.batches.at(1);
    if (other === undefined) throw Error('missing other native members');
    expect(() => frame.header({ ...f.demand, candidates: other.candidates })).toThrow(RhiError);
    expect(f.inputs.taskHeadersWritten).toBe(0);
  } finally {
    frame.release();
    f.inputs.dispose();
  }
});

it('recaptures raw static columns and preserves the previous held header', async () => {
  const f = await fixture();
  const key = { ...f.batch.key };
  const batch = { ...f.batch, key };
  const plan = { ...f.plan, batches: [batch] };
  const first = f.inputs.capture();
  const next = f.inputs.capture();
  try {
    const a = first.header({ ...f.demand, plan, batch });
    first.seal().unwrap();
    key.count++;
    const b = next.header({ ...f.demand, plan, batch, previous: a });
    expect(b).not.toBe(a);
    expect(f.inputs.arena.readWord(a.address + 2)).toBe(key.count - 1);
    expect(f.inputs.arena.readWord(b.address + 2)).toBe(key.count);
    expect(a.candidateCount).toBe(65);
    expect(b.candidateCount).toBe(65);
  } finally {
    next.release();
    first.release();
    f.inputs.dispose();
  }
});

it('value-reuses equal captured columns across row replacement without aliasing capability identity', async () => {
  const f = await fixture();
  const first = f.inputs.capture();
  const next = f.inputs.capture();
  try {
    const a = first.header(f.demand);
    const batch = Object.freeze({ ...f.batch });
    const raw = { ...f.plan, batches: [batch] };
    const b = next.header({ ...f.demand, plan: raw, batch, previous: a });
    expect(b).not.toBe(a);
    expect(b.address).toBe(a.address);
    expect(f.inputs.taskHeadersWritten).toBe(1);
    expect(() => f.inputs.holdHeader(a, batch)).toThrow(RhiError);
    const release = f.inputs.holdHeader(b, batch);
    release();
    next.release();
    expect(f.inputs.taskHeadersReleased).toBe(0);
    first.release();
    expect(f.inputs.taskHeadersReleased).toBe(1);
  } finally {
    next.release();
    first.release();
    f.inputs.dispose();
  }
});

it('uses the iterated raw task and one candidate getter observation for its prefix and member root', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'header-observation' })).unwrap();
  const f = uploadFixture(device, shader);
  const original = f.original.batches.at(0);
  if (original === undefined || !MemberCandidates.is(original.candidates))
    throw Error('missing canonical observations');
  const a = original.candidates;
  const member = a.membersFrame().at(0);
  if (member === undefined) throw Error('missing member');
  const b = a.with({ ...member, instanceCount: member.instanceCount + 1 });
  let reads = 0;
  const batch = {
    ...original,
    get candidates() {
      reads++;
      return reads === 1 ? a : b;
    },
  };
  const batches = new (class extends FrameListBase<GpuDrivenBatch> {
    readonly length = 2;
    at(): typeof batch {
      throw Error('raw iterator must not be replaced by at()');
    }
    *[Symbol.iterator]() {
      yield batch;
      yield original;
    }
  })();
  const plan: SubmissionPlan = { ...f.original, batches, candidateCount: a.length * 2 };
  const frame = f.gpuScene.inputs.capture();
  try {
    const encoded = encodedViewTopology(plan, f.gpuScene, frame);
    expect(reads).toBe(1);
    expect(encoded.rows[0]).toBe(batch);
    expect(encoded.headers[0]?.candidateCount).toBe(a.length);
    const control = new DataView(encoded.batchBytes.buffer);
    expect(control.getUint32(8, true)).toBe(a.length);
    const root = f.gpuScene.inputs.arena.readWord((encoded.headers[0]?.address ?? 0) + 12);
    expect(f.gpuScene.inputs.arena.readWord(root + 3)).toBe(a.length);
    frame.seal().unwrap();
  } finally {
    frame.release();
    f.close();
  }
});

it.each([
  false,
  true,
])('retains unknown header rollback responsibility (after effect=%s)', async (after) => {
  const f = await fixture();
  const frame = f.inputs.capture();
  const write = f.inputs.arena.writeDescriptor.bind(f.inputs.arena);
  vi.spyOn(f.inputs.arena, 'writeDescriptor').mockImplementation((...args) => {
    if (args[2] === GPU_TASK_HEADER_WORDS) throw Error('header write failed');
    write(...args);
  });
  const release = f.inputs.arena.releaseDescriptor.bind(f.inputs.arena);
  const retired = vi
    .spyOn(f.inputs.arena, 'releaseDescriptor')
    .mockImplementation((address, words) => {
      if (words !== GPU_TASK_HEADER_WORDS) return release(address, words);
      if (after) release(address, words);
      throw Error('header rollback effect unknown');
    });
  try {
    expect(() => frame.header(f.demand)).toThrow(AggregateError);
    expect(f.inputs.isLiveOn(f.device)).toBe(false);
    expect(Reflect.get(f.inputs, 'unconfirmed').length).toBeGreaterThan(0);
    expect(() => f.inputs.capture()).toThrow(AggregateError);
  } finally {
    retired.mockRestore();
    frame.release();
    expect(() => f.inputs.dispose()).toThrow(AggregateError);
    expect(() => f.inputs.dispose()).toThrow(AggregateError);
  }
});

it('keeps expected allocation refusal recoverable when its complete rollback succeeds', async () => {
  const f = await fixture();
  const frame = f.inputs.capture();
  const failure = new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'bounded header allocation',
    hint: 'retry with available storage',
  });
  const allocate = f.inputs.arena.allocateDescriptor.bind(f.inputs.arena);
  const fault = vi.spyOn(f.inputs.arena, 'allocateDescriptor').mockImplementation((words) => {
    if (words === GPU_TASK_HEADER_WORDS) throw failure;
    return allocate(words);
  });
  try {
    expect(() => frame.header(f.demand)).toThrow(failure);
    expect(f.inputs.isLiveOn(f.device)).toBe(true);
    fault.mockRestore();
    expect(frame.header(f.demand).candidateCount).toBe(65);
    frame.buffer().unwrap();
    frame.seal().unwrap();
  } finally {
    fault.mockRestore();
    frame.release();
    f.inputs.dispose();
  }
});
