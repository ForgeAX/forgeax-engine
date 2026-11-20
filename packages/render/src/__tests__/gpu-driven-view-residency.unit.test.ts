import { frustum, mat4 } from '@forgeax/engine-math';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, onTestFinished, vi } from 'vitest';
import { BatchTopology, type SubmissionPlan } from '../gpu-driven/batch-topology';
import { FilteredPlanContributionOwner } from '../gpu-driven/filtered-plan-contributions';
import { fixedTaskPlan } from '../gpu-driven/fixed-task-plan';
import { assemblePreparedPlan } from '../gpu-driven/production-raster-prepare';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import { createFilterPlanFixture } from './gpu-driven-filter-plan-fixture';
import { uploadFixture } from './gpu-driven-topology-upload-fixture';

async function fixture() {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: GPU_DRIVEN_VIEW_WGSL })).unwrap();
  const f = uploadFixture(device, shader);
  const source = createFilterPlanFixture({ sharedGeometry: true, instances: 2 });
  const prepared = source.prepare();
  const oldResident = new FilteredPlanContributionOwner().update(prepared).resident.plan;
  const owner = new FilteredPlanContributionOwner();
  const full = owner.update(prepared, source.bindings).resident.plan;
  const empty = owner.update(
    assemblePreparedPlan(prepared.residentSource, prepared.residentRows, {
      ...prepared.residentSource,
      batches: [],
      candidateCount: 0,
    }),
    source.bindings,
  ).active.plan;
  expect(full.batches).toHaveLength(2);
  expect(empty.batches).toHaveLength(0);
  const inputs = f.gpuScene.inputs;
  if (source.source.sourceGroups === undefined) throw new Error('Missing canonical source');
  inputs.adoptSources(source.source.sourceGroups);
  let fault = false;
  onTestFinished(() => {
    try {
      f.view.dispose();
    } catch (cause) {
      if (!fault) throw cause;
      expect(cause).toBeInstanceOf(AggregateError);
    } finally {
      f.gpuScene.dispose();
    }
  });
  const planes = frustum.fromViewProjection(frustum.create(), mat4.identity(mat4.create()));
  const update = (plan: SubmissionPlan) => {
    const reads = inputs.capture();
    try {
      const result = f.view.update(plan, f.gpuScene, reads, planes);
      if (result.ok) reads.seal().unwrap();
      return result;
    } finally {
      reads.release();
    }
  };
  return {
    ...f,
    device,
    shader,
    inputs,
    full,
    empty,
    oldResident,
    update,
    expectFault: () => (fault = true),
  };
}

it('holds actual filtered subset roots while active execution closes and reopens', async () => {
  const f = await fixture();
  const before = f.inputs.memberNodesWritten;
  const buffer = vi.spyOn(f.device, 'createBuffer');
  const binds = vi.spyOn(f.device, 'createBindGroup');
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  // Canonical source adoption did not already own these filtered subset nodes.
  expect(f.inputs.memberNodesWritten).toBeGreaterThan(before);
  expect(buffer).not.toHaveBeenCalled();
  expect(binds).not.toHaveBeenCalled();
  buffer.mockRestore();
  binds.mockRestore();
  const held = f.inputs.memberNodesWritten;
  for (let cycle = 0; cycle < 6; cycle++) {
    f.update(f.full).unwrap();
    f.update(f.empty).unwrap();
    f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
    expect(f.inputs.memberNodesWritten).toBe(held);
  }
});

it('keeps the empty resident publication and rejects raw or copied header qualification', async () => {
  const f = await fixture();
  const hold = vi.spyOn(f.inputs, 'holdMembers');
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  expect(hold).toHaveBeenCalledTimes(2);
  expect(f.view.prepareResidentMembers(Object.freeze({ ...f.full }), f.gpuScene).ok).toBe(false);
  expect(hold).toHaveBeenCalledTimes(2);
  const released = f.inputs.memberNodesReleased;
  f.view.prepareResidentMembers(f.empty, f.gpuScene).unwrap();
  expect(f.inputs.memberNodesReleased).toBeGreaterThan(released);
  f.view.prepareResidentMembers(f.empty, f.gpuScene).unwrap();
  expect(hold).toHaveBeenCalledTimes(2);
  const raw = fixedTaskPlan({
    ...f.full,
    batches: f.full.batches.map((batch) => ({ ...batch, candidates: [] })),
  });
  expect(f.view.prepareResidentMembers(raw, f.gpuScene).ok).toBe(false);
  expect(hold).toHaveBeenCalledTimes(2);
});

it('keys leases by the actual input incarnation and rejects a foreign device', async () => {
  const f = await fixture();
  const next = uploadFixture(f.device, f.shader);
  const foreignDevice = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const foreignShader = (
    await rhi.createShaderModule(foreignDevice, { code: 'synthetic' })
  ).unwrap();
  const foreign = uploadFixture(foreignDevice, foreignShader);
  try {
    f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
    const released = f.inputs.memberNodesReleased;
    const nextHold = vi.spyOn(next.gpuScene.inputs, 'holdMembers');
    f.view.prepareResidentMembers(f.full, next.gpuScene).unwrap();
    expect(nextHold).toHaveBeenCalledTimes(2);
    expect(f.inputs.memberNodesReleased).toBeGreaterThan(released);
    expect(f.view.prepareResidentMembers(f.full, foreign.gpuScene).ok).toBe(false);
    next.gpuScene.dispose();
    expect(f.view.prepareResidentMembers(f.full, next.gpuScene).ok).toBe(false);
    expect(nextHold).toHaveBeenCalledTimes(2);
  } finally {
    next.close();
    foreign.close();
  }
});

it('retains the previous publication when a later new acquisition fails', async () => {
  const f = await fixture();
  const acquire = f.inputs.holdMembers.bind(f.inputs);
  const released: number[] = [];
  let calls = 0;
  vi.spyOn(f.inputs, 'holdMembers').mockImplementation((root) => {
    const index = calls++;
    if (index === 2) throw capacityFailure();
    const release = acquire(root);
    released[index] = 0;
    return () => {
      released[index] = (released[index] ?? 0) + 1;
      release();
    };
  });
  f.view.prepareResidentMembers(f.oldResident, f.gpuScene).unwrap();
  expect(f.view.prepareResidentMembers(f.full, f.gpuScene).ok).toBe(false);
  expect(released.slice(0, 2)).toEqual([0, 1]);
  f.view.prepareResidentMembers(f.oldResident, f.gpuScene).unwrap();
  expect(calls).toBe(3);
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  expect(released[0]).toBe(1);
});

it('drains all old releases, poisons reuse and still retires View buffers after a release fault', async () => {
  const f = await fixture();
  f.update(f.original).unwrap();
  const acquire = f.inputs.holdMembers.bind(f.inputs);
  const releases = [0, 0];
  let calls = 0;
  vi.spyOn(f.inputs, 'holdMembers').mockImplementation((root) => {
    const index = calls++;
    const release = acquire(root);
    return () => {
      release();
      releases[index] = (releases[index] ?? 0) + 1;
      if (index === 0 && releases[index] === 1) throw new Error('retirement witness');
    };
  });
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  f.expectFault();
  expect(() => f.view.prepareResidentMembers(f.empty, f.gpuScene)).toThrow(AggregateError);
  expect(releases).toEqual([1, 1]);
  const write = vi.spyOn(f.device.queue, 'writeBuffer');
  expect(() => f.update(f.original)).toThrow(AggregateError);
  expect(write).not.toHaveBeenCalled();
  const destroy = vi.spyOn(f.device, 'destroyBuffer');
  expect(() => f.view.dispose()).toThrow(AggregateError);
  await f.device.queue.onSubmittedWorkDone();
  (await f.view.settleRetirement()).unwrap();
  expect(destroy).toHaveBeenCalled();
  expect(() => f.view.dispose()).toThrow(AggregateError);
});

it('attempts rollback and retains a cleanup fault through no-frame disposal', async () => {
  const f = await fixture();
  const acquire = f.inputs.holdMembers.bind(f.inputs);
  const releases: number[] = [];
  let calls = 0;
  vi.spyOn(f.inputs, 'holdMembers').mockImplementation((root) => {
    const index = calls++;
    if (index === 2) throw capacityFailure();
    const release = acquire(root);
    return () => {
      release();
      releases.push(index);
      if (index === 1) throw new Error('rollback witness');
    };
  });
  f.view.prepareResidentMembers(f.oldResident, f.gpuScene).unwrap();
  f.expectFault();
  expect(() => f.view.prepareResidentMembers(f.full, f.gpuScene)).toThrow(AggregateError);
  expect(releases).toEqual([1]);
  expect(() => f.view.dispose()).toThrow(AggregateError);
  expect(releases).toContain(0);
  expect(() => f.view.prepareResidentMembers(f.oldResident, f.gpuScene)).toThrow(AggregateError);
});

it('leaves resolved read-frame roots alive until their actual release', async () => {
  const f = await fixture();
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  const reads = f.inputs.capture();
  try {
    for (const batch of f.full.batches) reads.members(batch.candidates);
    reads.buffer().unwrap();
    reads.seal().unwrap();
    const released = f.inputs.memberNodesReleased;
    f.view.prepareResidentMembers(f.empty, f.gpuScene).unwrap();
    expect(f.inputs.memberNodesReleased).toBe(released);
    reads.release();
    expect(f.inputs.memberNodesReleased).toBeGreaterThan(released);
  } finally {
    reads.release();
  }
});

it('keeps a receipt that throws before releasing through repeated disposal attempts', async () => {
  const f = await fixture();
  const acquire = f.inputs.holdMembers.bind(f.inputs);
  let attempts = 0;
  let blocked = true;
  let index = 0;
  vi.spyOn(f.inputs, 'holdMembers').mockImplementation((root) => {
    const release = acquire(root);
    const first = index++ === 0;
    return () => {
      if (first) {
        attempts++;
        if (blocked) throw new Error('before-release witness');
      }
      release();
    };
  });
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  f.expectFault();
  expect(() => f.view.dispose()).toThrow(AggregateError);
  expect(attempts).toBe(1);
  expect(() => f.view.dispose()).toThrow(AggregateError);
  expect(attempts).toBe(2);
  const released = f.inputs.memberNodesReleased;
  blocked = false;
  expect(() => f.view.dispose()).toThrow(AggregateError);
  expect(attempts).toBe(3);
  expect(f.inputs.memberNodesReleased).toBeGreaterThan(released);
});

it('drains resident roots on disposal without an active update or a later frame', async () => {
  const f = await fixture();
  f.view.prepareResidentMembers(f.full, f.gpuScene).unwrap();
  const released = f.inputs.memberNodesReleased;
  f.view.dispose();
  expect(f.inputs.memberNodesReleased).toBeGreaterThan(released);
  expect(f.view.prepareResidentMembers(f.full, f.gpuScene).ok).toBe(false);
  expect(f.update(f.full).ok).toBe(false);
});

it('prepares real resident headers without native allocation and reuses them across active gates', async () => {
  const f = await fixture();
  const buffer = vi.spyOn(f.device, 'createBuffer');
  const binds = vi.spyOn(f.device, 'createBindGroup');
  f.view.prepareResidentHeaders(f.full, f.gpuScene).unwrap();
  expect(buffer).not.toHaveBeenCalled();
  expect(binds).not.toHaveBeenCalled();
  const headers = f.inputs.taskHeadersWritten;
  expect(headers).toBe(2);
  for (let cycle = 0; cycle < 4; cycle++) {
    f.update(f.full).unwrap();
    f.update(f.empty).unwrap();
    f.view.prepareResidentHeaders(f.full, f.gpuScene).unwrap();
    expect(f.inputs.taskHeadersWritten).toBe(headers);
    expect(f.inputs.taskHeadersReleased).toBe(0);
  }
  f.view.prepareResidentHeaders(f.empty, f.gpuScene).unwrap();
  expect(f.inputs.taskHeadersReleased).toBe(headers);
});

it('does not certify headers after temporary read retirement changes the source', async () => {
  const f = await fixture();
  const capture = f.inputs.capture.bind(f.inputs);
  let releases = 0;
  vi.spyOn(f.inputs, 'capture').mockImplementation(() => {
    const frame = capture();
    const release = frame.release;
    frame.release = () => {
      release();
      releases++;
      const source = new BatchTopology().sourcePlan().sourceGroups;
      if (source === undefined) throw Error('missing actual empty source');
      f.inputs.adoptSources(source);
    };
    return frame;
  });
  const result = f.view.prepareResidentHeaders(f.full, f.gpuScene);
  expect(result.ok).toBe(false);
  expect(releases).toBe(1);
});

it('does not resurrect a View disposed during temporary read retirement', async () => {
  const f = await fixture();
  const capture = f.inputs.capture.bind(f.inputs);
  vi.spyOn(f.inputs, 'capture').mockImplementation(() => {
    const frame = capture();
    const release = frame.release;
    frame.release = () => {
      release();
      f.view.dispose();
    };
    return frame;
  });
  const result = f.view.prepareResidentHeaders(f.full, f.gpuScene);
  expect(result.ok).toBe(false);
  expect(f.inputs.taskHeadersReleased).toBe(f.inputs.taskHeadersWritten);
});

it.each([
  false,
  true,
])('retains a temporary read retirement fault (after effect=%s)', async (after) => {
  const f = await fixture();
  const capture = f.inputs.capture.bind(f.inputs);
  let blocked = true;
  let attempts = 0;
  vi.spyOn(f.inputs, 'capture').mockImplementation(() => {
    const frame = capture();
    const release = frame.release;
    frame.release = () => {
      attempts++;
      if (after || !blocked) release();
      if (blocked) throw Error('temporary read release effect unknown');
    };
    return frame;
  });
  f.expectFault();
  expect(() => f.view.prepareResidentHeaders(f.full, f.gpuScene)).toThrow(AggregateError);
  expect(attempts).toBe(1);
  expect(() => f.view.prepareResidentHeaders(f.full, f.gpuScene)).toThrow(AggregateError);
  expect(attempts).toBe(1);
  blocked = false;
  expect(() => f.view.dispose()).toThrow(AggregateError);
  expect(attempts).toBe(2);
  expect(f.inputs.taskHeadersReleased).toBe(f.inputs.taskHeadersWritten);
});

function capacityFailure(): RhiError {
  return new RhiError({
    code: 'limit-exceeded',
    expected: 'injected finite native member capacity',
    hint: 'retain the previous accepted roots on a failed replacement',
  });
}
